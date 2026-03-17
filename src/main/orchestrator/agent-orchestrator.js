const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const { RunStore } = require('./run-store');
const { WorkspaceManager } = require('./workspace-manager');
const { AgentRegistry } = require('./agent-registry');
const { MessageBus } = require('./message-bus');
const { PromptCompiler } = require('./prompt-compiler');
const { ConversationRouter } = require('./conversation-router');
const { TaskPlanner } = require('./task-planner');
const { LeaderLoop } = require('./leader-loop');
const { parseActions, hasActions, extractPlainText } = require('./action-parser');
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

function sanitizeSessionToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'session';
}

function buildSessionAgent(payload = {}) {
  const token = payload.threadId || payload.termSessionId || payload.sessionId || payload.id || 'session';
  const shortToken = String(token).slice(0, 8);
  const sessionId = payload.sessionId || payload.id || `codex-cli-${sanitizeSessionToken(token)}`;
  return {
    id: sessionId,
    name: payload.name || 'Codex CLI',
    engine: payload.engine || 'codex',
    model: payload.model || 'gpt-5.4',
    role: payload.role || 'assistant',
    locked: payload.locked !== false,
    sessionKind: payload.sessionKind || 'codex-cli',
    taskTitle: payload.taskTitle || `Talking with you in CLI ${shortToken}`,
  };
}

function buildPrimarySessionAgent(env = process.env) {
  const threadId = env.CODEX_THREAD_ID || '';
  const termSessionId = env.TERM_SESSION_ID || '';
  if (!threadId && !termSessionId) return null;
  return buildSessionAgent({
    threadId,
    termSessionId,
    name: 'Codex CLI',
    sessionKind: 'codex-cli',
  });
}

class AgentOrchestrator extends EventEmitter {
  constructor(projectRoot) {
    super();
    this.projectRoot = projectRoot;
    this.workspaceManager = new WorkspaceManager(this.projectRoot);
    this.runStore = new RunStore(path.join(this.projectRoot, '.clawcraft', 'runs'));
    this.registry = new AgentRegistry();
    this.messageBus = new MessageBus(path.join(this.projectRoot, '.clawcraft', 'shared'));
    this.promptCompiler = new PromptCompiler(this.registry, this.messageBus, path.join(this.projectRoot, '.clawcraft', 'shared'));
    this.adapters = new Map([
      ['codex', new CodexAdapter()],
      ['claude', new ClaudeAdapter()],
      ['gemini', new GeminiAdapter()],
    ]);
    // Legacy compat: this.agents delegates to registry
    this.agents = this.registry.agents;
    this.activeRuns = new Map();
    this.agentsFile = path.join(this.projectRoot, '.clawcraft', 'agents.json');
    this.router = new ConversationRouter(this.registry, this.messageBus, this);
    this.planner = new TaskPlanner(this.registry, this.messageBus);
    this.leaderLoop = null;
    // Forward message bus events to UI
    this.messageBus.on('message', (msg) => {
      this.emitEvent({ type: 'agent.message', message: msg });
    });
    // Restore agents from previous session, then clean orphans
    this._restoreAgents();
    this._pruneLegacySessionAgents();
    this._ensurePrimarySessionAgent();
    const knownIds = new Set(this.agents.keys());
    this.workspaceManager.cleanupOrphanWorktrees(knownIds);
  }

