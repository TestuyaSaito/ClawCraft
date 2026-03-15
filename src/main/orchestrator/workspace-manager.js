const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.clawcraft', 'dist', 'coverage']);

class WorkspaceManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.baseDir = path.join(projectRoot, '.clawcraft');
    this.sharedDir = path.join(this.baseDir, 'shared');
    this.runsDir = path.join(this.baseDir, 'runs');
    this.ensureBaseLayout();
  }

  ensureBaseLayout() {
    fs.mkdirSync(this.sharedDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
    const briefPath = path.join(this.sharedDir, 'brief.md');
    const decisionsPath = path.join(this.sharedDir, 'decision-log.md');
    if (!fs.existsSync(briefPath)) {
      fs.writeFileSync(briefPath, '# Shared Brief\n');
    }
    if (!fs.existsSync(decisionsPath)) {
      fs.writeFileSync(decisionsPath, '# Decision Log\n');
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

  getWorkingContext() {
    return {
      workdir: this.projectRoot,
      strategy: 'in-place',
    };
  }

  collectChangedFiles(sinceMs) {
    const changed = [];
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
          continue;
        }
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= sinceMs) {
          changed.push(path.relative(this.projectRoot, fullPath));
        }
      }
    };

    walk(this.projectRoot);
    return changed.sort();
  }
}

module.exports = { WorkspaceManager };
