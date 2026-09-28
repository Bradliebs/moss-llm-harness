import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { userDataDir } from "../runtime/user-data";

import type { CapabilityCatalogEntry } from "./capability-catalog";
import { CapabilityCatalog } from "./capability-catalog";

const RENAME_RETRIES = 5;
const RENAME_RETRY_BASE_MS = 20;
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export type CapabilityInstallState = "not-installed" | "installed" | "quarantined";

export interface CapabilityProvenance {
  schemaVersion: 1;
  id: string;
  version: string;
  sourceUrl: string;
  sha256: string;
  artifact: "artifact.raw";
  artifactType: "raw-single-file";
  installedAt: string;
  state: "installed" | "quarantined";
  quarantinedAt?: string;
  quarantineReason?: string;
  manifest: CapabilityCatalogEntry;
}

export interface CapabilityStatus {
  id: string;
  version: string;
  state: CapabilityInstallState;
  active: boolean;
  directory?: string;
  provenance?: CapabilityProvenance;
}

export interface CapabilityInstallerOptions {
  baseDir?: string;
  platform?: NodeJS.Platform;
  maxArtifactBytes?: number;
}

export class CapabilityInstaller {
  private readonly baseDir?: string;
  private readonly platform: NodeJS.Platform;
  private readonly maxArtifactBytes: number;

  constructor(
    private readonly catalog: CapabilityCatalog,
    options: CapabilityInstallerOptions = {},
  ) {
    this.baseDir = options.baseDir;
    this.platform = options.platform ?? process.platform;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes <= 0) {
      throw new Error("maxArtifactBytes must be a positive safe integer");
    }
  }

  async install(id: string, version: string): Promise<CapabilityStatus> {
    const entry = this.requireEntry(id, version);
    if (!entry.platforms.includes("any") && !entry.platforms.includes(this.platform as never)) {
      throw new Error(`Capability '${id}@${version}' does not support ${this.platform}`);
    }
    const current = await this.status(id, version);
    if (current.state !== "not-installed") throw new Error(`Capability '${id}@${version}' is already ${current.state}`);

    const stagingFile = join(this.root(), "staging", `${id}-${version}-${randomUUID()}.raw`);
    await mkdir(dirname(stagingFile), { recursive: true });
    try {
      const artifact = await this.readArtifact(entry.sourceUrl);
      if (artifact.byteLength > this.maxArtifactBytes) {
        throw new Error(`Capability artifact exceeds ${this.maxArtifactBytes} bytes`);
      }
      await writeFile(stagingFile, artifact);
      const actualSha256 = createHash("sha256").update(artifact).digest("hex");
      if (actualSha256 !== entry.sha256) {
        throw new Error(`Capability artifact sha256 mismatch: expected ${entry.sha256}, received ${actualSha256}`);
      }

      const versionDir = this.installedDir(id, version);
      await mkdir(versionDir, { recursive: true });
      try {
        await renameWithRetry(stagingFile, join(versionDir, "artifact.raw"));
        const provenance: CapabilityProvenance = {
          schemaVersion: 1,
          id,
          version,
          sourceUrl: entry.sourceUrl,
          sha256: entry.sha256,
          artifact: "artifact.raw",
          artifactType: "raw-single-file",
          installedAt: new Date().toISOString(),
          state: "installed",
          manifest: structuredClone(entry),
        };
        await writeJsonAtomically(join(versionDir, "provenance.json"), provenance);
        await writeJsonAtomically(this.activationFile(id), { id, version, activatedAt: new Date().toISOString() });
      } catch (error) {
        await rm(versionDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(stagingFile, { force: true }).catch(() => undefined);
    }
    return this.status(id, version);
  }

  async status(id: string, version: string): Promise<CapabilityStatus> {
    this.requireEntry(id, version);
    const installed = await this.readProvenance(this.installedDir(id, version));
    if (installed) {
      return {
        id,
        version,
        state: "installed",
        active: (await this.activeVersion(id)) === version,
        directory: this.installedDir(id, version),
        provenance: installed,
      };
    }
    const quarantined = await this.readProvenance(this.quarantineDir(id, version));
    if (quarantined) {
      return {
        id,
        version,
        state: "quarantined",
        active: false,
        directory: this.quarantineDir(id, version),
        provenance: quarantined,
      };
    }
    return { id, version, state: "not-installed", active: false };
  }

  async quarantine(id: string, version: string, reason: string): Promise<CapabilityStatus> {
    this.requireEntry(id, version);
    if (reason.trim() !== reason || reason.length === 0 || reason.length > 500) {
      throw new Error("Quarantine reason must be a non-empty trimmed string of at most 500 characters");
    }
    const current = await this.status(id, version);
    if (current.state !== "installed" || !current.provenance) {
      throw new Error(`Capability '${id}@${version}' is not installed`);
    }
    const target = this.quarantineDir(id, version);
    await mkdir(dirname(target), { recursive: true });
    await renameWithRetry(this.installedDir(id, version), target);
    await writeJsonAtomically(join(target, "provenance.json"), {
      ...current.provenance,
      state: "quarantined",
      quarantinedAt: new Date().toISOString(),
      quarantineReason: reason,
    } satisfies CapabilityProvenance);
    if ((await this.activeVersion(id)) === version) await rm(this.activationFile(id), { force: true });
    return this.status(id, version);
  }

  async remove(id: string, version: string): Promise<void> {
    this.requireEntry(id, version);
    await Promise.all([
      rm(this.installedDir(id, version), { recursive: true, force: true }),
      rm(this.quarantineDir(id, version), { recursive: true, force: true }),
    ]);
    if ((await this.activeVersion(id)) === version) await rm(this.activationFile(id), { force: true });
  }

  private root(): string {
    return join(this.baseDir ?? userDataDir(), "capabilities");
  }

  private installedDir(id: string, version: string): string {
    return join(this.root(), "installed", id, version);
  }

  private quarantineDir(id: string, version: string): string {
    return join(this.root(), "quarantine", id, version);
  }

  private activationFile(id: string): string {
    return join(this.root(), "active", `${id}.json`);
  }

  private requireEntry(id: string, version: string): CapabilityCatalogEntry {
    const entry = this.catalog.get(id, version);
    if (!entry) throw new Error(`Capability '${id}@${version}' is not in the catalog`);
    return entry;
  }

  private async readArtifact(sourceUrl: string): Promise<Buffer> {
    const url = new URL(sourceUrl);
    if (url.protocol === "file:") {
      const source = fileURLToPath(url);
      const sourceStats = await stat(source);
      if (!sourceStats.isFile()) throw new Error("Capability source must be a regular file");
      if (sourceStats.size > this.maxArtifactBytes) throw new Error(`Capability artifact exceeds ${this.maxArtifactBytes} bytes`);
      return readFile(source);
    }
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Capability download failed with HTTP ${response.status}`);
    if (response.url && new URL(response.url).protocol !== "https:") {
      throw new Error("Capability download redirected to a non-HTTPS URL");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxArtifactBytes) {
      throw new Error(`Capability artifact exceeds ${this.maxArtifactBytes} bytes`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async readProvenance(directory: string): Promise<CapabilityProvenance | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8")) as CapabilityProvenance;
      return parsed.schemaVersion === 1 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async activeVersion(id: string): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.activationFile(id), "utf8")) as { version?: unknown };
      return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await renameWithRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= RENAME_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_BASE_MS * 2 ** attempt));
    }
  }
}