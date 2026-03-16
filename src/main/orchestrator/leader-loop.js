// ═══════════════════════════════════════════════════════════════
// LEADER LOOP — persistent leader that continuously plans + delegates
// ═══════════════════════════════════════════════════════════════

const { EventEmitter } = require('events');

const MAX_CYCLES = 20; // safety limit
const CYCLE_PAUSE_MS = 3000; // pause between cycles

class LeaderLoop extends EventEmitter {
  constructor(orchestrator) {
    super();
    this.orchestrator = orchestrator;
    this.running = false;
    this.cycleCount = 0;
    this.leaderId = null;
    this.mission = '';
    this.completedTasks = [];
    this.pendingTasks = [];
  }

  async start(leaderId, mission) {
    if (this.running) throw new Error('Leader loop already running');
    this.running = true;
    this.leaderId = leaderId;
    this.mission = mission;
    this.cycleCount = 0;
    this.completedTasks = [];
    this.pendingTasks = [];

    const leader = this.orchestrator.registry.get(leaderId);
    if (!leader) throw new Error('Leader not found');

    this.orchestrator.messageBus.send({
      from: leaderId, fromName: leader.displayName || leader.name,
      to: 'all', channel: 'radio', kind: 'system',
      text: `🎖 Leader ${leader.displayName || leader.name} starting continuous mission: ${mission.slice(0, 80)}`,
    });
    this.emit('started', { leaderId, mission });

    try {
      await this._loop();
    } catch (err) {
      this.orchestrator.messageBus.send({
        from: leaderId, fromName: leader.displayName || leader.name,
        to: 'all', channel: 'radio', kind: 'blocker',
        text: `Leader loop error: ${err.message}`,
      });
    }
    this.running = false;
    this.emit('stopped', { cycleCount: this.cycleCount });
  }

  stop() {
    this.running = false;
  }

  async _loop() {
    while (this.running && this.cycleCount < MAX_CYCLES) {
      this.cycleCount++;
      this.emit('cycle', { cycle: this.cycleCount });

      // Step 0: Standup meeting — gather all builders for status
      await this._standup();

      // Step 1: Leader thinks — what needs to be done next?
      const planResult = await this._leaderThink();
      if (!planResult || !this.running) break;

      // Step 2: Parse leader's decision
      const decision = this._parseDecision(planResult);
      if (decision.done) {
        await this._finalReport();
        break;
      }

      // Step 3: Execute delegations
      if (decision.delegations.length > 0) {
        await this._executeDelegations(decision.delegations);
      }

      // Step 4: Wait for all builders to finish
      await this._waitForBuilders();

      // Pause before next cycle
      await new Promise(r => setTimeout(r, CYCLE_PAUSE_MS));
    }

    if (this.cycleCount >= MAX_CYCLES) {
      await this._finalReport();
    }
  }

