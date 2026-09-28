// Where Moss keeps its data. Inside the desktop app this is Electron's user
// data folder; a headless host (the moss CLI, a CI job, another front end)
// sets it explicitly or through MOSS_USER_DATA, so the same harness runs
// without Electron.

import { app } from "electron";

let override: string | undefined;

export function setUserDataDir(dir: string | undefined): void {
  override = dir;
}

export function hasElectronApp(): boolean {
  return !!app && typeof app.getPath === "function";
}

export function userDataDir(): string {
  if (override) return override;
  const fromEnv = process.env.MOSS_USER_DATA?.trim();
  if (fromEnv) return fromEnv;
  // Outside Electron, require("electron") yields the binary path, not the API.
  if (!hasElectronApp()) {
    throw new Error("Moss is running outside Electron: set MOSS_USER_DATA or call setUserDataDir() first.");
  }
  return app.getPath("userData");
}

/** Root of the application files, for bundled assets. */
export function appRootDir(): string {
  if (app && typeof app.getAppPath === "function") return app.getAppPath();
  return process.env.MOSS_APP_ROOT?.trim() || process.cwd();
}

export function isPackagedApp(): boolean {
  return !!app && app.isPackaged === true;
}
