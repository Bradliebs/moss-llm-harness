import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: undefined }));

import { appRootDir, hasElectronApp, setUserDataDir, userDataDir } from "./user-data";

afterEach(() => {
  setUserDataDir(undefined);
  vi.unstubAllEnvs();
});

describe("userDataDir", () => {
  it("prefers an explicit folder, then MOSS_USER_DATA", () => {
    vi.stubEnv("MOSS_USER_DATA", "/from-env");
    expect(userDataDir()).toBe("/from-env");
    setUserDataDir("/explicit");
    expect(userDataDir()).toBe("/explicit");
  });

  it("explains how to run outside Electron instead of crashing", () => {
    vi.stubEnv("MOSS_USER_DATA", "");
    expect(hasElectronApp()).toBe(false);
    expect(() => userDataDir()).toThrow(/MOSS_USER_DATA/);
  });

  it("falls back to MOSS_APP_ROOT or the working folder for bundled assets", () => {
    vi.stubEnv("MOSS_APP_ROOT", "/app");
    expect(appRootDir()).toBe("/app");
  });
});