  async _leaderThink() {
    const leader = this.orchestrator.registry.get(this.leaderId);
    const builders = this.orchestrator.registry.list().filter(a => a.id !== this.leaderId && !a.locked && a.role !== 'leader');
    const builderNames = builders.map(b => b.nickname || b.displayName || b.name);
    const recentMessages = this.orchestrator.messageBus.getRecent({ limit: 10 });

    let prompt = `You are the LEADER SCV in continuous command mode. Cycle ${this.cycleCount}.\n\n`;
    prompt += `## Mission\n${this.mission}\n\n`;

    if (this.completedTasks.length > 0) {
      prompt += `## Completed so far\n`;
      this.completedTasks.forEach(t => { prompt += `- ${t.builder}: ${t.summary.slice(0, 100)}\n`; });
      prompt += '\n';
    }

    prompt += `## Available builders\n`;
    builders.forEach(b => {
      const nick = b.nickname || b.displayName || b.name;
      const specialty = { codex: 'coding specialist', claude: 'analysis/review specialist', gemini: 'research/search specialist' };
      prompt += `- **${nick}** (${b.engine}/${b.model}) — ${specialty[b.engine] || 'general'}, status: ${b.status}\n`;
    });
    prompt += `\nIMPORTANT: Use the exact nickname above when delegating with ACTION:delegate target="nickname"\n\n`;

    if (recentMessages.length > 0) {
      prompt += `## Recent radio\n`;
      recentMessages.forEach(m => { prompt += `- ${m.fromName}: ${m.text?.slice(0, 150)}\n`; });
      prompt += '\n';
    }

    prompt += `## Your options\n`;
    prompt += `1. Delegate tasks to builders: ACTION:delegate target="name" task="what to do"\n`;
    prompt += `2. If mission is COMPLETE, output: ACTION:report status="done" summary="final summary"\n`;
    prompt += `3. If you need information, describe what to search and delegate to a builder with a research task\n\n`;
    prompt += `## Rules\n`;
    prompt += `- Think about what's been done and what remains\n`;
    prompt += `- Delegate specific, actionable tasks\n`;
    prompt += `- Each builder should get a different task\n`;
    prompt += `- If everything is done, report done\n`;
    prompt += `- Be concise\n`;

    try {
      // Wait for leader to finish
      const run = await this.orchestrator.startRun({
        agentId: String(this.leaderId),
        prompt,
        taskTitle: `Cycle ${this.cycleCount}: Planning`,
        mode: 'shared-brief',
      });
      await this._waitForRun(run.id);
      const result = this.orchestrator.runStore.getRun(run.id);
      return result?.summary || '';
    } catch (err) {
      return null;
    }
  }

  _parseDecision(text) {
    const { parseActions } = require('./action-parser');
    const actions = parseActions(text);
    const delegations = actions.filter(a => a.type === 'delegate');
    const reports = actions.filter(a => a.type === 'report');
    const done = reports.some(r => r.status === 'done' || r.status === 'complete');
    return { delegations, reports, done };
  }

  async _executeDelegations(delegations) {
    const promises = delegations.map(async (d) => {
      const target = this.orchestrator.registry.resolveByMention(d.target || '');
      if (!target) return;
      if (target.status === 'running') return; // busy

      this.orchestrator.messageBus.send({
        from: this.leaderId,
        fromName: this.orchestrator.registry.get(this.leaderId)?.name || 'Leader',
        to: String(target.id), channel: 'radio', kind: 'delegate',
        text: `@${d.target} ${d.task}`,
      });

      try {
        const run = await this.orchestrator.startRun({
          agentId: String(target.id),
          prompt: d.task,
          taskTitle: d.task.slice(0, 50),
          mode: 'shared-brief',
        });
        this.pendingTasks.push({ builderId: target.id, builderName: target.displayName || target.name, runId: run.id, task: d.task });
      } catch {}
    });
    await Promise.allSettled(promises);
  }

  async _waitForBuilders() {
    const waiting = [...this.pendingTasks];
    this.pendingTasks = [];

    const promises = waiting.map(async (pt) => {
      try {
        await this._waitForRun(pt.runId);
        const result = this.orchestrator.runStore.getRun(pt.runId);
        this.completedTasks.push({ builder: pt.builderName, task: pt.task, summary: result?.summary || 'Done' });
      } catch {
        this.completedTasks.push({ builder: pt.builderName, task: pt.task, summary: 'FAILED' });
      }
    });
    await Promise.allSettled(promises);
  }

