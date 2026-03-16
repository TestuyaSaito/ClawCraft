// ═══════════════════════════════════════════════════════════════
// AGENT REGISTRY — identity, team membership, presence
// ═══════════════════════════════════════════════════════════════

const DEFAULT_TEAM = 'terran-alpha';

class AgentRegistry {
  constructor() {
    this.agents = new Map(); // id → AgentRecord
  }

  register(payload = {}) {
    const id = String(payload.id || `${Date.now()}`);
    const existing = this.agents.get(id);
    if (existing) {
      Object.assign(existing, this._patch(payload));
      // If nickname changed, rebuild aliases
      if (payload.nickname && payload.nickname !== existing.displayName) {
        this.setNickname(id, payload.nickname);
      }
      return existing;
    }
    // Ensure unique name
    let name = payload.name || `Agent-${id}`;
    const baseName = name;
    let nameIdx = 1;
    while ([...this.agents.values()].some(a => a.name === name)) {
      nameIdx++;
      name = `${baseName}-${String(nameIdx).padStart(2, '0')}`;
    }
    // Ensure unique callSign
    let callSign = payload.callSign || name.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '');
    const baseCall = callSign;
    let callIdx = 1;
    while ([...this.agents.values()].some(a => a.callSign === callSign)) {
      callIdx++;
      callSign = `${baseCall}-${callIdx}`;
    }
    const record = {
      id,
      sessionId: payload.sessionId || id,
      name,
      nickname: payload.nickname || '',
      displayName: payload.displayName || payload.nickname || name,
      callSign,
      aliases: payload.aliases || [...new Set([name, payload.nickname, callSign].filter(Boolean))].flatMap(n=>[n,`@${n}`]),
      engine: payload.engine || 'codex',
      model: payload.model || 'gpt-5.4',
      role: payload.role || 'builder',
      teamId: payload.teamId || DEFAULT_TEAM,
      relation: 'teammate',
      locked: !!payload.locked,
      sessionKind: payload.sessionKind || '',
      taskTitle: payload.taskTitle || 'Waiting',
      status: 'idle',
      currentRunId: null,
      slot: payload.slot || null,
      workspace: payload.workspace || null,
    };
    this.agents.set(id, record);
    return record;
  }

  unregister(id) {
    return this.agents.delete(String(id));
  }

  get(id) {
    return this.agents.get(String(id));
  }

  list() {
    return [...this.agents.values()];
  }

  listTeam(teamId) {
    return this.list().filter(a => a.teamId === (teamId || DEFAULT_TEAM));
  }

  // Set nickname — updates displayName, nickname, aliases
  setNickname(id, nickname) {
    const agent = this.get(id);
    if (!agent) return null;
    agent.nickname = nickname;
    agent.displayName = nickname;
    // Rebuild aliases to include nickname
    const names = new Set([agent.name, nickname, agent.callSign]);
    agent.aliases = [...names].flatMap(n => [n, `@${n}`]).filter(Boolean);
    return agent;
  }

  // Resolve @mention or name to agent
  resolveByMention(mention) {
    const clean = mention.replace(/^@/, '').trim().toLowerCase();
    for (const agent of this.agents.values()) {
      if (agent.aliases && agent.aliases.some(a => a.toLowerCase() === clean)) return agent;
      if (agent.callSign === clean) return agent;
      if (agent.name.toLowerCase() === clean) return agent;
      if (agent.displayName && agent.displayName.toLowerCase() === clean) return agent;
    }
    return null;
  }

  // Extract all @mentions from text and resolve them
  extractMentions(text) {
    const mentions = [];
    const regex = /@([\w가-힣.-]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const agent = this.resolveByMention(match[1]);
      if (agent) mentions.push({ raw: match[0], name: match[1], agentId: agent.id, agent });
    }
    return mentions;
  }

  // Get structured world state from one agent's perspective
  getPresenceFor(agentId) {
    const me = this.get(agentId);
    if (!me) return null;
    const teammates = this.list().filter(a => a.id !== String(agentId) && a.teamId === me.teamId);
    const nick = (a) => a.nickname || a.displayName || a.name;
    return {
      self: {
        id: me.id,
        name: nick(me),
        engine: me.engine,
        model: me.model,
        role: me.role,
        teamId: me.teamId,
        status: me.status,
        taskTitle: me.taskTitle,
      },
      teammates: teammates.map(a => ({
        id: a.id,
        name: nick(a),
        engine: a.engine,
        model: a.model,
        role: a.role,
        status: a.status,
        taskTitle: a.taskTitle,
      })),
    };
  }

  updatePresence(id, patch) {
    const agent = this.get(id);
    if (!agent) return null;
    if (patch.status !== undefined) agent.status = patch.status;
    if (patch.currentRunId !== undefined) agent.currentRunId = patch.currentRunId;
    if (patch.taskTitle !== undefined) agent.taskTitle = patch.taskTitle;
    if (patch.slot !== undefined) agent.slot = patch.slot;
    if (patch.workspace !== undefined) agent.workspace = patch.workspace;
    return agent;
  }

  toJSON() {
    return this.list().map(a => ({
      id: a.id, sessionId: a.sessionId, name: a.name,
      displayName: a.displayName, nickname: a.nickname, callSign: a.callSign,
      aliases: a.aliases,
      engine: a.engine, model: a.model, role: a.role,
      teamId: a.teamId, locked: a.locked,
      sessionKind: a.sessionKind, taskTitle: a.taskTitle,
    }));
  }

  _patch(p) {
    const out = {};
    if (p.name) out.name = p.name;
    if (p.displayName) out.displayName = p.displayName;
    if (p.nickname) out.nickname = p.nickname;
    if (p.callSign) out.callSign = p.callSign;
    if (p.aliases) out.aliases = p.aliases;
    if (p.engine) out.engine = p.engine;
    if (p.model) out.model = p.model;
    if (p.role) out.role = p.role;
    if (p.teamId) out.teamId = p.teamId;
    if (p.locked !== undefined) out.locked = !!p.locked;
    if (p.sessionKind) out.sessionKind = p.sessionKind;
    if (p.taskTitle) out.taskTitle = p.taskTitle;
    if (p.workspace) out.workspace = p.workspace;
    return out;
  }
}

module.exports = { AgentRegistry };
