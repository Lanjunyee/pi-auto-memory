import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplace, type AtomicHooks } from "./atomic-file.js";
import { canonicalProspective } from "./paths.js";
import { withLock, type LockLease } from "./locks.js";
import { CONFIG_VERSION } from "./constants.js";

export type ConfigData = { version: 1; enabled: boolean; [field: string]: unknown };
export type ConfigState =
  | { status: "known"; enabled: boolean; data: ConfigData; missing: boolean }
  | { status: "unknown"; enabled: false; fault: string };

const CONFIG_FAULT = "Memory paused: auto-memory.json is unreadable, corrupt or unsupported; repair it before retrying.";

export type ConfigInspectionReason = "unreadable" | "unsafe-path" | "invalid-format" | "unsupported-version";
export type ConfigInspection =
  | { status: "known"; enabled: boolean; data: ConfigData; missing: boolean }
  | { status: "unknown"; enabled: false; reason: ConfigInspectionReason };

export class MemoryConfig {
  readonly path: string;
  readonly anchor: string;
  private constructor(readonly agentDir: string) {
    this.path = join(agentDir, "auto-memory.json");
    this.anchor = join(agentDir, ".auto-memory-config-lock");
  }
  static async create(agentDir: string): Promise<MemoryConfig> {
    return new MemoryConfig(await canonicalProspective(agentDir));
  }
  async inspect(): Promise<ConfigInspection> {
    let info;
    try {
      info = await lstat(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "known", enabled: true, data: { version: 1, enabled: true }, missing: true };
      return { status: "unknown", enabled: false, reason: "unreadable" };
    }
    if (info.isSymbolicLink() || !info.isFile()) return { status: "unknown", enabled: false, reason: "unsafe-path" };
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch {
      return { status: "unknown", enabled: false, reason: "unreadable" };
    }
    let data: unknown;
    try {
      data = JSON.parse(contents);
    } catch {
      return { status: "unknown", enabled: false, reason: "invalid-format" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { status: "unknown", enabled: false, reason: "invalid-format" };
    if ((data as ConfigData).version !== CONFIG_VERSION) return { status: "unknown", enabled: false, reason: "unsupported-version" };
    if (typeof (data as ConfigData).enabled !== "boolean") return { status: "unknown", enabled: false, reason: "invalid-format" };
    return { status: "known", enabled: (data as ConfigData).enabled, data: data as ConfigData, missing: false };
  }
  async read(): Promise<ConfigState> {
    const result = await this.inspect();
    if (result.status === "known") return result;
    return { status: "unknown", enabled: false, fault: CONFIG_FAULT };
  }
  async locked<T>(action: (state: ConfigState, lease: LockLease) => Promise<T>): Promise<T> {
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    return withLock(this.anchor, async (lease) => action(await this.read(), lease));
  }
  async setEnabled(enabled: boolean, hooks: AtomicHooks = {}): Promise<ConfigState> {
    return this.locked(async (state, lease) => {
      if (state.status !== "known") throw new Error(state.fault);
      const data: ConfigData = { ...state.data, enabled };
      await atomicReplace(this.path, `${JSON.stringify(data, null, 2)}\n`, {
        ...hooks,
        beforeRename: async () => { await hooks.beforeRename?.(); lease.check(); },
      });
      return { status: "known", enabled, data, missing: false };
    });
  }
}
