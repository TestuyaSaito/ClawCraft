const { BaseAdapter } = require('./base-adapter');

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

class CodexAdapter extends BaseAdapter {
  constructor() {
    super({ id: 'codex', label: 'Codex', bin: 'codex' });
  }

  buildCommand(run, context) {
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        '-C',
        context.workdir,
        run.prompt,
      ],
      cwd: context.workdir,
      env: process.env,
    };
  }

  parseLine(line) {
    const payload = parseJsonLine(line);
    if (!payload) return [{ type: 'raw', line }];

    if (payload.type === 'thread.started') {
      return [{ type: 'status', phase: 'planning', label: 'Codex 세션 시작' }];
    }
    if (payload.type === 'turn.started') {
      return [{ type: 'status', phase: 'planning', label: 'Codex가 작업을 해석 중' }];
    }
    if (payload.type === 'item.completed' && payload.item?.type === 'agent_message') {
      return [{
        type: 'message',
        text: payload.item.text || '',
        phase: 'coding',
      }];
    }
    if (payload.type === 'turn.completed') {
      return [{
        type: 'result',
        status: 'success',
        summary: 'Codex 작업이 완료되었습니다.',
        usage: payload.usage || null,
      }];
    }
    if (payload.type === 'error') {
      return [{
        type: 'result',
        status: 'error',
        error: payload.message || line,
      }];
    }
    return [{ type: 'raw', payload }];
  }
}

module.exports = { CodexAdapter };
