import { contextBridge, ipcRenderer } from 'electron';

// This preload has no Watson command bridge and never receives provider credentials.
const channel = process.argv.find(value => value.startsWith('--watson-capture-channel='))?.slice('--watson-capture-channel='.length);
if (!channel || !/^watson:windows-capture:[a-f0-9-]{36}$/.test(channel)) throw new Error('Invalid capture IPC channel');
contextBridge.exposeInMainWorld('watsonCapture', {
  send: (message: unknown) => ipcRenderer.invoke(channel, message),
  onStop: (listener: (runId: string) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (value && typeof value === 'object' && 'runId' in value && typeof value.runId === 'string') listener(value.runId);
    };
    ipcRenderer.on(`${channel}:stop`, receive);
    return () => ipcRenderer.removeListener(`${channel}:stop`, receive);
  },
});
