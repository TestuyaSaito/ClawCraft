const fs = require('fs');
const path = require('path');

class RunStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.runs = new Map();
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  createRun(run) {
    const record = {
      ...run,
      transcript: [],
      summary: '',
      filesChanged: [],
      errorText: '',
    };
    this.runs.set(run.id, record);
    fs.mkdirSync(run.artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(run.artifactsDir, 'meta.json'), JSON.stringify(record, null, 2));
    return record;
  }

  getRun(runId) {
    return this.runs.get(runId);
  }

  listRuns() {
    return [...this.runs.values()].map((run) => ({ ...run, process: undefined, progressTimer: undefined }));
  }

  updateRun(runId, patch) {
    const run = this.runs.get(runId);
    if (!run) return null;
    Object.assign(run, patch);
    this.persistMeta(run);
    return run;
  }

  appendTranscript(runId, entry) {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.transcript.push(entry);
    fs.appendFileSync(path.join(run.artifactsDir, 'transcript.ndjson'), `${JSON.stringify(entry)}\n`);
    this.persistMeta(run);
    return run;
  }

  setSummary(runId, summary) {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.summary = summary;
    fs.writeFileSync(path.join(run.artifactsDir, 'summary.md'), summary || '');
    this.persistMeta(run);
    return run;
  }

  setFilesChanged(runId, filesChanged) {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.filesChanged = filesChanged;
    fs.writeFileSync(path.join(run.artifactsDir, 'files.json'), JSON.stringify(filesChanged, null, 2));
    this.persistMeta(run);
    return run;
  }

  persistMeta(run) {
    const serializable = { ...run, process: undefined, progressTimer: undefined };
    fs.writeFileSync(path.join(run.artifactsDir, 'meta.json'), JSON.stringify(serializable, null, 2));
  }
}

module.exports = { RunStore };
