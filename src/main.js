const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { WebSocketServer } = require('ws');
const { AgentOrchestrator } = require('./main/orchestrator/agent-orchestrator');

const BRIDGE_PORT = 9477;
let mainWindow;
let orchestrator;
let wss;

function registerBridgeSession(client) {
  if (!orchestrator || !client) return null;
  return orchestrator.registerSessionClient(client);
}

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
  ipcMain.handle('run:start', async (_event, payload) => {
    // Auto lookAround before starting run
    if (mainWindow && !mainWindow.isDestroyed() && payload.agentId) {
      try {
        const perception = await mainWindow.webContents.executeJavaScript(`(function(){const p=getAgentPerception('${payload.agentId}');return p?perceptionToText(p):'';})()`);
        if (perception) payload._perceptionText = perception;
      } catch {}
    }
    return orchestrator.startRun(payload);
  });
  ipcMain.handle('run:cancel', async (_event, runId) => orchestrator.cancelRun(runId));
  ipcMain.handle('run:relay', async (_event, payload) => orchestrator.startRelay(payload));
  ipcMain.handle('run:collaborate', async (_event, payload) => orchestrator.startCollaboration(payload));
  ipcMain.handle('workspace:diff', async (_event, agentId) => orchestrator.getAgentDiff(agentId));
  ipcMain.handle('message:send', async (_event, payload) => orchestrator.sendMessage(payload));
  ipcMain.handle('message:list', async (_event, agentId, limit) => orchestrator.listMessages(agentId, limit));
  ipcMain.handle('agent:context', async (_event, agentId) => orchestrator.getAgentContextPack(agentId));
  ipcMain.handle('agent:perception', async (_event, agentId) => {
    // Get perception from renderer via webContents
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    return mainWindow.webContents.executeJavaScript(`getAgentPerception('${agentId}')`);
  });

  // Project folder selection
  ipcMain.handle('project:selectFolder', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '프로젝트 폴더 선택',
    });
    if (result.canceled || !result.filePaths.length) return null;
    const newPath = result.filePaths[0];
    // Shutdown current orchestrator and reinitialize with new path
    await orchestrator.shutdown();
    orchestrator = new AgentOrchestrator(newPath);
    orchestrator.on('event', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('orchestrator:event', payload);
      }
    });
    // Save project path for next session
    const fs = require('fs');
    const configPath = path.join(__dirname, '..', '.clawcraft', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ projectRoot: newPath }, null, 2));
    return newPath;
  });

  ipcMain.handle('project:getPath', async () => {
    return orchestrator.projectRoot;
  });
}

// Load saved project path
function getSavedProjectRoot() {
  const fs = require('fs');
  const configPath = path.join(__dirname, '..', '.clawcraft', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.projectRoot && fs.existsSync(config.projectRoot)) return config.projectRoot;
  } catch {}
  return path.resolve(__dirname, '..');
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
        registerBridgeSession(msg.client);
        let result;
        switch (msg.action) {
          case 'hello':
            result = registerBridgeSession(msg.client || msg.payload || {});
            break;
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
          case 'collaborate':
            result = await orchestrator.startCollaboration(msg.payload || {});
            break;
          case 'getDiff':
            result = orchestrator.getAgentDiff(msg.agentId);
            break;
          case 'sendMessage':
            result = await orchestrator.sendMessage(msg.payload || {});
            break;
          case 'listMessages':
            result = orchestrator.listMessages(msg.agentId, msg.limit);
            break;
          case 'getContext':
            result = orchestrator.getAgentContextPack(msg.agentId);
            break;
          case 'lookAround':
            if (mainWindow && !mainWindow.isDestroyed()) {
              result = await mainWindow.webContents.executeJavaScript(`getAgentPerception('${msg.agentId}')`);
            }
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
  orchestrator = new AgentOrchestrator(getSavedProjectRoot());
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
