import { lstat, readdir } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { createLsToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { contains } from "../core/paths.js";
import type { MemoryStore } from "../core/store.js";

export function checkScanAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

export async function scanPath(path: string | undefined, cwd: string, ctx: ExtensionToolContext, signal?: AbortSignal): Promise<string> {
  let absolute: string | undefined;
  let error: unknown;
  await createLsToolDefinition(cwd, { operations: {
    exists: async (actual) => { absolute = actual; throw new Error("scan path probe complete"); },
    stat: lstat,
    readdir: async () => { throw new Error("Unexpected scan path enumeration"); },
  } }).execute("memory-scan-path-probe", { path }, signal, undefined, ctx).catch((err) => { error = err; });
  if (!absolute) throw error ?? new Error("Memory scan path resolution failed.");
  return absolute;
}

export interface ScanPolicy {
  root: string;
  overlapping: boolean;
  empty: boolean;
  excluded: string[];
}

export async function scanPolicy(store: MemoryStore, requested: string, cwd: string, signal?: AbortSignal): Promise<ScanPolicy> {
  checkScanAbort(signal);
  const target = await store.paths.classify(requested, cwd);
  const root = target.path;
  const memory = store.paths.memoryRoot;
  const ancestor = contains(root, memory);
  const overlapping = target.kind === "memory" || ancestor;
  const policy: ScanPolicy = { root, overlapping, empty: false, excluded: [] };
  if (!overlapping) return policy;
  store.assertLifecycle();
  if (target.kind === "memory" && root !== memory) {
    await store.access(root);
    return policy;
  }
  const state = await store.config.read();
  const enabled = !store.child && state.status !== "unknown" && state.enabled;
  if (!enabled) {
    if (root === memory) policy.empty = true;
    else policy.excluded.push(memory);
    return policy;
  }
  let entries;
  try {
    if ((await lstat(memory)).isSymbolicLink()) {
      policy.excluded.push(memory);
      return policy;
    }
    entries = await readdir(memory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return policy;
  }
  const current = basename(store.paths.projectDir);
  for (const entry of entries) {
    if (entry.name !== current || entry.isSymbolicLink()) policy.excluded.push(join(memory, entry.name));
  }
  checkScanAbort(signal);
  return policy;
}

export async function excludeMemoryLinks(store: MemoryStore, policy: ScanPolicy, signal?: AbortSignal): Promise<void> {
  const project = store.paths.projectDir;
  if (policy.empty || policy.excluded.some((path) => contains(path, project))) return;
  const start = contains(project, policy.root) ? policy.root : project;
  async function walk(path: string): Promise<void> {
    checkScanAbort(signal);
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) policy.excluded.push(child);
      else if (entry.isDirectory()) await walk(child);
    }
  }
  store.assertLifecycle();
  await walk(start);
  store.assertLifecycle();
}

export function escapeScanGlob(path: string): string {
  return path.split(sep).join("/").replace(/[\\\[\]*?{}!]/g, "\\$&");
}
