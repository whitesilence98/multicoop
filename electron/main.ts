/**
 * Electron main process — spawns, health-checks, and owns the FastAPI sidecar.
 *
 * Dev:      python -m uvicorn backend.main:app   (venv)
 * Prod:     bundled PyInstaller binary under resources/backend/
 *
 * Frameless window: the native title bar and menu are removed; the renderer
 * supplies a custom React TitleBar (src/components/TitleBar.tsx) that drags
 * the window and sends control commands over IPC.
 */
import { app, BrowserWindow, ipcMain, dialog, Notification, Menu } from "electron";
import { spawn, ChildProcess } from "child_process";
import * as http from "http";
import * as path from "path";

const BACKEND_PORT = 8737;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;

let backendProc: ChildProcess | null = null;
let shuttingDown = false;

// ---- sidecar lifecycle --------------------------------------------------------

function resolveBackendCommand(): { cmd: string; args: string[] } {
  const isPackaged = app.isPackaged;

  if (isPackaged) {
    const exe = path.join(process.resourcesPath, "backend", "aiemployer-server.exe");
    return { cmd: exe, args: ["--port", String(BACKEND_PORT)] };
  }

  // Dev: prefer the project venv python, fall back to whatever `python` is.
  const projectRoot = app.getAppPath();
  const venvPython =
    process.platform === "win32"
      ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
      : path.join(projectRoot, ".venv", "bin", "python");
  return {
    cmd: venvPython,
    args: ["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
  };
}

function spawnBackend(): void {
  const { cmd, args } = resolveBackendCommand();
  console.log(`[sidecar] spawning: ${cmd} ${args.join(" ")}`);
  backendProc = spawn(cmd, args, {
    cwd: app.getAppPath(),
    env: { ...process.env, PYTHONUNBUFFERED: "1", AIEMPLOYER_PORT: String(BACKEND_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  backendProc.stdout?.on("data", (d: Buffer) => console.log(`[backend] ${d.toString().trim()}`));
  backendProc.stderr?.on("data", (d: Buffer) => console.error(`[backend] ${d.toString().trim()}`));
  backendProc.on("exit", (code) => {
    console.log(`[sidecar] exited code=${code}`);
    backendProc = null;
    if (!shuttingDown) {
      new Notification({
        title: "AI Employer backend stopped",
        body: `The orchestrator process exited (code ${code}). Restart the agent runner.`,
      }).show();
    }
  });
}

/** Poll /api/health until it answers (or give up after `timeoutMs`). */
function waitForBackend(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(BACKEND_URL, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2_000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error("backend health check timed out"));
      setTimeout(tick, 500);
    };
    tick();
  });
}

function killBackend(): void {
  shuttingDown = true;
  if (!backendProc) return;
  console.log("[sidecar] terminating backend");
  if (process.platform === "win32") {
    // taskkill takes the child tree with it (uvicorn workers).
    spawn("taskkill", ["/pid", String(backendProc.pid), "/f", "/t"]);
  } else {
    backendProc.kill("SIGTERM");
  }
  backendProc = null;
}

// ---- window --------------------------------------------------------------------

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    frame: false,            // custom React TitleBar replaces the native frame
    backgroundColor: "#0c0e17",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged) {
    // Dev: always hit the Vite server. Loading dist/index.html over file://
    // would render blank (ES-module scripts are CORS-blocked on file://).
    win.loadURL(process.env.VITE_DEV_SERVER_URL || "http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// ---- IPC -----------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle("pick-directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("notify", (_e, { title, body }: { title: string; body: string }) => {
    new Notification({ title, body }).show();
  });

  // Window controls from the custom TitleBar (fire-and-forget).
  ipcMain.on("window-minimize", (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.on("window-maximize", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.on("window-close", (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
}

// ---- app lifecycle ---------------------------------------------------------------

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // remove File/Edit/View/Window/Help entirely
  registerIpc();

  try {
    const alreadyUp = await isBackendUp();
    if (!alreadyUp) {
      spawnBackend();
      await waitForBackend();
    } else {
      console.log("[sidecar] backend already running; attaching to it");
    }
  } catch (e) {
    dialog.showErrorBox(
      "Backend failed to start",
      `The FastAPI sidecar did not become healthy.\n\n${e}`
    );
    app.quit();
    return;
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", killBackend);
app.on("window-all-closed", () => {
  killBackend();
  app.quit();
});

async function isBackendUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(BACKEND_URL, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1_500, () => {
      req.destroy();
      resolve(false);
    });
  });
}