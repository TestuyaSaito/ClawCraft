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
      return existing;
    }
    const record = {
      id,
      sessionId: payload.sessionId || id,
      name: payload.name || `Agent-${id}`,
      engine: payload.engine || 'codex',
      model: payload.model || 'gpt-5',
      role: payload.role || 'builder',        // builder | reviewer | leader | assistant
      teamId: payload.teamId || DEFAULT_TEAM,
      relation: 'teammate',
      locked: !!payload.locked,
      sessionKind: payload.sessionKind || '',
      taskTitle: payload.taskTitle || 'Waiting',
      // Presence
      status: 'idle',          // idle | running | failed | cancelled
      currentRunId: null,
      slot: payload.slot || null, // build slot position (set by renderer)
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

  // Get structured world state from one agent's perspective
  getPresenceFor(agentId) {
    const me = this.get(agentId);
    if (!me) return null;
    const teammates = this.list().filter(a => a.id !== String(agentId) && a.teamId === me.teamId);
    return {
      self: {
        id: me.id,
        name: me.name,
        engine: me.engine,
        model: me.model,
        role: me.role,
        teamId: me.teamId,
        status: me.status,
        taskTitle: me.taskTitle,
      },
      teammates: teammates.map(a => ({
        id: a.id,
        name: a.name,
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
      engine: a.engine, model: a.model, role: a.role,
      teamId: a.teamId, locked: a.locked,
      sessionKind: a.sessionKind, taskTitle: a.taskTitle,
    }));
  }

  _patch(p) {
    const out = {};
    if (p.name) out.name = p.name;
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
