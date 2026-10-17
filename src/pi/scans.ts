import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { contains } from "../core/paths.js";
import type { MemoryStore } from "../core/store.js";
import { checkScanAbort, excludeMemoryLinks, scanPath, scanPolicy } from "./scan-policy.js";
import { protectedFind, protectedGrep } from "./scan-process.js";
import { degradedMemoryError, degradedRoute, lexicalMemoryRoot, type DegradedRoute } from "./degraded-path.js";

type StoreProvider = MemoryStore | ((ctx: ExtensionToolContext) => Promise<MemoryStore>);

export function managedScanTools(cwd: string, provider: StoreProvider, options: { agentDir?: string } = {}) {
  const host = {
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
  const obtain = (ctx: ExtensionToolContext) => typeof provider === "function" ? provider(ctx) : Promise.resolve(provider);
  const degrade = async (path: string | undefined, ctx: ExtensionToolContext, signal?: AbortSignal): Promise<DegradedRoute> => {
    checkScanAbort(signal);
    return degradedRoute(lexicalMemoryRoot(options.agentDir), path ?? ".", ctx.cwd || cwd, "read", ctx, signal);
  };
  const obtainOrDegrade = async (path: string | undefined, ctx: ExtensionToolContext, signal?: AbortSignal) => {
    checkScanAbort(signal);
    try {
      return { store: await obtain(ctx), route: undefined as DegradedRoute | undefined };
    } catch {
      return { store: undefined, route: await degrade(path, ctx, signal) };
    }
  };
  const grep: typeof host.grep = {
    ...host.grep,
    async execute(id, params, signal, update, ctx) {
      const ready = await obtainOrDegrade(params.path, ctx, signal);
      if (!ready.store) {
        if (ready.route === "memory") return { content: [{ type: "text", text: "No matches found" }], details: undefined };
        if (ready.route === "ancestor") throw degradedMemoryError();
        return host.grep.execute(id, params, signal, update, ctx);
      }
      const policy = await scanPolicy(ready.store, await scanPath(params.path, cwd, ctx, signal), ctx.cwd || cwd, signal);
      if (!policy.overlapping) return host.grep.execute(id, params, signal, update, ctx);
      return protectedGrep(ready.store, policy, params, signal);
    },
  };
  const find: typeof host.find = {
    ...host.find,
    async execute(id, params, signal, update, ctx) {
      const ready = await obtainOrDegrade(params.path, ctx, signal);
      if (!ready.store) {
        if (ready.route === "memory") return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
        if (ready.route === "ancestor") throw degradedMemoryError();
        return host.find.execute(id, params, signal, update, ctx);
      }
      const policy = await scanPolicy(ready.store, await scanPath(params.path, cwd, ctx, signal), ctx.cwd || cwd, signal);
      if (!policy.overlapping) return host.find.execute(id, params, signal, update, ctx);
      await excludeMemoryLinks(ready.store, policy, signal);
      return protectedFind(ready.store, policy, params, signal);
    },
  };
  const ls: typeof host.ls = {
    ...host.ls,
    async execute(id, params, signal, update, ctx) {
      const ready = await obtainOrDegrade(params.path, ctx, signal);
      if (!ready.store) {
        if (ready.route === "memory") return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
        if (ready.route === "ancestor") throw degradedMemoryError();
        return host.ls.execute(id, params, signal, update, ctx);
      }
      const { store } = ready;
      const policy = await scanPolicy(store, await scanPath(params.path, cwd, ctx, signal), ctx.cwd || cwd, signal);
      if (!policy.overlapping) return host.ls.execute(id, params, signal, update, ctx);
      if (policy.empty) return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
      const factory = createLsToolDefinition(cwd, { operations: {
        exists: async (path) => {
          checkScanAbort(signal);
          try { await access(path); return true; } catch { return false; }
        },
        stat: async (path) => {
          checkScanAbort(signal);
          const target = await store.paths.classify(path, ctx.cwd || cwd);
          if (target.kind === "memory" && target.path !== store.paths.memoryRoot) await store.access(target.path);
          return stat(path);
        },
        readdir: async (path) => {
          checkScanAbort(signal);
          const names = await readdir(path);
          const permitted: string[] = [];
          for (const name of names) {
            checkScanAbort(signal);
            if (policy.excluded.some((excluded) => contains(excluded, join(policy.root, name)))) continue;
            try {
              const target = await store.paths.classify(join(path, name), ctx.cwd || cwd);
              if (target.kind === "memory" && target.path !== store.paths.memoryRoot) await store.access(target.path);
              permitted.push(name);
            } catch {                                                            }
          }
          return permitted;
        },
      } });
      const result = await factory.execute(id, params, signal, update, ctx);
      store.assertLifecycle();
      return result;
    },
  };
  return { grep, find, ls };
}
