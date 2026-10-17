import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MemoryConfig } from "../core/config.js";
import { contains, MemoryPaths } from "../core/paths.js";
import { factoryPath } from "./factory-path.js";
import { identifyProject, type ProjectIdentity } from "../core/project-identity.js";
import { MemoryStore } from "../core/store.js";
import { managedFileTools } from "./tools.js";
import { managedScanTools } from "./scans.js";
import type { MemoryActivity } from "./activity.js";
import { userError } from "./presentation.js";

export function sessionStoreProvider(agentDir: string, checkRuntime?: () => void, activity?: MemoryActivity) {
  let current: Promise<MemoryStore> | undefined;
  let resolved: MemoryStore | undefined;
  let generation = 0;
  const build = async (cwd: string, entered: number): Promise<MemoryStore> => {
    const config = await MemoryConfig.create(agentDir);
    let projectId: string;
    let identity = true;
    try { projectId = (await identifyProject(cwd)).projectId; }
    catch {
      identity = false;
      projectId = `cwd-${"0".repeat(64)}`;
      config.read = async () => ({ status: "unknown", enabled: false,
        fault: "Memory paused: project identity is unavailable; repair the repository or Git configuration." });
    }
    const paths = await MemoryPaths.create(agentDir, projectId);
    const store = new MemoryStore(paths, config, undefined, undefined, checkRuntime, activity?.bind(paths.projectDir));
    if (!identity) store.markIdentityUnverified();
    if (entered !== generation) {
      store.retire();
      throw new Error("Memory operation invalidated by a session change; retry in the current session.");
    }
    resolved = store;
    return store;
  };
  return {
    reset() { generation++; resolved?.retire(); current = undefined; resolved = undefined; },
    async obtain(ctx: Pick<ExtensionContext, "cwd">): Promise<MemoryStore> {
      const entered = generation;
      if (!current) {
        const pending = build(ctx.cwd, entered);
        current = pending;
        pending.catch(() => { if (current === pending) current = undefined; });
      }
      return current;
    },
  };
}

export interface RegistrationOptions {
  agentDir?: string;
  activity?: MemoryActivity;
  provider?: (ctx: ExtensionToolContext) => Promise<MemoryStore>;
}

export interface ToolObservation {
  name: string;
  registered: boolean;
  active: boolean;
  conflict: boolean;
}
export interface DiagnosticContext {
  agentDir: string;
  child: boolean;
  assertCurrent(): void;
  identify(): Promise<ProjectIdentity>;
  tools(): { entries: ToolObservation[]; paused: boolean };
}
export interface MemoryRuntime {
  activity?: MemoryActivity;
  getStore(ctx: ExtensionContext): Promise<MemoryStore>;
  diagnostics?(ctx: ExtensionContext): DiagnosticContext;
  assertCompatible?(): void;
  reset(): void;
}

function toolConflict(info: { parameters: unknown; sourceInfo: { path: string; source: string } }, schema: string | undefined, owner: string | undefined): boolean {
  return (schema !== undefined && JSON.stringify(info.parameters) !== schema)
    || (owner !== undefined ? info.sourceInfo.path !== owner : info.sourceInfo.source !== "builtin");
}

