import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, WorkbenchEvent } from '../shared/contracts';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const bridge: DesktopBridge = {
  getSnapshot: () => invoke('desktop:getSnapshot'),
  addRoot: () => invoke('desktop:addRoot'),
  removeRoot: rootId => invoke('desktop:removeRoot', rootId),
  addDocument: () => invoke('desktop:addDocument'),
  removeDocument: documentId => invoke('desktop:removeDocument', documentId),
  setPrimaryRoot: rootId => invoke('desktop:setPrimaryRoot', rootId),
  setPermission: userMode => invoke('desktop:setPermission', userMode),
  saveModel: (profile, keyChange) => invoke('desktop:saveModel', profile, keyChange),
  selectModel: modelId => invoke('desktop:selectModel', modelId),
  deleteModel: modelId => invoke('desktop:deleteModel', modelId),
  testModel: () => invoke('desktop:testModel'),
  startMessage: text => invoke('desktop:startMessage', text),
  implementPlan: () => invoke('desktop:implementPlan'),
  cancelRun: runId => invoke('desktop:cancelRun', runId),
  decideApproval: (approvalId, decision) => invoke('desktop:decideApproval', approvalId, decision),
  newTask: () => invoke('desktop:newTask'),
  selectTask: taskId => invoke('desktop:selectTask', taskId),
  renameTask: (taskId, title) => invoke('desktop:renameTask', taskId, title),
  deleteTask: taskId => invoke('desktop:deleteTask', taskId),
  getRunEvents: runId => invoke('desktop:getRunEvents', runId),
  getPreferences: () => invoke('desktop:getPreferences'),
  setPreferences: preferences => invoke('desktop:setPreferences', preferences),
  getChanges: () => invoke('desktop:getChanges'),
  getDiff: (rootId, path) => invoke('desktop:getDiff', rootId, path),
  detectAcceptance: () => invoke('desktop:detectAcceptance'),
  setAcceptance: acceptance => invoke('desktop:setAcceptance', acceptance),
  verifyNow: () => invoke('desktop:verifyNow'),
  continueTask: () => invoke('desktop:continueTask'),
  getDelivery: () => invoke('desktop:getDelivery'),
  acceptRoot: rootId => invoke('desktop:acceptRoot', rootId),
  restoreRoot: rootId => invoke('desktop:restoreRoot', rootId),
  commitRoot: (rootId, message, confirmShared) => invoke('desktop:commitRoot', rootId, message, confirmShared),
  listMemory: () => invoke('desktop:listMemory'),
  changeMemory: change => invoke('desktop:changeMemory', change),
  addMemoryNote: text => invoke('desktop:addMemoryNote', text),
  setMemoryEnabled: enabled => invoke('desktop:setMemoryEnabled', enabled),
  setWebSearch: config => invoke('desktop:setWebSearch', config),
  reloadMcp: () => invoke('desktop:reloadMcp'),
  setMcpEnabled: (name, enabled) => invoke('desktop:setMcpEnabled', name, enabled),
  openMcpConfig: () => invoke('desktop:openMcpConfig'),
  restartHost: () => invoke('desktop:restartHost'),
  onEvent: listener => {
    const subscription = (_event: Electron.IpcRendererEvent, value: WorkbenchEvent) => listener(value);
    ipcRenderer.on('desktop:event', subscription);
    return () => ipcRenderer.removeListener('desktop:event', subscription);
  },
};

contextBridge.exposeInMainWorld('codeAgent', bridge);
