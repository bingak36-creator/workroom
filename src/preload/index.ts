import { contextBridge, ipcRenderer } from 'electron';
import type { WorkroomAPI } from '../shared';
const api: WorkroomAPI = {
  snapshot: () => ipcRenderer.invoke('snapshot'), addProject: () => ipcRenderer.invoke('project:add'),
  setWritable: (id, value) => ipcRenderer.invoke('project:writable', id, value),
  addTask: (p,t,o) => ipcRenderer.invoke('task:add', p,t,o), setTask: (id,s) => ipcRenderer.invoke('task:status',id,s),
  decide: (id,a) => ipcRenderer.invoke('job:decide',id,a), cancelJob: id => ipcRenderer.invoke('job:cancel',id),
  pause: value => ipcRenderer.invoke('pause',value),
  listFiles: (p,r) => ipcRenderer.invoke('files:list',p,r), readFile: (p,r) => ipcRenderer.invoke('files:read',p,r),
  copyConnection: () => ipcRenderer.invoke('connection:copy'), copyPrompt: id => ipcRenderer.invoke('prompt:copy',id),
  openDocs: () => ipcRenderer.invoke('docs:open'),
  tunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  inspectTunnel: () => ipcRenderer.invoke('tunnel:inspect'),
  setApprovalMode: (id,mode) => ipcRenderer.invoke('project:approval-mode',id,mode),
  approveFolder: (id,relative) => ipcRenderer.invoke('project:folder-approve',id,relative),
  revokeFolder: (id,relative) => ipcRenderer.invoke('project:folder-revoke',id,relative),
  removeProject: id => ipcRenderer.invoke('project:remove',id),
  clearHistory: id => ipcRenderer.invoke('history:clear',id),
  startTunnel: (id,key) => ipcRenderer.invoke('tunnel:start',id,key),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  openConnectionLink: link => ipcRenderer.invoke('connection:open',link),
  copyTunnelId: () => ipcRenderer.invoke('tunnel:copy-id'),
  onChange: callback => { const handler = (): void => callback(); ipcRenderer.on('change',handler); return () => ipcRenderer.removeListener('change',handler); }
};
contextBridge.exposeInMainWorld('workroom',api);
