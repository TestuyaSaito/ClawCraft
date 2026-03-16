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
    this.activeRuns = new Map();
    this.agentsFile = path.join(this.projectRoot, '.clawcraft', 'agents.json');
    // Restore agents from previous session, then clean orphans
    this._restoreAgents();
    const knownIds = new Set(this.agents.keys());
    this.workspaceManager.cleanupOrphanWorktrees(knownIds);
  }

  _restoreAgents() {
    const fs = require('fs');
    if (!fs.existsSync(this.agentsFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.agentsFile, 'utf8'));
      for (const agent of data) {
        agent.status = 'idle';
        agent.currentRunId = null;
        this.agents.set(String(agent.id), agent);
      }
    } catch {}
  }

  _persistAgents() {
    const fs = require('fs');
    const data = [...this.agents.values()].map(a => ({
      id: a.id, name: a.name, engine: a.engine, model: a.model, role: a.role,
    }));
    fs.writeFileSync(this.agentsFile, JSON.stringify(data, null, 2));
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
      parallelMode: 'git-worktree',
      collaborationModes: ['solo', 'shared-brief', 'relay'],
    };
  }

  // 4단계: Relay mode — chain agents sequentially, each gets previous output
  async startRelay(payload) {
    const { agentIds, prompt, taskTitle } = payload;
    if (!agentIds || agentIds.length < 2) throw new Error('Relay에는 2개 이상의 에이전트가 필요합니다.');
    const results = [];
    let currentPrompt = prompt;
    for (const agentId of agentIds) {
      const agent = this.agents.get(String(agentId));
      if (!agent) { results.push({ agentId, status: 'skipped', error: 'agent not found' }); continue; }
      try {
        const run = await this.startRun({ agentId: String(agentId), prompt: currentPrompt, taskTitle });
        // Wait for run to complete
        await new Promise((resolve, reject) => {
          const handler = (event) => {
            const eid = event.run?.id || event.runId;
            if (eid !== run.id) return;
            if (event.type === 'run.completed') { this.removeListener('event', handler); resolve(event); }
            if (event.type === 'run.failed') { this.removeListener('event', handler); reject(new Error(event.errorText || 'failed')); }
            if (event.type === 'run.cancelled') { this.removeListener('event', handler); reject(new Error('cancelled')); }
          };
          this.on('event', handler);
        });
        const finishedRun = this.runStore.getRun(run.id);
        const summary = finishedRun?.summary || '';
        results.push({ agentId, status: 'done', summary });
        // Next agent gets previous agent's output as context
        currentPrompt = `## Previous Agent Output (${agent.name})\n${summary}\n\n---\n\n## Task\n${prompt}`;
      } catch (err) {
        results.push({ agentId, status: 'failed', error: err.message });
        break; // Stop relay chain on failure
      }
    }
    return results;
  }

  createAgent(payload = {}) {
    const id = payload.id ?? `${Date.now()}`;
    const engine = payload.engine || 'codex';
    const adapter = this.adapters.get(engine);

    // Create worktree for this agent
    const workspace = this.workspaceManager.createWorktree(String(id));

    const agent = {
      id,
      name: payload.name || `Agent-${id}`,
      engine,
      model: payload.model || (engine === 'claude' ? 'default' : 'gpt-5'),
      role: payload.role || 'builder',
      status: 'idle',
      currentRunId: null,
      available: adapter ? adapter.isAvailable() : false,
      workspace, // { workdir, strategy, branch }
    };
    this.agents.set(String(id), agent);
    this._persistAgents();
    this.emitEvent({ type: 'agent.created', agent });
    return agent;
  }

  async removeAgent(agentId) {
    const key = String(agentId);
    const agent = this.agents.get(key);
    if (!agent) return { ok: true };
    if (agent.currentRunId) {
      await this.cancelRun(agent.currentRunId, true); // wait for process exit
    }
    // Clean up worktree after process is confirmed dead
    this.workspaceManager.removeWorktree(key);
    this.agents.delete(key);
    this.activeRuns.delete(key);
    this._persistAgents();
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
    // 2-B: same agent cannot run two tasks simultaneously
    if (this.activeRuns.has(agentId)) {
      throw new Error(`${agent.name}은(는) 이미 작업 중입니다. 취소 후 다시 시작하세요.`);
    }

    // Get worktree-based context for this agent
    const context = {
      ...this.workspaceManager.getWorkingContext(agentId),
      sharedDir: this.workspaceManager.getSharedDir(),
    };
    // 3단계: prepend shared context to prompt (skip for solo mode)
    const mode = payload.mode || 'solo';
    const sharedCtx = mode !== 'solo' ? this.workspaceManager.buildSharedContext() : '';
    const fullPrompt = sharedCtx
      ? `${sharedCtx}---\n\n## Task\n${payload.prompt}`
      : payload.prompt;

    const runId = `run_${Date.now()}_${agentId}`;
    const startedAt = new Date().toISOString();
    const artifactsDir = this.workspaceManager.createRunArtifacts(runId);
    const run = this.runStore.createRun({
      id: runId,
      agentId,
      agentName: agent.name,
      engine: agent.engine,
      model: agent.model,
      prompt: fullPrompt,
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
      branch: context.branch || null,
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
    this.activeRuns.set(agentId, run.id);
    this.emitEvent({
      type: 'run.started',
      run: this.serializeRun(run),
      agent: { ...agent },
      constraint: 'parallel-worktree',
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
    const finalSummary = summary || run.summary || '작업 완료';
    this.runStore.setSummary(runId, finalSummary);
    this.runStore.setFilesChanged(runId, this.workspaceManager.collectChangedFiles(run.workspaceDir, new Date(run.startedAt).getTime()));
    const agent = this.agents.get(String(run.agentId));
    if (agent) {
      agent.status = 'idle';
      agent.currentRunId = null;
    }
    // 3단계: record completion to shared messages
    this.workspaceManager.appendMessage({
      type: 'run.completed',
      agentId: run.agentId,
      agentName: run.agentName,
      engine: run.engine,
      runId,
      summary: finalSummary.slice(0, 500),
      filesChanged: (run.filesChanged || []).slice(0, 20),
    });
    this.activeRuns.delete(String(run.agentId));
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
    this.activeRuns.delete(String(run.agentId));
    this.emitEvent({
      type: 'run.failed',
      run: this.serializeRun(run),
      agent: agent ? { ...agent } : null,
      errorText,
    });
  }

  async cancelRun(runId, waitForExit = false) {
    const run = this.runStore.getRun(runId);
    if (!run) return { ok: true };
    clearInterval(run.progressTimer);
    run.progressTimer = undefined;
    if (run.process && !run.process.killed) {
      run.process.kill('SIGTERM');
      // Wait for process to actually exit before proceeding
      if (waitForExit) {
        await new Promise(resolve => {
          const timeout = setTimeout(() => { try { run.process.kill('SIGKILL'); } catch {} resolve(); }, 3000);
          run.process.once('close', () => { clearTimeout(timeout); resolve(); });
        });
      }
    }
    run.status = 'cancelled';
    run.phase = 'cancelled';
    run.endedAt = new Date().toISOString();
    const agent = this.agents.get(String(run.agentId));
    if (agent) {
      agent.status = 'idle';
      agent.currentRunId = null;
    }
    this.activeRuns.delete(String(run.agentId));
    this.emitEvent({
      type: 'run.cancelled',
      run: this.serializeRun(run),
      agent: agent ? { ...agent } : null,
    });
    return { ok: true };
  }

  async shutdown() {
    const promises = [];
    for (const run of this.runStore.listRuns()) {
      if (run.status === 'running') {
        promises.push(this.cancelRun(run.id, true));
      }
    }
    await Promise.allSettled(promises);
  }

  serializeRun(run) {
    return {
      ...run,
      process: undefined,
      progressTimer: undefined,
    };
  }

  // 5단계: get git diff for an agent's worktree
  getAgentDiff(agentId) {
    const { execSync } = require('child_process');
    const agent = this.agents.get(String(agentId));
    if (!agent) return { diff: '', files: [] };
    const ctx = this.workspaceManager.getWorkingContext(String(agentId));
    if (ctx.strategy !== 'git-worktree') return { diff: '(in-place 모드 — diff 없음)', files: [] };
    try {
      // Tracked changes
      const diff = execSync('git diff HEAD', { cwd: ctx.workdir, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
      const tracked = execSync('git diff --name-only HEAD', { cwd: ctx.workdir, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      // Untracked (new) files
      const untracked = execSync('git ls-files --others --exclude-standard', { cwd: ctx.workdir, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      const files = [...tracked, ...untracked.map(f => `(new) ${f}`)];
      const untrackedSection = untracked.length ? `\n\n--- Untracked files ---\n${untracked.join('\n')}` : '';
      return { diff: (diff || '(변경 없음)') + untrackedSection, files };
    } catch (err) {
      return { diff: `(diff 실패: ${err.message})`, files: [] };
    }
  }

  emitEvent(event) {
    this.emit('event', { ...event, at: new Date().toISOString() });
  }
}

module.exports = { AgentOrchestrator };
