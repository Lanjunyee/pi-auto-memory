import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplace, type AtomicHooks } from "./atomic-file.js";
import { canonicalProspective } from "./paths.js";
import { withLock, type LockLease } from "./locks.js";
import { CONFIG_VERSION_LEGACY, CONFIG_VERSION_PROJECTS } from "./constants.js";

export type ProjectId = string;

export type ConfigData =
  | { version: 1; enabled: boolean; [field: string]: unknown }
  | { version: 2; enabled: boolean; disabledProjects: ProjectId[]; [field: string]: unknown };

export type ProjectPolicy = "inherit" | "disabled";
export type ConfigState =
  | { status: "known"; enabled: boolean; data: ConfigData; missing: boolean }
  | { status: "unknown"; enabled: false; fault: string };

export type EffectiveState =
  | { status: "known"; globalEnabled: boolean; projectPolicy: ProjectPolicy; effectiveEnabled: boolean; reason: "global-off" | "project-disabled" | "enabled"; data: ConfigData; missing: boolean }
  | { status: "unknown"; effectiveEnabled: false; fault: string };

const CONFIG_FAULT = "Memory paused: auto-memory.json is unreadable, corrupt or unsupported; repair it before retrying.";

export type ConfigInspectionReason = "unreadable" | "unsafe-path" | "invalid-format" | "unsupported-version";
export type ConfigInspection =
  | { status: "known"; enabled: boolean; data: ConfigData; missing: boolean }
  | { status: "unknown"; enabled: false; reason: ConfigInspectionReason };

export const PROJECT_ID_PATTERN = /^(git|cwd)-[a-f0-9]{64}$/;

export function isProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

export function projectDisabled(data: ConfigData, projectId: string): boolean {
  if (data.version !== CONFIG_VERSION_PROJECTS) return false;
  return data.disabledProjects.includes(projectId);
}

export function projectPolicy(data: ConfigData, projectId: string): ProjectPolicy {
  return projectDisabled(data, projectId) ? "disabled" : "inherit";
}

export function resolveEffectiveState(state: ConfigState, projectId: string): EffectiveState {
  if (state.status !== "known") return { status: "unknown", effectiveEnabled: false, fault: state.fault };
  const policy = projectPolicy(state.data, projectId);
  const effectiveEnabled = state.enabled && policy !== "disabled";
  const reason = !state.enabled ? "global-off" as const : policy === "disabled" ? "project-disabled" as const : "enabled" as const;
  return { status: "known", globalEnabled: state.enabled, projectPolicy: policy, effectiveEnabled, reason, data: state.data, missing: state.missing };
}

function validateProjects(value: unknown): ProjectId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !isProjectId(item) || seen.has(item)) return undefined;
    seen.add(item);
  }
  return [...value] as ProjectId[];
}

function parseData(value: unknown): ConfigData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version === CONFIG_VERSION_LEGACY) {
    if (typeof record.enabled !== "boolean") return undefined;
    return record as ConfigData;
  }
  if (record.version === CONFIG_VERSION_PROJECTS) {
    if (typeof record.enabled !== "boolean") return undefined;
    if (!validateProjects(record.disabledProjects)) return undefined;
    return record as ConfigData;
  }
  return undefined;
}

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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "known", enabled: true, data: { version: CONFIG_VERSION_LEGACY, enabled: true }, missing: true };
      return { status: "unknown", enabled: false, reason: "unreadable" };
    }
    if (info.isSymbolicLink() || !info.isFile()) return { status: "unknown", enabled: false, reason: "unsafe-path" };
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch {
      return { status: "unknown", enabled: false, reason: "unreadable" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch {
      return { status: "unknown", enabled: false, reason: "invalid-format" };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "unknown", enabled: false, reason: "invalid-format" };
    if (![CONFIG_VERSION_LEGACY, CONFIG_VERSION_PROJECTS].includes((raw as { version?: unknown }).version as number)) {
      return { status: "unknown", enabled: false, reason: "unsupported-version" };
    }
    const data = parseData(raw);
    if (!data) return { status: "unknown", enabled: false, reason: "invalid-format" };
    return { status: "known", enabled: data.enabled, data, missing: false };
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
  async setProjectDisabled(projectId: string, disabled: boolean, hooks: AtomicHooks = {}): Promise<ConfigState> {
    if (!isProjectId(projectId)) throw new Error("Memory project setting rejected: an invalid current project identity was provided.");
    return this.locked(async (state, lease) => {
      if (state.status !== "known") throw new Error(state.fault);
      if (state.data.version === CONFIG_VERSION_LEGACY && "disabledProjects" in state.data) {
        throw new Error("Memory project setting rejected: the existing configuration reserves disabledProjects; repair or migrate it before retrying.");
      }
      const current = state.data.version === CONFIG_VERSION_PROJECTS ? state.data.disabledProjects : [];
      const next = disabled ? [...new Set([...current, projectId])] : current.filter((item) => item !== projectId);
      const data: ConfigData = { ...state.data, version: CONFIG_VERSION_PROJECTS, disabledProjects: next };
      await atomicReplace(this.path, `${JSON.stringify(data, null, 2)}\n`, {
        ...hooks,
        beforeRename: async () => { await hooks.beforeRename?.(); lease.check(); },
      });
      return { status: "known", enabled: data.enabled, data, missing: false };
    });
  }
}
