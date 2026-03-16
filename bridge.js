#!/usr/bin/env node
// ClawCraft Bridge CLI — send commands to running Electron app via WebSocket
// Usage: node bridge.js <action> [JSON args]
// Examples:
//   node bridge.js getState
//   node bridge.js createAgent '{"engine":"claude","name":"Claude-01"}'
//   node bridge.js startRun '{"agentId":"1","prompt":"Fix the bug in app.js"}'
//   node bridge.js listAgents
//   node bridge.js getDiff 1
//   node bridge.js removeAgent 1

const WebSocket = require('ws');
const BRIDGE_URL = 'ws://localhost:9477';

function sanitizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'session';
}

function buildClientMeta() {
  const threadId = process.env.CODEX_THREAD_ID || '';
  const termSessionId = process.env.TERM_SESSION_ID || '';
  const token = threadId || termSessionId || `pid-${process.pid}`;
  const shortToken = String(token).slice(0, 8);
  return {
    sessionId: `codex-cli-${sanitizeToken(token)}`,
    threadId,
    termSessionId,
    pid: process.pid,
    name: 'Codex CLI',
    engine: 'codex',
    model: 'gpt-5',
    role: 'assistant',
    locked: true,
    sessionKind: 'codex-cli',
    taskTitle: `Talking with you in CLI ${shortToken}`,
  };
}

const action = process.argv[2];
if (!action) {
  console.log('Usage: node bridge.js <action> [args]');
  console.log('Actions: getState, listAgents, createAgent, removeAgent, startRun, cancelRun, startRelay, getDiff');
  process.exit(1);
}

const arg = process.argv[3];
let payload, agentId, runId;

try {
  if (action === 'removeAgent' || action === 'getDiff') {
    agentId = arg;
  } else if (action === 'cancelRun') {
    runId = arg;
  } else if (arg) {
    payload = JSON.parse(arg);
  }
} catch {
  payload = { prompt: arg };
}

const ws = new WebSocket(BRIDGE_URL);
const msgId = Date.now().toString();
const client = buildClientMeta();

ws.on('open', () => {
  const msg = { id: msgId, action };
  msg.client = client;
  if (payload) msg.payload = payload;
  if (agentId) msg.agentId = agentId;
  if (runId) msg.runId = runId;
  ws.send(JSON.stringify(msg));
});

ws.on('message', (raw) => {
  const data = JSON.parse(raw);
  if (data.type === 'connected') return;
  if (data.type === 'response' && data.id === msgId) {
    console.log(JSON.stringify(data.result, null, 2));
    ws.close();
  }
  if (data.type === 'error' && data.id === msgId) {
    console.error('Error:', data.error);
    ws.close();
    process.exit(1);
  }
  if (data.type === 'event') {
    // Stream events if waiting
    const e = data.event;
    if (e.type === 'run.phase') process.stderr.write(`[${e.phase}] ${e.label || ''} ${Math.round((e.progress||0)*100)}%\n`);
    if (e.type === 'run.output') process.stderr.write(`[output] ${e.text?.slice(0,200)}\n`);
    if (e.type === 'run.completed') { console.log('\n✅ Run completed'); ws.close(); }
    if (e.type === 'run.failed') { console.error('\n❌ Run failed:', e.errorText); ws.close(); process.exit(1); }
  }
});

ws.on('error', (err) => {
  console.error('Connection failed. Is ClawCraft Electron app running? (npm start)');
  console.error(err.message);
  process.exit(1);
});

// Timeout
setTimeout(() => { console.error('Timeout'); ws.close(); process.exit(1); }, 30000);
