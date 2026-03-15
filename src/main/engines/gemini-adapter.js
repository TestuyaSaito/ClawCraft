const { BaseAdapter } = require('./base-adapter');

class GeminiAdapter extends BaseAdapter {
  constructor() {
    super({ id: 'gemini', label: 'Gemini', bin: 'gemini' });
  }

  buildCommand() {
    throw new Error('Gemini CLI is not installed on this machine yet.');
  }
}

module.exports = { GeminiAdapter };
