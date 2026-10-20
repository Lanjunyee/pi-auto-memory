import { basename } from "node:path";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  type AgentToolResult,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { digest, MemoryStore } from "../core/store.js";
import type { savedResult } from "../core/content-policy.js";
import { factoryPath } from "./factory-path.js";
import { returnedReadRange } from "./read-coverage.js";
import { degradedMemoryError, degradedRoute, lexicalMemoryRoot, type DegradedRoute } from "./degraded-path.js";

export function standardFileTools(cwd: string, readOptions?: { autoResizeImages?: boolean }) {
  return {
    read: createReadToolDefinition(cwd, readOptions),
    write: createWriteToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
  };
}

type Save = ReturnType<typeof savedResult>;
type StoreProvider = MemoryStore | ((ctx: ExtensionToolContext) => Promise<MemoryStore>);

function managedError(error: unknown): Error {
  const message = error instanceof Error
    ? error.message.startsWith("Memory ") ? error.message
      : (error as NodeJS.ErrnoException).code === "ENOENT" ? "Memory file not found; it does not exist yet and may be created."
        : "Memory operation failed; reread the file and retry. No successful save was reported."
    : "Memory operation failed; reread the file and retry. No successful save was reported.";
  return new Error(message);
}

function saveTiming(path: string): string {
  return basename(path) === "MEMORY.md"
    ? "磁盘索引已保存，当前快照不会自动更新；执行 /memory reload 后将在下一条用户任务时重载。"
    : "主题已保存；本次保存未核实 MEMORY.md 关联。请检查已有入口，仅在缺失或过时时更新；主题仍由模型按需读取，保存不代表已注入或必然遵循。";
}

function savedToolResult<T>(result: AgentToolResult<T>, saved: Save, path: string): AgentToolResult<T> {
  return {
    ...result,
    content: [...result.content, { type: "text", text: `${saved.note} ${saveTiming(path)}` }],
    isError: saved.isError,
  };
}

export function managedFileTools(cwd: string, provider: StoreProvider, options: { autoResizeImages?: boolean; agentDir?: string } = {}) {
  const host = standardFileTools(cwd, { autoResizeImages: options.autoResizeImages });
  const obtain = (ctx: ExtensionToolContext) => typeof provider === "function" ? provider(ctx) : Promise.resolve(provider);
  const route = async (store: MemoryStore, path: string, mode: "read" | "write", ctx: ExtensionToolContext, signal?: AbortSignal) => {
    const absolute = await factoryPath(path, ctx.cwd || cwd, mode, ctx, signal);
    return store.paths.classify(absolute, ctx.cwd || cwd);
  };
  const memoryRoot = () => lexicalMemoryRoot(options.agentDir);
  const degraded = async (path: string, mode: "read" | "write", ctx: ExtensionToolContext, cause: unknown, signal?: AbortSignal): Promise<DegradedRoute> => {
    const outcome = await degradedRoute(memoryRoot(), path, ctx.cwd || cwd, mode, ctx, signal);
    if (outcome !== "ordinary") throw degradedMemoryError(cause);
    return outcome;
  };

  const confirmPath = async (store: MemoryStore, actual: string, expected: string) => {
    if (await store.paths.assertCurrent(actual) !== expected) throw new Error("Memory target changed during tool execution; reread and retry.");
  };

  const read: typeof host.read = {
    ...host.read,
    async execute(id, params, signal, update, ctx) {
      let store: MemoryStore;
      try { store = await obtain(ctx); }
      catch (error) {
        await degraded(params.path, "read", ctx, error, signal);
        return host.read.execute(id, params, signal, update, ctx);
      }
      const target = await route(store, params.path, "read", ctx, signal);
      if (target.kind === "ordinary") return host.read.execute(id, params, signal, update, ctx);
      const observe = store.observe();
      let observed: Awaited<ReturnType<MemoryStore["readBuffer"]>> | undefined;
      const factory = createReadToolDefinition(cwd, { operations: {
        access: async (actual) => { await confirmPath(store, actual, target.path); await store.access(actual); },
        readFile: async (actual) => {
          await confirmPath(store, actual, target.path);
          observed = await store.readBuffer(actual);
          return observed.buffer;
        },
      } });
      try {
        const result = await factory.execute(id, params, signal, update, ctx);
        if (observed) {
          store.assertLifecycle(observed.generation);
          const [start, end] = returnedReadRange(observed.buffer, params, result);
          store.recordRange(observed.path, observed.buffer, start, end, observed.generation);
          if (!result.isError && end > start) observe({ kind: "read", path: observed.path,
            digest: digest(observed.buffer), length: observed.buffer.length, start, end });
        }
        return result;
      } catch (error) { throw managedError(error); }
    },
  };

  const write: typeof host.write = {
    ...host.write,
    async execute(id, params, signal, update, ctx) {
      let store: MemoryStore;
      try { store = await obtain(ctx); }
      catch (error) {
        await degraded(params.path, "write", ctx, error, signal);
        return host.write.execute(id, params, signal, update, ctx);
      }
      const target = await route(store, params.path, "write", ctx, signal);
      if (target.kind === "ordinary") return host.write.execute(id, params, signal, update, ctx);
      let saved: Save | undefined;
      try {
        const result = await store.mutate(target.path, (file) => {
          const factory = createWriteToolDefinition(cwd, { operations: {
            mkdir: async () => {},
            writeFile: async (actual, content) => { await confirmPath(store, actual, file.path); saved = await file.write(content); },
          } });
          return factory.execute(id, params, signal, update, ctx);
        });
        if (!saved) throw new Error("Memory factory did not commit a file.");
        return savedToolResult(result, saved, target.path);
      } catch (error) {
        if (saved) return { content: [{ type: "text", text: `${saved.note} ${saveTiming(target.path)} The file IS SAVED, but the host operation did not finish normally; reread before retrying.` }], details: undefined, isError: true };
        throw managedError(error);
      }
    },
  };

  const edit: typeof host.edit = {
    ...host.edit,
    async execute(id, params, signal, update, ctx) {
      let store: MemoryStore;
      try { store = await obtain(ctx); }
      catch (error) {
        await degraded(params.path, "write", ctx, error, signal);
        return host.edit.execute(id, params, signal, update, ctx);
      }
      const target = await route(store, params.path, "write", ctx, signal);
      if (target.kind === "ordinary") return host.edit.execute(id, params, signal, update, ctx);
      let saved: Save | undefined;
      try {
        const result = await store.mutate(target.path, (file) => {
          const factory = createEditToolDefinition(cwd, { operations: {
            access: async (actual) => { await confirmPath(store, actual, file.path); if (!file.buffer) throw new Error("Missing memory target"); },
            readFile: async (actual) => { await confirmPath(store, actual, file.path); return file.buffer!; },
            writeFile: async (actual, content) => { await confirmPath(store, actual, file.path); saved = await file.write(content); },
          } });
          return factory.execute(id, params, signal, update, ctx);
        });
        if (!saved) throw new Error("Memory factory did not commit a file.");
        return savedToolResult(result, saved, target.path);
      } catch (error) {
        if (saved) return { content: [{ type: "text", text: `${saved.note} ${saveTiming(target.path)} The file IS SAVED, but the host operation did not finish normally; reread before retrying.` }], details: undefined, isError: true };
        throw managedError(error);
      }
    },
  };
  return { read, write, edit };
}
