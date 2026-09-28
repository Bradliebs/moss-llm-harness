import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { safeStorage } from "electron";

import { userDataDir } from "./runtime/user-data";

type EncryptedCredentials = Record<string, string>;

function credentialPath(): string {
  return join(userDataDir(), "provider-credentials.json");
}

function readCredentials(): EncryptedCredentials {
  try {
    const value = JSON.parse(readFileSync(credentialPath(), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function writeCredentials(credentials: EncryptedCredentials): void {
  const path = credentialPath();
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporaryPath, JSON.stringify(credentials), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function assertProviderId(providerId: string): void {
  if (!/^[a-z0-9-]+$/.test(providerId)) throw new Error("Invalid provider credential id");
}

export const providerCredentials = {
  get(providerId: string): string {
    assertProviderId(providerId);
    const encrypted = readCredentials()[providerId];
    if (!encrypted) return "";
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("Secure credential storage is unavailable; outside the desktop app pass the API key through an environment variable");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  },

  set(providerId: string, apiKey: string): void {
    assertProviderId(providerId);
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("Secure credential storage is unavailable; outside the desktop app pass the API key through an environment variable");
    const credentials = readCredentials();
    const trimmed = apiKey.trim();
    if (trimmed) credentials[providerId] = safeStorage.encryptString(trimmed).toString("base64");
    else delete credentials[providerId];
    writeCredentials(credentials);
  },
};