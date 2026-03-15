const { spawnSync } = require('child_process');

class BaseAdapter {
  constructor(options) {
    this.id = options.id;
    this.label = options.label;
    this.bin = options.bin;
  }

  isAvailable() {
    const result = spawnSync('/bin/zsh', ['-lc', `command -v ${this.bin}`], { encoding: 'utf8' });
    return result.status === 0;
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      available: this.isAvailable(),
    };
  }

  buildCommand() {
    throw new Error(`${this.id} adapter must implement buildCommand()`);
  }

  parseLine(line) {
    return [{ type: 'raw', line }];
  }
}

module.exports = { BaseAdapter };
