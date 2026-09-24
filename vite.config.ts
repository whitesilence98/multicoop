import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: "src",
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8737",
        changeOrigin: true,
        // Team chat runs over WebSockets (/api/chat/ws) — without ws:true
        // the dev server swallows the upgrade request and chat never connects.
        ws: true,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});