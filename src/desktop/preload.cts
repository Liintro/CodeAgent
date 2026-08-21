import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, WorkbenchEvent } from '../shared/contracts';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const bridge: DesktopBridge = {
  getSnapshot: () => invoke('desktop:getSnapshot'),
  chooseProject: () => invoke('desktop:chooseProject'),
  saveModel: (profile, keyChange) => invoke('desktop:saveModel', profile, keyChange),
  selectModel: modelId => invoke('desktop:selectModel', modelId),
  testModel: () => invoke('desktop:testModel'),
  startMessage: text => invoke('desktop:startMessage', text),
  cancelInvocation: invocationId => invoke('desktop:cancelInvocation', invocationId),
  decideApproval: (approvalId, decision) => invoke('desktop:decideApproval', approvalId, decision),
  newConversation: () => invoke('desktop:newConversation'),
  selectConversation: conversationId => invoke('desktop:selectConversation', conversationId),
  restartHost: () => invoke('desktop:restartHost'),
  onEvent: listener => {
    const subscription = (_event: Electron.IpcRendererEvent, value: WorkbenchEvent) => listener(value);
    ipcRenderer.on('desktop:event', subscription);
    return () => ipcRenderer.removeListener('desktop:event', subscription);
  },
};

contextBridge.exposeInMainWorld('codeAgent', bridge);
