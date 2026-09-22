import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aiemployer", {
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  notify: (title: string, body: string) => ipcRenderer.invoke("notify", { title, body }),
});