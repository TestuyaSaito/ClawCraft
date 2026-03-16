// ═══════════════════════════════════════════════════════════════
// PROMPT COMPILER — builds per-agent context injection
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

class PromptCompiler {
  constructor(registry, messageBus, sharedDir) {
    this.registry = registry;
    this.messageBus = messageBus;
    this.sharedDir = sharedDir;
    this._lastPerception = ''; // set before compile() by orchestrator
  }

  setPerception(perceptionText) {
    this._lastPerception = perceptionText || '';
  }

  // Compile full prompt with team context for a specific agent
  compile(agentId, taskPrompt, mode = 'shared-brief') {
    if (mode === 'solo') return taskPrompt;

    const presence = this.registry.getPresenceFor(agentId);
    if (!presence) return taskPrompt;

    let ctx = '';

    // Identity
    const me = presence.self;
    ctx += `You are SCV **${me.name}** (ID: ${me.id}).\n`;
    ctx += `Engine: ${me.engine}, Model: ${me.model}, Role: ${me.role}, Team: ${me.teamId}\n\n`;

    // Teammates
    if (presence.teammates.length > 0) {
      ctx += `## Visible teammates\n`;
      presence.teammates.forEach(t => {
        const statusMap = { running: 'working', idle: 'idle', failed: 'failed' };
        ctx += `- **${t.name}** (ID:${t.id}) — ${t.engine}/${t.model}, status=${statusMap[t.status] || t.status}`;
        if (t.taskTitle && t.taskTitle !== 'Waiting') ctx += `, task="${t.taskTitle}"`;
        ctx += '\n';
      });
      ctx += '\n';
    }

    // Project brief
    const briefPath = path.join(this.sharedDir, 'brief.md');
    if (fs.existsSync(briefPath)) {
      const brief = fs.readFileSync(briefPath, 'utf8').trim();
      if (brief.length > 20) ctx += `## Project Brief\n${brief}\n\n`;
    }

    // Decision log
    const decPath = path.join(this.sharedDir, 'decision-log.md');
    if (fs.existsSync(decPath)) {
      const dec = fs.readFileSync(decPath, 'utf8').trim();
      if (dec.length > 20) ctx += `## Decision Log\n${dec}\n\n`;
    }

    // Recent radio (team conversation)
    const messages = this.messageBus.getConversationFor(agentId, 10);
    if (messages.length > 0) {
      ctx += `## Recent radio\n`;
      messages.forEach(m => {
        const sender = m.fromName || m.from;
        const kindTag = m.kind !== 'chat' ? ` [${m.kind}]` : '';
        ctx += `- **${sender}**${kindTag}: ${(m.text || '').slice(0, 200)}\n`;
      });
      ctx += '\n';
    }

    // Perception (spatial awareness) — injected if available
    if (this._lastPerception) {
      ctx += this._lastPerception;
    }

    // Instructions — structured collaboration protocol
    ctx += `## Collaboration Protocol\n`;
    ctx += `When you need to communicate with teammates, include ACTION blocks in your output.\n`;
    ctx += `Each ACTION block must be on its own line in this exact format:\n\n`;
    ctx += `ACTION:delegate target="teammate name" task="what to do"\n`;
    ctx += `ACTION:report status="done|failed|blocked" summary="what happened"\n`;
    ctx += `ACTION:blocker issue="what's blocking" need="what help is needed"\n`;
    ctx += `ACTION:request-review target="reviewer name" files="file1.js,file2.js"\n`;
    ctx += `ACTION:review-result verdict="approve|reject|revise" notes="feedback"\n`;
    ctx += `ACTION:handoff target="next owner" context="what they need to know"\n\n`;
    ctx += `Rules:\n`;
    ctx += `- Always end your work with ACTION:report\n`;
    ctx += `- If you're stuck, use ACTION:blocker immediately\n`;
    ctx += `- If you need another teammate's help, use ACTION:delegate\n`;
    ctx += `- Do your coding work first, then add ACTION blocks at the end\n`;
    ctx += `- You can include multiple ACTION blocks\n\n`;

    ctx += `---\n\n## Current objective\n${taskPrompt}`;
    return ctx;
  }
}

module.exports = { PromptCompiler };
