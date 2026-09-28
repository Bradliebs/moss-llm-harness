// electron/backend/moss/models/model-profile-store.ts
//
// Latest capability profile per provider kind, endpoint, and model, persisted
// under Electron user data. Profiles hold scores and short grading notes only:
// no API keys, prompts beyond the fixed probe text, or workspace data.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import type { ModelCapabilityProfile, ProviderKind } from "../../../../common/types";
import { writeFileAtomic } from "../persistence/atomic-file";
import { profileKey } from "./capability-profile";

const MAX_PROFILES = 100;

function isProfile(value: unknown): value is ModelCapabilityProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ModelCapabilityProfile>;
  return profile.schemaVersion === 1 && typeof profile.model === "string" && typeof profile.endpoint === "string"
    && typeof profile.providerKind === "string" && Array.isArray(profile.results);
}

export class ModelProfileStore {
  private queue: Promise<void> = Promise.resolve();
  /** Profiles change only through save(), so reads after the first are served from memory. */
  private cache: Promise<ModelCapabilityProfile[]> | null = null;

  constructor(private readonly baseDir?: string) {}

  private file(): string {
    return join(this.baseDir ?? userDataDir(), "model-profiles", "profiles.json");
  }

  list(): Promise<ModelCapabilityProfile[]> {
    this.cache ??= this.read();
    this.cache.catch(() => { this.cache = null; });
    return this.cache.then((profiles) => [...profiles]);
  }

  private async read(): Promise<ModelCapabilityProfile[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file(), "utf8"));
      const profiles = Array.isArray(value) ? value.filter(isProfile) : [];
      return profiles.sort((a, b) => b.probedAt.localeCompare(a.probedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  async get(kind: ProviderKind, baseUrl: string, model: string): Promise<ModelCapabilityProfile | null> {
    const key = profileKey(kind, baseUrl, model);
    return (await this.list()).find((profile) => profileKey(profile.providerKind, profile.endpoint, profile.model) === key) ?? null;
  }

  save(profile: ModelCapabilityProfile): Promise<void> {
    const run = this.queue.then(async () => {
      const key = profileKey(profile.providerKind, profile.endpoint, profile.model);
      const others = (await this.list()).filter((item) => profileKey(item.providerKind, item.endpoint, item.model) !== key);
      const next = [profile, ...others].slice(0, MAX_PROFILES);
      await writeFileAtomic(this.file(), JSON.stringify(next, null, 2));
      this.cache = Promise.resolve(next.sort((a, b) => b.probedAt.localeCompare(a.probedAt)));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export const modelProfileStore = new ModelProfileStore();