  async _finalReport() {
    const leader = this.orchestrator.registry.get(this.leaderId);
    let prompt = `You are the LEADER. Mission is complete after ${this.cycleCount} cycles.\n\n`;
    prompt += `## Mission\n${this.mission}\n\n`;
    prompt += `## All completed work\n`;
    this.completedTasks.forEach(t => { prompt += `- ${t.builder}: ${t.summary.slice(0, 200)}\n`; });
    prompt += `\n## Instructions\nWrite a final summary report for the user. Be concise.\n`;
    prompt += `End with: ACTION:report status="done" summary="your final summary"\n`;

    try {
      const run = await this.orchestrator.startRun({
        agentId: String(this.leaderId),
        prompt,
        taskTitle: 'Final Report',
        mode: 'shared-brief',
      });
      await this._waitForRun(run.id);
    } catch {}

    this.orchestrator.messageBus.send({
      from: this.leaderId, fromName: leader?.displayName || leader?.name || 'Leader',
      to: 'all', channel: 'radio', kind: 'report',
      text: `🎖 Mission complete after ${this.cycleCount} cycles, ${this.completedTasks.length} tasks completed.`,
    });
  }

  // Standup meeting — builders gather, report status, then disperse
  async _standup() {
    const leader = this.orchestrator.registry.get(this.leaderId);
    const builders = this.orchestrator.registry.list().filter(a => a.id !== this.leaderId && !a.locked);
    if (builders.length === 0) return;

    const leaderName = leader?.displayName || leader?.name || 'Leader';
    const builderIds = builders.map(b => b.id);

    // Emit meeting.gather — UI will move SCVs to meeting point
    this.orchestrator.emitEvent({
      type: 'meeting.gather',
      meetingType: 'standup',
      cycle: this.cycleCount,
      leaderId: this.leaderId,
      participants: [this.leaderId, ...builderIds],
    });

    this.orchestrator.messageBus.send({
      from: this.leaderId, fromName: leaderName,
      to: 'all', channel: 'radio', kind: 'system',
      text: `📋 Standup #${this.cycleCount} — everyone report status`,
    });

    // Wait for SCVs to visually gather (UI animation time)
    await new Promise(r => setTimeout(r, 2000));

    // Each builder gets a quick 1-line status
    const statusLines = [];
    for (const b of builders) {
      const lastTask = this.completedTasks.filter(t => t.builder === (b.displayName || b.name)).slice(-1)[0];
      const status = b.status === 'running' ? 'working' : lastTask ? `done: ${lastTask.summary.slice(0, 60)}` : 'idle';
      statusLines.push(`${b.displayName || b.name}: ${status}`);

      // Each builder says their status via radio
      this.orchestrator.messageBus.send({
        from: b.id, fromName: b.displayName || b.name,
        to: 'all', channel: 'radio', kind: 'report',
        text: status,
      });
      this.orchestrator.emitEvent({
        type: 'meeting.speak',
        agentId: b.id,
        agentName: b.displayName || b.name,
        text: status,
      });

      await new Promise(r => setTimeout(r, 800)); // pause between speakers
    }

    // Leader acknowledges
    this.orchestrator.messageBus.send({
      from: this.leaderId, fromName: leaderName,
      to: 'all', channel: 'radio', kind: 'system',
      text: `📋 Standup #${this.cycleCount} done. ${statusLines.length} reports received.`,
    });

    // Emit meeting.disperse — UI moves SCVs back
    this.orchestrator.emitEvent({
      type: 'meeting.disperse',
      meetingType: 'standup',
      cycle: this.cycleCount,
      participants: [this.leaderId, ...builderIds],
    });

    // Wait for disperse animation
    await new Promise(r => setTimeout(r, 1500));
  }

  _waitForRun(runId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.orchestrator.removeListener('event', handler); reject(new Error('timeout')); }, 300000);
      const handler = (event) => {
        const eid = event.run?.id || event.runId;
        if (eid !== runId) return;
        if (event.type === 'run.completed') { clearTimeout(timeout); this.orchestrator.removeListener('event', handler); resolve(event); }
        if (event.type === 'run.failed') { clearTimeout(timeout); this.orchestrator.removeListener('event', handler); reject(new Error(event.errorText || 'failed')); }
        if (event.type === 'run.cancelled') { clearTimeout(timeout); this.orchestrator.removeListener('event', handler); reject(new Error('cancelled')); }
      };
      this.orchestrator.on('event', handler);
    });
  }
}

module.exports = { LeaderLoop };
