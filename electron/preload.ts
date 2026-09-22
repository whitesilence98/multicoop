import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aiemployer", {
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  notify: (title: string, body: string) => ipcRenderer.invoke("notify", { title, body }),
});

contextBridge.exposeInMainWorld("electronAPI", {
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
});