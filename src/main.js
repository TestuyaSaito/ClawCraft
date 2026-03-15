const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { AgentOrchestrator } = require('./main/orchestrator/agent-orchestrator');

let mainWindow;
let orchestrator;

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
}

app.whenReady().then(() => {
  orchestrator = new AgentOrchestrator(path.resolve(__dirname, '..'));
  orchestrator.on('event', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('orchestrator:event', payload);
    }
  });
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (orchestrator) {
    orchestrator.shutdown();
  }
});
