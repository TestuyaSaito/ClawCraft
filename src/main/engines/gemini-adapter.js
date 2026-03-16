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

    // Gemini stream-json events (similar structure to Claude)
    if (payload.type === 'system' && payload.subtype === 'init') {
      return [{ type: 'status', phase: 'planning', label: 'Gemini 세션 시작' }];
    }
    if (payload.type === 'assistant' || payload.type === 'model') {
      const content = payload.message?.content || payload.content || [];
      const text = (Array.isArray(content) ? content : [content])
        .filter((item) => typeof item === 'string' || item?.type === 'text')
        .map((item) => typeof item === 'string' ? item : item.text)
        .join('\n')
        .trim();
      if (!text) return [];
      return [{
        type: 'message',
        text,
        phase: 'coding',
      }];
    }
    if (payload.type === 'result') {
      if (payload.subtype === 'success' || !payload.is_error) {
        return [{
          type: 'result',
          status: 'success',
          summary: payload.result || 'Gemini 작업이 완료되었습니다.',
        }];
      }
      return [{
        type: 'result',
        status: 'error',
        error: payload.result || 'Gemini 작업이 실패했습니다.',
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
