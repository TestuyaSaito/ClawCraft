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
  startCollaboration: (payload) => ipcRenderer.invoke('run:collaborate', payload),
  getAgentDiff: (agentId) => ipcRenderer.invoke('workspace:diff', agentId),
  sendMessage: (payload) => ipcRenderer.invoke('message:send', payload),
  listMessages: (agentId, limit) => ipcRenderer.invoke('message:list', agentId, limit),
  getAgentContext: (agentId) => ipcRenderer.invoke('agent:context', agentId),
  lookAround: (agentId) => ipcRenderer.invoke('agent:perception', agentId),
  selectProjectFolder: () => ipcRenderer.invoke('project:selectFolder'),
  getProjectPath: () => ipcRenderer.invoke('project:getPath'),
  onEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('orchestrator:event', wrapped);
    return () => ipcRenderer.removeListener('orchestrator:event', wrapped);
  }
});
