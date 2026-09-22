/// <reference types="vite/client" />

/** Bridge exposed by electron/preload.ts */
interface ElectronAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}