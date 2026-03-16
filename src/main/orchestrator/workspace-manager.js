const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SKIP_DIRS = new Set(['node_modules', '.git', '.clawcraft', 'dist', 'coverage']);

class WorkspaceManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.baseDir = path.join(projectRoot, '.clawcraft');
    this.sharedDir = path.join(this.baseDir, 'shared');
    this.runsDir = path.join(this.baseDir, 'runs');
    this.worktreesDir = path.join(this.baseDir, 'worktrees');
    this.ensureBaseLayout();
  }

  ensureBaseLayout() {
    fs.mkdirSync(this.sharedDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    const briefPath = path.join(this.sharedDir, 'brief.md');
    const decisionsPath = path.join(this.sharedDir, 'decision-log.md');
    if (!fs.existsSync(briefPath)) {
      fs.writeFileSync(briefPath, '# Shared Brief\n');
    }
    if (!fs.existsSync(decisionsPath)) {
      fs.writeFileSync(decisionsPath, '# Decision Log\n');
    }
  }

  // Clean up orphan worktrees left from previous sessions
  cleanupOrphanWorktrees(knownAgentIds = new Set()) {
    if (!fs.existsSync(this.worktreesDir)) return;
    const entries = fs.readdirSync(this.worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('agent-')) continue;
      const agentId = entry.name.replace('agent-', '');
      if (!knownAgentIds.has(agentId)) {
        console.log(`[WorkspaceManager] Cleaning orphan worktree: ${entry.name}`);
        this.removeWorktree(agentId);
      }
    }
  }

  getSharedDir() {
    return this.sharedDir;
  }

  createRunArtifacts(runId) {
    const artifactsDir = path.join(this.runsDir, runId);
    fs.mkdirSync(artifactsDir, { recursive: true });
    return artifactsDir;
  }

  // ── Git worktree management ──

  isGitRepo() {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  createWorktree(agentId) {
    if (!this.isGitRepo()) {
      // Auto-init git repo for non-git project folders
      try {
        execSync('git init', { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' });
        execSync('git add -A', { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' });
        execSync('git commit -m "Initial commit by ClawCraft" --allow-empty', { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' });
        console.log(`[WorkspaceManager] Auto-initialized git repo at ${this.projectRoot}`);
      } catch (err) {
        throw new Error(`Git 초기화 실패: ${err.message}`);
      }
    }
    const branch = `agent/${agentId}`;
    const worktreeDir = path.join(this.worktreesDir, `agent-${agentId}`);

    // If worktree already exists, return it
    if (fs.existsSync(worktreeDir)) {
      return { workdir: worktreeDir, strategy: 'git-worktree', branch };
    }

    try {
      // Create branch from current HEAD if it doesn't exist
      try {
        execSync(`git branch ${branch}`, { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' });
      } catch {
        // Branch already exists, that's fine
      }
      // Create worktree
      execSync(`git worktree add "${worktreeDir}" ${branch}`, { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' });
      return { workdir: worktreeDir, strategy: 'git-worktree', branch };
    } catch (err) {
      throw new Error(`Worktree 생성 실패 (agent ${agentId}): ${err.message}. 병렬 실행 불가.`);
    }
  }

  removeWorktree(agentId) {
    const worktreeDir = path.join(this.worktreesDir, `agent-${agentId}`);
    const branch = `agent/${agentId}`;
    if (!fs.existsSync(worktreeDir)) return;

    try {
      execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      console.error(`[WorkspaceManager] Failed to remove worktree:`, err.message);
      // Force cleanup directory
      try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
    }

    // Clean up branch
    try {
      execSync(`git branch -D ${branch}`, { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      // Branch might not exist or be checked out elsewhere
    }
  }

  getWorkingContext(agentId) {
    if (!agentId) {
      return { workdir: this.projectRoot, strategy: 'in-place', branch: null };
    }
    const worktreeDir = path.join(this.worktreesDir, `agent-${agentId}`);
    if (fs.existsSync(worktreeDir)) {
      return { workdir: worktreeDir, strategy: 'git-worktree', branch: `agent/${agentId}` };
    }
    return this.createWorktree(agentId);
  }

  collectChangedFiles(worktreeDir, sinceMs) {
    const baseDir = worktreeDir || this.projectRoot;
    const changed = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
          continue;
        }
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= sinceMs) {
            changed.push(path.relative(baseDir, fullPath));
          }
        } catch {}
      }
    };
    walk(baseDir);
    return changed.sort();
  }

  // ── Shared context ──

  getSharedBrief() {
    const p = path.join(this.sharedDir, 'brief.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }

  getDecisionLog() {
    const p = path.join(this.sharedDir, 'decision-log.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }

  getRecentMessages(limit = 10) {
    const p = path.join(this.sharedDir, 'messages.ndjson');
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  appendMessage(msg) {
    const p = path.join(this.sharedDir, 'messages.ndjson');
    const entry = { ...msg, at: new Date().toISOString() };
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  }

  buildSharedContext(currentAgentId, allAgents = []) {
    const brief = this.getSharedBrief();
    const decisions = this.getDecisionLog();
    const recent = this.getRecentMessages(10);
    let ctx = '';

    // Team roster — who you are and who your teammates are
    if (allAgents.length > 0) {
      ctx += `## Your Identity\n`;
      const me = allAgents.find(a => String(a.id) === String(currentAgentId));
      if (me) {
        ctx += `You are **${me.name}** (ID:${me.id}), engine: ${me.engine}, model: ${me.model}.\n\n`;
      }
      const teammates = allAgents.filter(a => String(a.id) !== String(currentAgentId));
      if (teammates.length > 0) {
        ctx += `## Team (your fellow SCV agents)\n`;
        teammates.forEach(a => {
          const statusText = a.status === 'running' ? '작업 중' : a.status === 'idle' ? '대기' : a.status;
          ctx += `- **${a.name}** (ID:${a.id}) — ${a.engine}/${a.model} — ${statusText}${a.taskTitle && a.taskTitle !== 'Waiting' ? ` — "${a.taskTitle}"` : ''}\n`;
        });
        ctx += `\nYou can mention teammates by name. Your messages will be shared with them via the shared message log.\n\n`;
      }
    }

    if (brief.trim().length > 20) ctx += `## Project Brief\n${brief}\n\n`;
    if (decisions.trim().length > 20) ctx += `## Decision Log\n${decisions}\n\n`;

    // Recent conversation / activity
    if (recent.length > 0) {
      ctx += `## Recent Team Conversation\n`;
      recent.forEach(m => {
        const sender = m.agentName || 'agent';
        const text = m.text || m.summary || '';
        if (text) ctx += `- **${sender}**: ${text.slice(0, 200)}\n`;
      });
      ctx += '\n';
    }
    return ctx;
  }
}

module.exports = { WorkspaceManager };
