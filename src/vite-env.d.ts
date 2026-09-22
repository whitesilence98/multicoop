/// <reference types="vite/client" />

interface AiEmployerBridge {
  pickDirectory: () => Promise<string | null>;
  notify: (title: string, body: string) => void;
}

/** Bridge exposed by electron/preload.ts */
interface ElectronAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
  aiemployer?: AiEmployerBridge;
}