  _restoreAgents() {
    const fs = require('fs');
    if (!fs.existsSync(this.agentsFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.agentsFile, 'utf8'));
      for (const agent of data) {
        const adapter = this.adapters.get(agent.engine || 'codex');
        agent.available = adapter ? adapter.isAvailable() : false;
        agent.workspace = this.workspaceManager.getWorkingContext(String(agent.id));
        this.registry.register(agent);
      }
    } catch {}
  }

  _ensurePrimarySessionAgent() {
    // Disabled — no auto-created session agents
  }

  _pruneLegacySessionAgents() {
    if (!this.agents.has('codex-session')) return;
    this.agents.delete('codex-session');
    try {
      this.workspaceManager.removeWorktree('codex-session');
    } catch {}
    this._persistAgents();
  }

  _persistAgents() {
    const fs = require('fs');
    fs.writeFileSync(this.agentsFile, JSON.stringify(this.registry.toJSON(), null, 2));
  }

  listAgents() {
    return this.registry.list();
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

  // ═══════════════════════════════════════════════════════════════
  // COLLABORATION MODE — Leader decomposes → Builders execute → Leader reports
  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // LEADER LOOP — persistent leader that continuously plans + delegates
  // ═══════════════════════════════════════════════════════════════
  async startLeaderLoop(payload) {
    const { prompt, leaderId } = payload;
    if (this.leaderLoop && this.leaderLoop.running) throw new Error('Leader loop already running. Stop first.');

    // Find leader: specified or first agent
    const agents = this.listAgents().filter(a => !a.locked);
    let leader;
    if (leaderId) {
      leader = this.registry.get(leaderId);
    } else {
      leader = agents[0];
    }
    if (!leader) throw new Error('No available leader agent');
    if (agents.length < 2) throw new Error('Need at least 2 agents (1 leader + 1 builder)');

    // Mark leader role
    leader.role = 'leader';
    agents.filter(a => a.id !== leader.id).forEach(a => { if (a.role === 'leader') a.role = 'builder'; });

    this.leaderLoop = new LeaderLoop(this);
    this.leaderLoop.on('cycle', (e) => this.emitEvent({ type: 'leader.cycle', ...e }));
    this.leaderLoop.on('stopped', (e) => this.emitEvent({ type: 'leader.stopped', ...e }));

    // Run async — don't await (it runs in background)
    this.leaderLoop.start(String(leader.id), prompt).catch(() => {});
    this.emitEvent({ type: 'leader.started', leaderId: leader.id, leaderName: leader.displayName || leader.name, mission: prompt });
    return { leaderId: leader.id, leaderName: leader.displayName || leader.name, status: 'running' };
  }

  stopLeaderLoop() {
    if (this.leaderLoop) {
      this.leaderLoop.stop();
      return { status: 'stopping' };
    }
    return { status: 'not_running' };
  }

  async startCollaboration(payload) {
    const { prompt, taskTitle } = payload;
    const allAgents = this.listAgents().filter(a => !a.locked && a.status === 'idle');
    if (allAgents.length < 2) throw new Error('협업에는 최소 2개 에이전트가 필요합니다 (1 leader + 1 builder).');

    // First agent = leader, rest = builders
    const leader = allAgents[0];
    const builders = allAgents.slice(1);
    const builderNames = builders.map(b => b.displayName || b.name);

    // Create plan
    const plan = this.planner.createPlan(prompt, leader, builders);
    plan.status = 'planning';
    this.emitEvent({ type: 'collab.started', plan, leader: { ...leader }, builders: builders.map(b => ({ ...b })) });

    // Step 1: Leader decomposes
    this.messageBus.send({ from: 'system', fromName: 'System', to: 'all', channel: 'radio', kind: 'system', text: `Leader ${leader.displayName || leader.name} is decomposing the task...` });

    const planningPrompt = this.planner.buildPlanningPrompt(prompt, builderNames);
    const leaderRun = await this.startRun({ agentId: String(leader.id), prompt: planningPrompt, taskTitle: 'Planning: ' + (taskTitle || prompt.slice(0, 40)), mode: 'shared-brief' });

    // Wait for leader to finish planning
    await new Promise((resolve, reject) => {
      const handler = (event) => {
        const eid = event.run?.id || event.runId;
        if (eid !== leaderRun.id) return;
        if (event.type === 'run.completed') { this.removeListener('event', handler); resolve(event); }
        if (event.type === 'run.failed') { this.removeListener('event', handler); reject(new Error('Leader planning failed')); }
        if (event.type === 'run.cancelled') { this.removeListener('event', handler); reject(new Error('Leader planning cancelled')); }
      };
      this.on('event', handler);
    });

    // Parse leader's output into subtasks
    const leaderResult = this.runStore.getRun(leaderRun.id);
    const subtasks = this.planner.parseLeaderOutput(leaderResult?.summary || '', plan);
    plan.status = 'executing';
    this.emitEvent({ type: 'collab.planned', plan, subtasks });

    // Step 2: Start all builders in parallel
    const builderPromises = builders.map(async (builder, i) => {
      const subtask = subtasks[i];
      if (!subtask || !subtask.description) return;
      subtask.status = 'running';

      this.messageBus.send({ from: leader.id, fromName: leader.displayName || leader.name, to: String(builder.id), channel: 'radio', kind: 'delegate', text: `@${builder.displayName || builder.name} ${subtask.description}` });

      try {
        const builderRun = await this.startRun({ agentId: String(builder.id), prompt: subtask.description, taskTitle: subtask.description.slice(0, 50), mode: 'shared-brief' });

        // Wait for builder to finish
        await new Promise((resolve, reject) => {
          const handler = (event) => {
            const eid = event.run?.id || event.runId;
            if (eid !== builderRun.id) return;
            if (event.type === 'run.completed') { this.removeListener('event', handler); resolve(event); }
            if (event.type === 'run.failed') { this.removeListener('event', handler); reject(new Error(event.errorText || 'failed')); }
            if (event.type === 'run.cancelled') { this.removeListener('event', handler); reject(new Error('cancelled')); }
          };
          this.on('event', handler);
        });

        const builderResult = this.runStore.getRun(builderRun.id);
        this.planner.completeSubtask(plan, builder.id, builderResult?.summary || 'Done');
        this.messageBus.send({ from: builder.id, fromName: builder.displayName || builder.name, to: String(leader.id), channel: 'radio', kind: 'report', text: `Task complete: ${subtask.description.slice(0, 60)}` });

      } catch (err) {
        this.planner.markSubtaskFailed(plan, builder.id, err.message);
        this.messageBus.send({ from: builder.id, fromName: builder.displayName || builder.name, to: String(leader.id), channel: 'radio', kind: 'blocker', text: `Failed: ${err.message}` });
      }
    });

    // Wait for ALL builders (parallel)
    await Promise.allSettled(builderPromises);
    this.emitEvent({ type: 'collab.builders_done', plan });

    // Step 3: Leader reviews all builder results
    plan.status = 'reviewing';
    this.messageBus.send({ from: leader.id, fromName: leader.displayName || leader.name, to: 'all', channel: 'radio', kind: 'system', text: 'Reviewing all builder results...' });

    // Leader reviews each completed subtask
    const reviewPrompt = this._buildReviewPrompt(plan);
    try {
      const reviewRun = await this.startRun({ agentId: String(leader.id), prompt: reviewPrompt, taskTitle: 'Reviewing builder results', mode: 'shared-brief' });
      await new Promise((resolve) => {
        const handler = (event) => {
          const eid = event.run?.id || event.runId;
          if (eid !== reviewRun.id) return;
          if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
            this.removeListener('event', handler); resolve();
          }
        };
        this.on('event', handler);
      });
      // Mark subtasks as reviewed
      plan.subtasks.forEach(st => { if (st.status === 'done') st.reviewStatus = 'approved'; });
    } catch {}

    // Step 4: Leader summarizes
    plan.status = 'reporting';
    const reportPrompt = this.planner.buildReportPrompt(plan);
    try {
      const reportRun = await this.startRun({ agentId: String(leader.id), prompt: reportPrompt, taskTitle: 'Final report', mode: 'shared-brief' });
      await new Promise((resolve, reject) => {
        const handler = (event) => {
          const eid = event.run?.id || event.runId;
          if (eid !== reportRun.id) return;
          if (event.type === 'run.completed') { this.removeListener('event', handler); resolve(event); }
          if (event.type === 'run.failed') { this.removeListener('event', handler); resolve(event); }
          if (event.type === 'run.cancelled') { this.removeListener('event', handler); resolve(event); }
        };
        this.on('event', handler);
      });
    } catch {}

    plan.status = 'done';
    this.emitEvent({ type: 'collab.completed', plan });
    this.messageBus.send({ from: leader.id, fromName: leader.displayName || leader.name, to: 'all', channel: 'radio', kind: 'report', text: `All tasks completed. Final report delivered.` });

    return plan;
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
    const workspace = this.workspaceManager.getWorkingContext(String(id));
    const agent = this.registry.register({
      ...payload,
      id,
      engine,
      available: adapter ? adapter.isAvailable() : false,
      workspace,
    });
    this._persistAgents();
    this.emitEvent({ type: 'agent.created', agent });
    return agent;
  }

  registerSessionClient(client = {}) {
    // No auto-registration — agents created explicitly via UI or bridge
    return null;
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
    // Inject perception if available (set by caller or lookAround)
    if (payload._perceptionText) {
      this.promptCompiler.setPerception(payload._perceptionText);
    } else {
      this.promptCompiler.setPerception('');
    }
    // Auto-attach mentioned agent's recent work to prompt
    let enrichedPrompt = payload.prompt;
    const mentions = this.registry.extractMentions(payload.prompt);
    if (mentions.length > 0) {
      let mentionCtx = '\n\n## Referenced teammates\' recent work\n';
      for (const m of mentions) {
        const ctx = this.getAgentContextPack(m.agentId);
        if (ctx && ctx.length > 20) {
          mentionCtx += `### ${m.name}\n${ctx}\n`;
        }
      }
      enrichedPrompt = payload.prompt + mentionCtx;
    }

    const fullPrompt = this.promptCompiler.compile(agentId, enrichedPrompt, mode);

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
      // Parse ACTION blocks from output
      const actions = parseActions(event.text || '');
      if (actions.length > 0) {
        for (const action of actions) {
          this.handleAction(run, action);
        }
      }
      // Record plain text (non-action) to shared conversation log
      const plain = extractPlainText(event.text || '').replace(/```[\s\S]*?```/g, '').trim();
      if (plain.length > 10 && plain.length < 500) {
        this.messageBus.send({
          from: run.agentId,
          fromName: run.agentName,
          to: 'all',
          channel: 'radio',
          kind: 'chat',
          text: plain.slice(0, 300),
          relatedRunId: run.id,
        });
      }
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
    // Record completion to message bus
    this.messageBus.send({
      from: run.agentId,
      fromName: run.agentName,
      to: 'all',
      channel: 'radio',
      kind: 'report',
      text: `작업 완료: ${finalSummary.slice(0, 300)}`,
      relatedRunId: runId,
    });
    this.activeRuns.delete(String(run.agentId));
    this.emitEvent({
      type: 'run.completed',
      run: this.serializeRun(run),
      agent: agent ? { ...agent } : null,
    });
    // Process inbox — reply to pending messages
    this.router.processInbox(String(run.agentId)).catch(() => {});
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
  // Build context pack for a target agent (their recent work)
  // Handle structured ACTION blocks from LLM output
  _buildReviewPrompt(plan) {
    let p = `You are the LEADER reviewing your team's work.\n\n## Original request\n${plan.userPrompt}\n\n## Builder results\n`;
    plan.subtasks.forEach(st => {
      p += `### ${st.assigneeName} (${st.status})\n`;
      p += `Task: ${st.description}\n`;
      p += `Files: ${st.targetFiles?.join(', ') || 'unknown'}\n`;
      p += `Summary: ${st.summary || '(none)'}\n\n`;
    });
    p += `## Instructions\n- Check each builder's work for completeness\n- Note any issues\n- Use ACTION:review-result for each builder\n- End with ACTION:report\n`;
    return p;
  }

  handleAction(run, action) {
    const agent = this.registry.get(run.agentId);
    const fromName = agent?.displayName || agent?.name || run.agentName;

    switch (action.type) {
      case 'delegate': {
        const target = this.registry.resolveByMention(action.target || '');
        this.messageBus.send({
          from: run.agentId, fromName, to: target?.id || 'all',
          channel: 'radio', kind: 'delegate',
          text: `@${action.target} ${action.task || ''}`,
          relatedRunId: run.id,
        });
        this.emitEvent({ type: 'action.delegate', agentId: run.agentId, target: action.target, task: action.task });
        // Auto-start delegated task on target if idle
        if (target && action.task) {
          // Start run even if not idle (will fail gracefully if already running)
          this.startRun({ agentId: String(target.id), prompt: action.task, taskTitle: action.task.slice(0, 50), mode: 'shared-brief' }).catch(() => {});
        }
        break;
      }
      case 'report': {
        this.messageBus.send({
          from: run.agentId, fromName, to: 'all',
          channel: 'radio', kind: 'report',
          text: `[${action.status || 'done'}] ${action.summary || ''}`,
          relatedRunId: run.id,
        });
        this.emitEvent({ type: 'action.report', agentId: run.agentId, status: action.status, summary: action.summary });
        break;
      }
      case 'blocker': {
        this.messageBus.send({
          from: run.agentId, fromName, to: 'all',
          channel: 'radio', kind: 'blocker',
          text: `⚠ BLOCKED: ${action.issue || ''} — Need: ${action.need || ''}`,
          relatedRunId: run.id,
        });
        this.emitEvent({ type: 'action.blocker', agentId: run.agentId, issue: action.issue, need: action.need });
        break;
      }
      case 'request-review': {
        const reviewer = this.registry.resolveByMention(action.target || '');
        this.messageBus.send({
          from: run.agentId, fromName, to: reviewer?.id || 'all',
          channel: 'radio', kind: 'request-review',
          text: `Review requested: ${action.files || 'changes'} @${action.target || 'reviewer'}`,
          relatedRunId: run.id,
        });
        this.emitEvent({ type: 'action.request-review', agentId: run.agentId, target: action.target, files: action.files });
        // Auto-start review if reviewer is idle
        if (reviewer) {
          const diffCtx = this.getAgentContextPack(run.agentId);
          this.startRun({ agentId: String(reviewer.id), prompt: `Review these changes:\n${diffCtx}\n\nFiles: ${action.files || 'all'}`, taskTitle: `Review for ${fromName}`, mode: 'shared-brief' }).catch(() => {});
        }
        break;
      }
      case 'review-result': {
        this.messageBus.send({
          from: run.agentId, fromName, to: 'all',
          channel: 'radio', kind: 'review-result',
          text: `Review: ${action.verdict || 'done'} — ${action.notes || ''}`,
          relatedRunId: run.id,
        });
        this.emitEvent({ type: 'action.review-result', agentId: run.agentId, verdict: action.verdict, notes: action.notes });
        break;
      }
      case 'handoff': {
        const next = this.registry.resolveByMention(action.target || '');
        this.messageBus.send({
          from: run.agentId, fromName, to: next?.id || 'all',
          channel: 'radio', kind: 'handoff',
          text: `Handoff to @${action.target}: ${action.context || ''}`,
          relatedRunId: run.id,
        });
        this.emitEvent({ type: 'action.handoff', agentId: run.agentId, target: action.target, context: action.context });
        break;
      }
    }
  }

  // Save/load renderer positions for session persistence
  saveRendererState(stateArray) {
    const fs = require('fs');
    const filePath = path.join(this.projectRoot, '.clawcraft', 'renderer-state.json');
    fs.writeFileSync(filePath, JSON.stringify(stateArray, null, 2));
    // Also update registry with nicknames
    for (const s of stateArray) {
      if (s.nickname) this.registry.setNickname(String(s.id), s.nickname);
    }
    this._persistAgents();
  }

  loadRendererState() {
    const fs = require('fs');
    const filePath = path.join(this.projectRoot, '.clawcraft', 'renderer-state.json');
    if (!fs.existsSync(filePath)) return [];
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return []; }
  }

  setAgentNickname(agentId, nickname) {
    const agent = this.registry.setNickname(String(agentId), nickname);
    if (agent) {
      this._persistAgents();
      this.emitEvent({ type: 'agent.updated', agent: { ...agent } });
    }
    return agent;
  }

  getAgentContextPack(agentId) {
    const agent = this.registry.get(agentId);
    if (!agent) return '';
    const summary = this.runStore.getLatestSummaryForAgent(agentId);
    const transcript = this.runStore.getRecentTranscriptForAgent(agentId, 15);
    const diff = this.getAgentDiff(agentId);
    let pack = `## ${agent.displayName || agent.name}'s recent work\n`;
    if (summary) pack += `Summary: ${summary.slice(0, 400)}\n\n`;
    if (transcript) pack += `Recent log:\n${transcript.slice(0, 800)}\n\n`;
    if (diff.files?.length) pack += `Changed files: ${diff.files.slice(0, 10).join(', ')}\n\n`;
    return pack;
  }

  // Send a message through the conversation router (with auto-reply)
  async sendMessage(payload) {
    return this.router.route(payload);
  }

  // List recent messages for an agent
  listMessages(agentId, limit = 15) {
    return this.messageBus.getConversationFor(agentId, limit);
  }

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
