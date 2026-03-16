// ═══════════════════════════════════════════════════════════════
// CONVERSATION ROUTER — @mention parsing, auto-reply dispatch
// ═══════════════════════════════════════════════════════════════

class ConversationRouter {
  constructor(registry, messageBus, orchestrator) {
    this.registry = registry;
    this.messageBus = messageBus;
    this.orchestrator = orchestrator;
    // Pending inbox: messages for busy agents → reply when idle
    this.inbox = new Map(); // agentId → [messages]
  }

  // Route an outgoing message: parse mentions, send, trigger auto-reply
  async route(msg) {
    const mentions = this.registry.extractMentions(msg.text || '');
    const entry = this.messageBus.send({
      ...msg,
      mentions: mentions.map(m => m.agentId),
    });

    // For each mentioned agent, trigger auto-reply
    for (const mention of mentions) {
      const target = mention.agent;
      if (target.id === msg.from) continue; // don't reply to self
      if (target.status === 'running') {
        // Busy: queue to inbox
        if (!this.inbox.has(target.id)) this.inbox.set(target.id, []);
        this.inbox.get(target.id).push(entry);
      } else {
        // Idle: spawn auto-reply
        await this.spawnAutoReply(target, entry);
      }
    }

    // If no specific mentions but to !== 'all', try direct
    if (mentions.length === 0 && msg.to && msg.to !== 'all' && msg.to !== 'team') {
      const target = this.registry.get(msg.to);
      if (target && target.id !== msg.from) {
        if (target.status === 'running') {
          if (!this.inbox.has(target.id)) this.inbox.set(target.id, []);
          this.inbox.get(target.id).push(entry);
        } else {
          await this.spawnAutoReply(target, entry);
        }
      }
    }

    return entry;
  }

  // Spawn a reply-only run for target agent
  async spawnAutoReply(target, incomingMessage) {
    const fromAgent = this.registry.get(incomingMessage.from);
    const fromName = fromAgent?.displayName || fromAgent?.name || incomingMessage.fromName || 'someone';

    // Build context pack for the target
    const contextPack = this.orchestrator.getAgentContextPack(incomingMessage.from);

    const prompt = `## Incoming radio from ${fromName}\n"${incomingMessage.text}"\n\n${contextPack}\n\n## Instructions\nReply to ${fromName}'s message. Be concise. You may reference their recent work shown above.`;

    try {
      await this.orchestrator.startRun({
        agentId: String(target.id),
        prompt,
        taskTitle: `Reply to ${fromName}`,
        mode: 'shared-brief',
        isAutoReply: true,
      });
    } catch (err) {
      // If can't start (already running etc), queue it
      if (!this.inbox.has(target.id)) this.inbox.set(target.id, []);
      this.inbox.get(target.id).push(incomingMessage);
    }
  }

  // Called when an agent finishes a run — process inbox
  async processInbox(agentId) {
    const pending = this.inbox.get(agentId);
    if (!pending || pending.length === 0) return;
    // Take the most recent pending message
    const latest = pending[pending.length - 1];
    this.inbox.set(agentId, []);
    const target = this.registry.get(agentId);
    if (target && target.status === 'idle') {
      await this.spawnAutoReply(target, latest);
    }
  }
}

module.exports = { ConversationRouter };
