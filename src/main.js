const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { WebSocketServer } = require('ws');
const { AgentOrchestrator } = require('./main/orchestrator/agent-orchestrator');

const BRIDGE_PORT = 9477;
let mainWindow;
let orchestrator;
let wss;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'SCV Agent Animation',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

function registerIpcHandlers() {
  ipcMain.handle('agent:list', async () => orchestrator.listAgents());
  ipcMain.handle('engine:list', async () => orchestrator.getEngineStatuses());
  ipcMain.handle('state:get', async () => orchestrator.getState());
  ipcMain.handle('agent:create', async (_event, payload) => orchestrator.createAgent(payload));
  ipcMain.handle('agent:remove', async (_event, agentId) => orchestrator.removeAgent(agentId));
  ipcMain.handle('run:start', async (_event, payload) => orchestrator.startRun(payload));
  ipcMain.handle('run:cancel', async (_event, runId) => orchestrator.cancelRun(runId));
  ipcMain.handle('run:relay', async (_event, payload) => orchestrator.startRelay(payload));
  ipcMain.handle('workspace:diff', async (_event, agentId) => orchestrator.getAgentDiff(agentId));
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET BRIDGE — connects Claude Code ↔ ClawCraft UI
// Port 9477, JSON protocol
// ═══════════════════════════════════════════════════════════════
function startBridge() {
  wss = new WebSocketServer({ port: BRIDGE_PORT });
  console.log(`[Bridge] WebSocket server listening on ws://localhost:${BRIDGE_PORT}`);

  wss.on('connection', (ws) => {
    console.log('[Bridge] Client connected');
    ws.send(JSON.stringify({ type: 'connected', message: 'ClawCraft bridge ready' }));

    // Forward orchestrator events to bridge clients
    const forwardEvent = (event) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'event', event }));
      }
    };
    orchestrator.on('event', forwardEvent);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' })); return; }

      try {
        let result;
        switch (msg.action) {
          case 'getState':
            result = orchestrator.getState();
            break;
          case 'createAgent':
            result = orchestrator.createAgent(msg.payload || {});
            break;
          case 'removeAgent':
            result = await orchestrator.removeAgent(msg.agentId);
            break;
          case 'startRun':
            result = await orchestrator.startRun(msg.payload || {});
            break;
          case 'cancelRun':
            result = await orchestrator.cancelRun(msg.runId);
            break;
          case 'startRelay':
            result = await orchestrator.startRelay(msg.payload || {});
            break;
          case 'getDiff':
            result = orchestrator.getAgentDiff(msg.agentId);
            break;
          case 'listAgents':
            result = orchestrator.listAgents();
            break;
          default:
            result = { error: `Unknown action: ${msg.action}` };
        }
        ws.send(JSON.stringify({ type: 'response', id: msg.id, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, error: err.message }));
      }
    });

    ws.on('close', () => {
      console.log('[Bridge] Client disconnected');
      orchestrator.removeListener('event', forwardEvent);
    });
  });
}

app.whenReady().then(() => {
  orchestrator = new AgentOrchestrator(path.resolve(__dirname, '..'));
  orchestrator.on('event', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('orchestrator:event', payload);
    }
  });
  registerIpcHandlers();
  startBridge();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', async (e) => {
  if (orchestrator) {
    e.preventDefault();
    if (wss) wss.close();
    await orchestrator.shutdown();
    app.exit(0);
  }
});
