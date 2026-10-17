import { createHash } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { atomicReplace, type AtomicHooks } from "./atomic-file.js";
import { MemoryConfig, type ConfigState } from "./config.js";
import { prepareContent, savedResult } from "./content-policy.js";
import { withLock } from "./locks.js";
import { MemoryPaths } from "./paths.js";

type Range = [number, number];
interface ReadVersion { digest: string; length: number; ranges: Range[] }
export interface LockedFile {
  path: string;
  buffer: Buffer | undefined;
  write(text: string): Promise<ReturnType<typeof savedResult>>;
}
export interface DeleteTarget { readonly path: string }
export type MemoryActivityEvent =
  | { kind: "save" | "delete"; path: string }
  | { kind: "read"; path: string; digest: string; length: number; start: number; end: number };
export interface MemoryObservation {
  capture(source: "model" | "user"): (event: MemoryActivityEvent) => void;
}

async function metadataVersion(path: string): Promise<string> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Memory delete rejected: target must be a regular file.");
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(":");
}

export function digest(buffer: Buffer): string { return createHash("sha256").update(buffer).digest("hex"); }

export class MemoryStore {
  private versions = new Map<string, ReadVersion>();
  private generation = 0;
  private retired = false;
  private identityUnverified = false;
  private deleteTargets = new WeakMap<DeleteTarget, { version: string; generation: number }>();
  readonly projectAnchor: string;
  private readonly ownerGeneration: number | undefined;
  constructor(readonly paths: MemoryPaths, readonly config: MemoryConfig, readonly child = process.env.PI_SUBAGENT_CHILD === "1", private readonly lifecycleOwner?: MemoryStore, private readonly checkRuntime?: () => void, private readonly observation?: MemoryObservation, private readonly source: "model" | "user" = "model") {
    this.ownerGeneration = lifecycleOwner?.generation;
    this.projectAnchor = join(config.agentDir, `.auto-memory-${paths.projectDir.split(/[\\/]/).pop()}-lock`);
  }
  markIdentityUnverified(): void { this.identityUnverified = true; }
  get projectLocationTrusted(): boolean { return !this.identityUnverified; }
  fork(source: "model" | "user" = this.source): MemoryStore {
    const born = new MemoryStore(this.paths, this.config, this.child, this, undefined, this.observation, source);
    if (this.identityUnverified) born.markIdentityUnverified();
    return born;
  }
  observe(): (event: MemoryActivityEvent) => void {
    let record: ((event: MemoryActivityEvent) => void) | undefined;
    try { record = this.observation?.capture(this.source); } catch {}
    return (event) => { try { record?.(event); } catch {} };
  }
  invalidate(): void { this.generation++; this.versions.clear(); }
  retire(): void { this.retired = true; this.invalidate(); }
  assertLifecycle(generation = this.generation): void {
    this.checkRuntime?.();
    this.lifecycleOwner?.assertLifecycle(this.ownerGeneration);
    if (this.retired || generation !== this.generation
      || (this.lifecycleOwner && (this.lifecycleOwner.retired || this.lifecycleOwner.generation !== this.ownerGeneration))) {
      throw new Error("Memory operation invalidated by a session change; reread and retry.");
    }
  }
  private checkState(state: ConfigState, generation = this.generation): void {
    if (this.child) throw new Error("Memory unavailable: runner child is unsupported.");
    this.assertLifecycle(generation);
    if (state.status === "unknown") throw new Error(state.fault);
    if (!state.enabled) throw new Error("Memory is off; managed body access and saves are rejected.");
  }
  async access(path: string): Promise<string> {
    const generation = this.generation;
    this.checkState(await this.config.read(), generation);
    const target = await this.paths.assertCurrent(path);
    this.assertLifecycle(generation);
    return target;
  }
  async readBuffer(path: string): Promise<{ path: string; buffer: Buffer; generation: number }> {
    const generation = this.generation;
    const target = await this.access(path);
    this.assertLifecycle(generation);
    let buffer: Buffer;
    try { buffer = await readFile(target); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && generation === this.generation) this.versions.delete(target);
      throw err;
    }
    this.checkState(await this.config.read(), generation);
    return { path: target, buffer, generation };
  }
  recordRange(path: string, buffer: Buffer, start: number, end: number, generation = this.generation): void {
    if (this.retired || generation !== this.generation || this.lifecycleOwner?.retired) return;
    if (start < 0 || end < start || end > buffer.length) throw new Error("Invalid memory read coverage.");
    const hash = digest(buffer);
    let version = this.versions.get(path);
    if (!version || version.digest !== hash) version = { digest: hash, length: buffer.length, ranges: [] };
    const ranges = [...version.ranges, [start, end] as Range].sort((a, b) => a[0] - b[0]);
    const merged: Range[] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    version.ranges = merged;
    this.versions.set(path, version);
  }
  async readFull(path: string): Promise<string> {
    const result = await this.readBuffer(path);
    this.recordRange(result.path, result.buffer, 0, result.buffer.length, result.generation);
    return result.buffer.toString("utf8");
  }
  private baseline(version: ReadVersion | undefined, current: Buffer | undefined): void {
    if (!current) {
      if (version) throw new Error("Memory conflict: file was removed; reread and retry.");
      return;
    }
    if (version && version.digest !== digest(current)) throw new Error("Memory conflict: stale version; reread the complete file and retry.");
    if (!version || version.ranges.length !== 1 || version.ranges[0][0] !== 0 || version.ranges[0][1] !== current.length) {
      throw new Error("Memory save rejected: no complete read baseline; read all remaining ranges, then retry.");
    }
  }
  async mutate<T>(path: string, action: (file: LockedFile) => Promise<T>, hooks: AtomicHooks = {}): Promise<T> {
    const generation = this.generation;
    const observe = this.observe();
    const target = await this.paths.assertCurrent(path);
    const baseline = this.versions.get(target);
    const expected = baseline ? { ...baseline, ranges: baseline.ranges.map((range) => [...range] as Range) } : undefined;
    return this.config.locked(async (state, configLease) => {
      this.checkState(state, generation);
      return withLock(this.projectAnchor, async (projectLease) => {
        await this.paths.assertCurrent(target);
        this.checkState(state, generation);
        let current: Buffer | undefined;
        try { current = await readFile(target); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
        this.baseline(expected, current);
        let wrote = false;
        const file: LockedFile = {
          path: target, buffer: current,
          write: async (text) => {
            if (wrote) throw new Error("Memory operation attempted more than one commit.");
            this.checkState(state, generation);
            await this.paths.ensurePrivateParent(target);
            const final = prepareContent(text);
            await atomicReplace(target, final, {
              ...hooks,
              beforeRename: async () => {
                await hooks.beforeRename?.();
                await this.paths.assertCurrent(target);
                configLease.check(); projectLease.check(); this.checkState(state, generation);
              },
            });
            wrote = true;
            observe({ kind: "save", path: target });
            const buffer = Buffer.from(final, "utf8");
            this.recordRange(target, buffer, 0, buffer.length, generation);
            return savedResult(target, final);
          },
        };
        return action(file);
      });
    });
  }
  private checkDeleteState(state: ConfigState, generation: number): void {
    if (this.child) throw new Error("Memory unavailable: runner child is unsupported.");
    try { this.assertLifecycle(generation); }
    catch { throw new Error("Memory delete invalidated by a session change; confirm again."); }
    if (state.status === "unknown") throw new Error(state.fault);
  }
  async prepareDelete(path: string): Promise<DeleteTarget> {
    const generation = this.generation;
    this.checkDeleteState(await this.config.read(), generation);
    const target = Object.freeze({ path: await this.paths.assertCurrent(path) });
    this.deleteTargets.set(target, { version: await metadataVersion(target.path), generation });
    return target;
  }
  async deleteConfirmed(target: DeleteTarget, confirmed: boolean): Promise<{ deleted: boolean }> {
    const observe = this.observe();
    const expected = this.deleteTargets.get(target);
    this.deleteTargets.delete(target);
    if (!confirmed) return { deleted: false };
    if (!expected) throw new Error("Memory delete rejected: prepare and confirm the exact target again.");
    return this.config.locked(async (state, configLease) => {
      this.checkDeleteState(state, expected.generation);
      return withLock(this.projectAnchor, async (projectLease) => withFileMutationQueue(target.path, async () => {
        await this.paths.assertCurrent(target.path);
        let current: string;
        try { current = await metadataVersion(target.path); }
        catch { throw new Error("Memory delete conflict: target changed or disappeared; confirm again."); }
        if (current !== expected.version) throw new Error("Memory delete conflict: target changed; confirm again.");
        configLease.check(); projectLease.check(); this.checkDeleteState(state, expected.generation);
        await unlink(target.path);
        observe({ kind: "delete", path: target.path });
        this.versions.delete(target.path);
        return { deleted: true };
      }));
    });
  }
  async write(path: string, text: string, hooks: AtomicHooks = {}) {
    return this.mutate(path, (file) => withFileMutationQueue(file.path, () => file.write(text)), hooks);
  }
}