export function registerMemoryTools(pi: ExtensionAPI, options: RegistrationOptions = {}): MemoryRuntime {
  const agentDir = options.agentDir ?? getAgentDir();
  const session = sessionStoreProvider(agentDir, () => assertCompatible(), options.activity);
  let generation = 0;
  const reset = () => { generation++; session.reset(); };
  const owned = new Map<string, string>();
  const schemas = new Map<string, string>();
  const unsupportedSchemas = new Set<string>();
  let fault: string | undefined;
  const names = ["read", "write", "edit", "grep", "find", "ls"];
  const observe = () => {
    const configured = pi.getAllTools();
    return names.map((name) => {
      const info = configured.find((tool) => tool.name === name);
      return { name, info,
        unsupported: info !== undefined && schemas.has(name) && JSON.stringify(info.parameters) !== schemas.get(name),
        conflict: info !== undefined && toolConflict(info, schemas.get(name), owned.get(name)) };
    });
  };
  const pause = (reason: string) => {
    if (fault) return;
    fault = reason;
    options.activity?.pause(reason);
    session.reset();
  };
  const checkOwnership = () => {
    try {
      for (const entry of observe()) {
        if (entry.unsupported) unsupportedSchemas.add(entry.name);
        if (entry.conflict || unsupportedSchemas.has(entry.name)) {
          pause(`Memory paused: incompatible same-name tool override (${entry.name}); disable the conflicting extension and fully reload extensions.`);
        }
      }
    } catch {
      names.forEach((name) => unsupportedSchemas.add(name));
      pause("Memory paused: tool compatibility could not be checked; repair the extension configuration and fully reload extensions.");
    }
  };
  const assertCompatible = () => {
    checkOwnership();
    if (fault) throw new Error(fault);
  };
  const provider = async (ctx: ExtensionToolContext) => {
    checkOwnership();
    const store = await (options.provider ? options.provider(ctx) : session.obtain(ctx));
    checkOwnership();
    if (fault) {
      const config = await MemoryConfig.create(store.config.agentDir);
      config.read = async () => ({ status: "unknown", enabled: false, fault: fault! });
      return new MemoryStore(store.paths, config, store.child, store);
    }
    return store;
  };
  pi.on("session_start", async (_event, ctx) => {
    reset();
    const configured = pi.getAllTools();
    const active = pi.getActiveTools();
    const definitions = { ...managedFileTools(ctx.cwd, provider, { autoResizeImages: pi.getSettings().images?.autoResize, agentDir }), ...managedScanTools(ctx.cwd, provider, { agentDir }) };
    for (const name of Object.keys(definitions) as (keyof typeof definitions)[]) {
      const info = configured.find((tool) => tool.name === name);
      schemas.set(name, JSON.stringify(definitions[name].parameters));
      if (!info || owned.has(name)) continue;
      if (JSON.stringify(info.parameters) !== schemas.get(name)) unsupportedSchemas.add(name);
      if (toolConflict(info, schemas.get(name), undefined) || unsupportedSchemas.has(name)) {
        pause(`Memory paused: incompatible same-name tool override (${name}); disable the conflicting extension and fully reload extensions.`);
        continue;
      }
      pi.registerTool({ ...definitions[name], exposure: info.exposure, namespace: info.namespace, annotations: info.annotations } as ToolDefinition);
      const registered = pi.getAllTools().find((tool) => tool.name === name);
      if (registered) owned.set(name, registered.sourceInfo.path);
    }
    pi.setActiveTools(active);
    checkOwnership();
    if (fault) ctx.ui.notify(userError(new Error(fault), "兼容检查"), "warning");
  });
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("tool_call", async (event, ctx) => {
    checkOwnership();
    if (!fault || !["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) return;
    if (unsupportedSchemas.has(event.toolName)) return { block: true, reason: fault };
    try {
      const store = await session.obtain(ctx);
      const requested = "path" in event.input && typeof event.input.path === "string" ? event.input.path : ".";
      const absolute = await factoryPath(requested, ctx.cwd, event.toolName === "write" || event.toolName === "edit" ? "write" : "read", ctx as ExtensionToolContext);
      const target = await store.paths.classify(absolute, ctx.cwd);
      if (target.kind === "memory" || (["grep", "find", "ls"].includes(event.toolName) && contains(target.path, store.paths.memoryRoot))) {
        return { block: true, reason: fault };
      }
    } catch { return { block: true, reason: fault }; }
  });
  return {
    activity: options.activity,
    getStore: (ctx) => provider(ctx as ExtensionToolContext),
    assertCompatible,
    reset,
    diagnostics(ctx) {
      const entered = generation;
      const cwd = ctx.cwd;
      const assertCurrent = () => {
        if (entered !== generation || ctx.cwd !== cwd) throw new Error("Memory diagnosis invalidated by a session change; retry in the current session.");
      };
      return {
        agentDir,
        child: process.env.PI_SUBAGENT_CHILD === "1",
        assertCurrent,
        async identify() {
          assertCurrent();
          try { return await identifyProject(cwd); }
          finally { assertCurrent(); }
        },
        tools() {
          assertCurrent();
          const entries = observe();
          const active = pi.getActiveTools();
          return {
            paused: fault !== undefined,
            entries: entries.map(({ name, info, conflict }) => ({ name, registered: info !== undefined,
              active: active.includes(name), conflict: conflict || unsupportedSchemas.has(name) })),
          };
        },
      };
    },
  };
}
