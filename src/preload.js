const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clawcraft', {
  listAgents: () => ipcRenderer.invoke('agent:list'),
  listEngines: () => ipcRenderer.invoke('engine:list'),
  getState: () => ipcRenderer.invoke('state:get'),
  createAgent: (payload) => ipcRenderer.invoke('agent:create', payload),
  removeAgent: (agentId) => ipcRenderer.invoke('agent:remove', agentId),
  startRun: (payload) => ipcRenderer.invoke('run:start', payload),
  cancelRun: (runId) => ipcRenderer.invoke('run:cancel', runId),
  startRelay: (payload) => ipcRenderer.invoke('run:relay', payload),
  getAgentDiff: (agentId) => ipcRenderer.invoke('workspace:diff', agentId),
  onEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('orchestrator:event', wrapped);
    return () => ipcRenderer.removeListener('orchestrator:event', wrapped);
  }
});
