// ═══════════════════════════════════════════════════════════════
// MESSAGE BUS — structured inter-agent communication
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let msgCounter = 0;

class MessageBus extends EventEmitter {
  constructor(sharedDir) {
    super();
    this.sharedDir = sharedDir;
    this.filePath = path.join(sharedDir, 'messages.ndjson');
    this.memory = []; // in-memory queue for current session
    fs.mkdirSync(sharedDir, { recursive: true });
  }

  // Send a structured message
  send(msg) {
    const entry = {
      id: `msg_${Date.now()}_${++msgCounter}`,
      from: msg.from || 'system',
      fromName: msg.fromName || '',
      to: msg.to || 'all',           // agentId | 'all' | 'team'
      channel: msg.channel || 'radio', // radio | local | system
      kind: msg.kind || 'chat',       // chat | task-update | request | report | error
      text: msg.text || '',
      relatedRunId: msg.relatedRunId || null,
      at: new Date().toISOString(),
    };
    this.memory.push(entry);
    if (this.memory.length > 200) this.memory = this.memory.slice(-200);
    // Persist
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    // Emit for real-time listeners
    this.emit('message', entry);
    return entry;
  }

  // Get recent messages (optionally filtered)
  getRecent(opts = {}) {
    const limit = opts.limit || 15;
    const channel = opts.channel || null;
    const forAgent = opts.forAgent || null;
    let msgs = this.memory.length > 0 ? this.memory : this._loadFromDisk();
    if (channel) msgs = msgs.filter(m => m.channel === channel);
    if (forAgent) msgs = msgs.filter(m => m.to === 'all' || m.to === 'team' || m.to === forAgent || m.from === forAgent);
    return msgs.slice(-limit);
  }

  // Get conversation visible to a specific agent
  getConversationFor(agentId, limit = 10) {
    return this.getRecent({ forAgent: agentId, limit });
  }

  // Clear (for testing)
  clear() {
    this.memory = [];
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
  }

  _loadFromDisk() {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}

module.exports = { MessageBus };
