import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppInfo, ConnectionInfo } from "../shared/api";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));

function registerReadOnlyApi(): void {
  ipcMain.handle("app:get-info", (): AppInfo => ({ version: app.getVersion() }));
  ipcMain.handle("app:get-connection-info", (): ConnectionInfo => ({ status: "not-connected" }));
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    webPreferences: {
      preload: join(currentDirectory, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDirectory, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerReadOnlyApi();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
