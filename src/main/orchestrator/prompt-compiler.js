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

    // Instructions
    ctx += `## Communication rules\n`;
    ctx += `- Your messages are shared with teammates via the radio channel.\n`;
    ctx += `- Mention teammates by name when coordinating.\n`;
    ctx += `- Report completion, failures, or blockers.\n\n`;

    ctx += `---\n\n## Current objective\n${taskPrompt}`;
    return ctx;
  }
}

module.exports = { PromptCompiler };
