const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const { RunStore } = require('./run-store');
const { WorkspaceManager } = require('./workspace-manager');
const { CodexAdapter } = require('../engines/codex-adapter');
const { ClaudeAdapter } = require('../engines/claude-adapter');
const { GeminiAdapter } = require('../engines/gemini-adapter');

const PHASE_LIMITS = {
  queued: 0.04,
  planning: 0.18,
  coding: 0.82,
  testing: 0.92,
  summarizing: 0.97,
  done: 1,
};

class AgentOrchestrator extends EventEmitter {
  constructor(projectRoot) {
    super();
    this.projectRoot = projectRoot;
    this.workspaceManager = new WorkspaceManager(this.projectRoot);
    this.runStore = new RunStore(path.join(this.projectRoot, '.clawcraft', 'runs'));
    this.adapters = new Map([
      ['codex', new CodexAdapter()],
      ['claude', new ClaudeAdapter()],
      ['gemini', new GeminiAdapter()],
    ]);
    this.agents = new Map();
    this.activeRunId = null;
  }

  listAgents() {
    return [...this.agents.values()];
  }

  getEngineStatuses() {
    return [...this.adapters.values()].map((adapter) => adapter.describe());
  }

  getState() {
    return {
      agents: this.listAgents(),
      runs: this.runStore.listRuns(),
      engines: this.getEngineStatuses(),
      liveMode: true,
      parallelMode: 'single-live-run',
    };
  }

  createAgent(payload = {}) {
    const id = payload.id ?? `${Date.now()}`;
    const engine = payload.engine || 'codex';
    const adapter = this.adapters.get(engine);
    const agent = {
      id,
      name: payload.name || `Agent-${id}`,
      engine,
      model: payload.model || (engine === 'claude' ? 'default' : 'gpt-5'),
      role: payload.role || 'builder',
      status: 'idle',
      currentRunId: null,
      available: adapter ? adapter.isAvailable() : false,
    };
    this.agents.set(String(id), agent);
    this.emitEvent({ type: 'agent.created', agent });
    return agent;
  }

  async removeAgent(agentId) {
    const key = String(agentId);
    const agent = this.agents.get(key);
    if (!agent) return { ok: true };
    if (agent.currentRunId) {
      await this.cancelRun(agent.currentRunId);
    }
    this.agents.delete(key);
    this.emitEvent({ type: 'agent.removed', agentId: key });
    return { ok: true };
  }

  async startRun(payload) {
    const agentId = String(payload.agentId);
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const adapter = this.adapters.get(agent.engine);
    if (!adapter) throw new Error(`Unknown engine: ${agent.engine}`);
    if (!adapter.isAvailable()) {
      throw new Error(`${adapter.label} CLI is not available on this machine.`);
    }
    if (this.activeRunId) {
      throw new Error('1단계 구현에서는 live run을 한 번에 하나만 실행할 수 있습니다.');
    }

    const context = {
      ...this.workspaceManager.getWorkingContext(),
      sharedDir: this.workspaceManager.getSharedDir(),
    };
    const runId = `run_${Date.now()}_${agentId}`;
    const startedAt = new Date().toISOString();
    const artifactsDir = this.workspaceManager.createRunArtifacts(runId);
    const run = this.runStore.createRun({
      id: runId,
      agentId,
      agentName: agent.name,
      engine: agent.engine,
      model: agent.model,
      prompt: payload.prompt,
      taskTitle: payload.taskTitle || payload.prompt.slice(0, 80),
      status: 'queued',
      phase: 'queued',
      progress: 0,
      summary: '',
      startedAt,
      endedAt: null,
      artifactsDir,
      workspaceDir: context.workdir,
      workspaceStrategy: context.strategy,
    });

    const command = adapter.buildCommand(run, context);
    const proc = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (command.stdinText) {
      proc.stdin.write(command.stdinText);
    }
    proc.stdin.end();

    run.process = proc;
    run.status = 'running';
    run.phase = 'planning';
    run.progress = 0.08;
    agent.status = 'running';
    agent.currentRunId = run.id;
    this.activeRunId = run.id;
    this.emitEvent({
      type: 'run.started',
      run: this.serializeRun(run),
      agent: { ...agent },
      constraint: 'single-live-run',
    });
    this.emitEvent({
      type: 'run.phase',
      runId: run.id,
      agentId,
      phase: 'planning',
      progress: run.progress,
      label: '작업 준비 중',
    });

    run.progressTimer = setInterval(() => {
      const current = this.runStore.getRun(run.id);
      if (!current || current.status !== 'running') return;
      const phase = current.phase || 'coding';
      const ceiling = PHASE_LIMITS[phase] || 0.82;
      if (current.progress < ceiling) {
        current.progress = Math.min(ceiling, current.progress + 0.015);
        this.emitEvent({
          type: 'run.phase',
          runId: current.id,
          agentId: current.agentId,
          phase: current.phase,
          progress: current.progress,
          label: current.phaseLabel || `${current.engine} 작업 진행 중`,
        });
      }
    }, 1200);

    const onLine = (source, line) => {
      if (!line.trim()) return;
      this.runStore.appendTranscript(run.id, {
        source,
        text: line,
        at: new Date().toISOString(),
      });
      const events = adapter.parseLine(line);
      for (const event of events) {
        this.applyAdapterEvent(run.id, event);
      }
    };

    readline.createInterface({ input: proc.stdout }).on('line', (line) => onLine('stdout', line));
    readline.createInterface({ input: proc.stderr }).on('line', (line) => onLine('stderr', line));

    proc.on('error', (error) => {
      this.failRun(run.id, error.message || '프로세스 시작 실패');
    });

    proc.on('close', (code, signal) => {
      const current = this.runStore.getRun(run.id);
      if (!current || current.status === 'done' || current.status === 'failed' || current.status === 'cancelled') {
        return;
      }
      if (code === 0) {
        this.completeRun(run.id, current.summary || `${agent.name} 작업이 완료되었습니다.`);
      } else {
        this.failRun(run.id, `프로세스 종료(code=${code}, signal=${signal || 'none'})`);
      }
    });

    return this.serializeRun(run);
  }

