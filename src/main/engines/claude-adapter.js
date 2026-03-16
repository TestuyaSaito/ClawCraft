const { BaseAdapter } = require('./base-adapter');

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

class ClaudeAdapter extends BaseAdapter {
  constructor() {
    super({ id: 'claude', label: 'Claude', bin: 'claude' });
  }

  buildCommand(run, context) {
    // context.workdir is the agent's worktree path (or project root for in-place)
    return {
      command: 'claude',
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--permission-mode',
        'default',
        '--add-dir',
        context.sharedDir,
      ],
      cwd: context.workdir,
      env: process.env,
      stdinText: run.prompt,
    };
  }

  parseLine(line) {
    const payload = parseJsonLine(line);
    if (!payload) return [{ type: 'raw', line }];

    if (payload.type === 'system' && payload.subtype === 'init') {
      return [{ type: 'status', phase: 'planning', label: 'Claude 세션 시작' }];
    }
    if (payload.type === 'assistant') {
      const text = (payload.message?.content || [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
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
      if (payload.subtype === 'success' && !payload.is_error) {
        return [{
          type: 'result',
          status: 'success',
          summary: payload.result || 'Claude 작업이 완료되었습니다.',
        }];
      }
      return [{
        type: 'result',
        status: 'error',
        error: payload.result || 'Claude 작업이 실패했습니다.',
      }];
    }
    return [{ type: 'raw', payload }];
  }
}

module.exports = { ClaudeAdapter };
