const { BaseAdapter } = require('./base-adapter');

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

class GeminiAdapter extends BaseAdapter {
  constructor() {
    super({ id: 'gemini', label: 'Gemini', bin: 'gemini' });
  }

  buildCommand(run, context) {
    return {
      command: 'gemini',
      args: [
        '-p', run.prompt,
        '--output-format', 'stream-json',
        '--yolo',
      ],
      cwd: context.workdir,
      env: process.env,
    };
  }

  parseLine(line) {
    const payload = parseJsonLine(line);
    if (!payload) return [{ type: 'raw', line }];

    // Gemini stream-json format:
    // {"type":"init", ...}
    // {"type":"message", "role":"user"|"assistant", "content":"...", ...}
    // {"type":"result", "status":"success"|"error", ...}

    if (payload.type === 'init') {
      return [{ type: 'status', phase: 'planning', label: 'Gemini 세션 시작' }];
    }
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = typeof payload.content === 'string' ? payload.content : '';
      if (!text) return [];
      return [{
        type: 'message',
        text,
        phase: 'coding',
      }];
    }
    if (payload.type === 'result') {
      if (payload.status === 'success') {
        return [{
          type: 'result',
          status: 'success',
          summary: 'Gemini 작업이 완료되었습니다.',
          usage: payload.stats || null,
        }];
      }
      return [{
        type: 'result',
        status: 'error',
        error: payload.error || 'Gemini 작업이 실패했습니다.',
      }];
    }
    if (payload.type === 'error') {
      return [{
        type: 'result',
        status: 'error',
        error: payload.message || payload.error || line,
      }];
    }
    return [{ type: 'raw', payload }];
  }
}

module.exports = { GeminiAdapter };