  applyAdapterEvent(runId, event) {
    const run = this.runStore.getRun(runId);
    if (!run) return;
    if (event.type === 'status') {
      run.phase = event.phase || run.phase;
      run.phaseLabel = event.label || run.phaseLabel;
      run.progress = Math.max(run.progress, event.phase === 'planning' ? 0.1 : run.progress);
      this.emitEvent({
        type: 'run.phase',
        runId,
        agentId: run.agentId,
        phase: run.phase,
        progress: run.progress,
        label: run.phaseLabel,
      });
      return;
    }

    if (event.type === 'message') {
      run.phase = event.phase || 'coding';
      run.phaseLabel = event.phase === 'coding' ? '엔진 응답 수신 중' : run.phaseLabel;
      run.progress = Math.max(run.progress, run.phase === 'coding' ? 0.22 : run.progress);
      const prevSummary = run.summary ? `${run.summary}\n\n${event.text}` : event.text;
      this.runStore.setSummary(runId, prevSummary.trim().slice(-6000));
      this.emitEvent({
        type: 'run.output',
        runId,
        agentId: run.agentId,
        phase: run.phase,
        progress: run.progress,
        text: event.text,
      });
      this.emitEvent({
        type: 'run.phase',
        runId,
        agentId: run.agentId,
        phase: run.phase,
        progress: run.progress,
        label: run.phaseLabel || '코딩 중',
      });
      return;
    }

    if (event.type === 'result') {
      if (event.status === 'success') {
        this.completeRun(runId, event.summary || run.summary || '작업 완료');
      } else {
        this.failRun(runId, event.error || '작업 실패');
      }
    }
  }

  completeRun(runId, summary) {
    const run = this.runStore.getRun(runId);
    if (!run) return;
    clearInterval(run.progressTimer);
    run.progressTimer = undefined;
    run.status = 'done';
    run.phase = 'done';
    run.progress = 1;
    run.endedAt = new Date().toISOString();
    this.runStore.setSummary(runId, summary || run.summary || '작업 완료');
    this.runStore.setFilesChanged(runId, this.workspaceManager.collectChangedFiles(new Date(run.startedAt).getTime()));
    const agent = this.agents.get(String(run.agentId));
    if (agent) {
      agent.status = 'idle';
      agent.currentRunId = null;
    }
    this.activeRunId = null;
    this.emitEvent({
      type: 'run.completed',
      run: this.serializeRun(run),
      agent: agent ? { ...agent } : null,
    });
  }

  failRun(runId, errorText) {
    const run = this.runStore.getRun(runId);
    if (!run) return;
    clearInterval(run.progressTimer);
    run.progressTimer = undefined;
    run.status = 'failed';
    run.phase = 'failed';
    run.errorText = errorText;
    run.endedAt = new Date().toISOString();
    this.runStore.setSummary(runId, run.summary || '실패');
    const agent = this.agents.get(String(run.agentId));
    if (agent) {
      agent.status = 'idle';
      agent.currentRunId = null;
    }
    this.activeRunId = null;
    this.emitEvent({
      type: 'run.failed',
      run: this.serializeRun(run),
      agent: agent ? { ...agent } : null,
      errorText,
    });
  }

  async cancelRun(runId) {
    const run = this.runStore.getRun(runId);
    if (!run) return { ok: true };
    clearInterval(run.progressTimer);
    run.progressTimer = undefined;
    if (run.process && !run.process.killed) {
      run.process.kill('SIGTERM');
    }
    run.status = 'cancelled';
    run.phase = 'cancelled';
    run.endedAt = new Date().toISOString();
    const agent = this.agents.get(String(run.agentId));
    if (agent) {
      agent.status = 'idle';
      agent.currentRunId = null;
    }
    this.activeRunId = null;
    this.emitEvent({
      type: 'run.cancelled',
      run: this.serializeRun(run),
      agent: agent ? { ...agent } : null,
    });
    return { ok: true };
  }

  shutdown() {
    for (const run of this.runStore.listRuns()) {
      if (run.status === 'running') {
        this.cancelRun(run.id);
      }
    }
  }

  serializeRun(run) {
    return {
      ...run,
      process: undefined,
      progressTimer: undefined,
    };
  }

  emitEvent(event) {
    this.emit('event', { ...event, at: new Date().toISOString() });
  }
}

module.exports = { AgentOrchestrator };
