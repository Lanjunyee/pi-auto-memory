import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../src/pi/commands.js";
import { sessionStoreProvider } from "../src/pi/registration.js";
import { MemoryStore } from "../src/core/store.js";
import { makeStore } from "./helpers/store.js";
import { MemoryActivity } from "../src/pi/activity.js";

const paused = () => { throw new Error("Memory paused: incompatible same-name tool override (write); disable the conflicting extension and fully reload extensions."); };

async function runtimeProvider(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  let conflict = false;
  const provider = sessionStoreProvider(join(root, "agent"), () => { if (conflict) paused(); });
  const ctx = { cwd: root, hasUI: false } as ExtensionCommandContext;
  const owner = await provider.obtain(ctx);
  return { root, ctx, owner, clash: () => { conflict = true; }, clear: () => { conflict = false; } };
}

test("a runtime conflict fails the owner draft and derived-store saves before any bytes land", async (t) => {
  const f = await runtimeProvider(t, "auto-memory-runtime-draft-");
  const path = join(f.owner.paths.projectDir, "topic.md");
  await f.owner.write(path, "original");
  const editor = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child, f.owner);
  const draft = join(f.owner.paths.projectDir, "new.md");
  await editor.readFull(path);
  f.clash();
  await assert.rejects(editor.write(draft, "late draft"), /Memory paused/);
  await assert.rejects(editor.write(path, "late overwrite"), /Memory paused/);
  await assert.rejects(editor.readFull(path), /Memory paused/);
  await assert.rejects(readFile(draft), { code: "ENOENT" });
  assert.equal(await readFile(path, "utf8"), "original");
});

test("a stored read baseline is refreshed and reused while a retired owner and mirror clone never reach disk", async (t) => {
  const f = await runtimeProvider(t, "auto-memory-runtime-stale-");
  const path = join(f.owner.paths.projectDir, "topic.md");
  await f.owner.write(path, "original");
  const editor = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child, f.owner);
  await editor.readFull(path);
  await editor.write(path, "editor commit");
  assert.equal(await readFile(path, "utf8"), "editor commit");
  const clone = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child, f.owner);
  await clone.readFull(path);
  f.owner.retire();
  f.clash();
  await assert.rejects(clone.write(path, "clone after retire"), /Memory paused/);
  await assert.rejects(clone.readFull(path), /Memory paused/);
  assert.equal(await readFile(path, "utf8"), "editor commit");
  const fresh = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child);
  await fresh.readFull(path);
  await fresh.write(path, "read after conflict");
  assert.equal(await readFile(path, "utf8"), "read after conflict");
});

test("a draft waiting for the config lock is rejected once the runtime pauses, and a fresh owner still works", async (t) => {
  const f = await runtimeProvider(t, "auto-memory-runtime-lock-");
  const path = join(f.owner.paths.projectDir, "topic.md");
  await f.owner.write(path, "original");
  const editor = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child, f.owner);
  await editor.readFull(path);
  let released!: () => void;
  let queued!: () => void;
  const waiting = new Promise<void>((resolve) => { queued = resolve; });
  const gate = new Promise<void>((resolve) => { released = resolve; });
  const locked = editor.config.locked.bind(editor.config);
  let first = true;
  const mock = t.mock.method(editor.config, "locked", async (...args: Parameters<typeof locked>) => {
    if (first) { first = false; queued(); await gate; }
    return locked(...args);
  });
  const pending = editor.write(path, "queued draft");
  const rejected = assert.rejects(pending, /Memory paused/);
  await waiting;
  f.clash();
  released();
  await rejected;
  mock.mock.restore();
  assert.equal(await readFile(path, "utf8"), "original");
  const replacement = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child);
  await replacement.readFull(path);
  await replacement.write(path, "after queued conflict");
  assert.equal(await readFile(path, "utf8"), "after queued conflict");
});

test("a commit aborts when the runtime pauses before its rename, and a later editor can still save a fresh state", async (t) => {
  const f = await runtimeProvider(t, "auto-memory-runtime-rename-");
  const path = join(f.owner.paths.projectDir, "topic.md");
  await f.owner.write(path, "original");
  const editor = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child, f.owner);
  await editor.readFull(path);
  let armed = true;
  const pending = editor.write(path, "before rename", {
    beforeRename: async () => { if (armed) { armed = false; f.clash(); } },
  });
  await assert.rejects(pending, /Memory paused/);
  assert.equal(await readFile(path, "utf8"), "original");
  assert.equal((await readdir(f.owner.paths.projectDir)).some((name) => name.endsWith(".tmp")), false);
  const later = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child);
  await later.readFull(path);
  await later.write(path, "fresh later save");
  assert.equal(await readFile(path, "utf8"), "fresh later save");
});

test("a completed commit keeps the file when the runtime pauses afterwards, while later operations reject", async (t) => {
  const f = await runtimeProvider(t, "auto-memory-runtime-abort-");
  const path = join(f.owner.paths.projectDir, "topic.md");
  await f.owner.write(path, "original");
  const editor = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child, f.owner);
  await editor.readFull(path);
  const result = await editor.write(path, "committed before conflict");
  assert.equal(result.saved, true);
  f.clash();
  assert.equal(await readFile(path, "utf8"), "committed before conflict");
  await assert.rejects(editor.write(join(f.owner.paths.projectDir, "later.md"), "after conflict"), /Memory paused/);
});

test("a queued delete aborts at the config lock and at the host file queue while a pre-packaged delete never unlinks", async (t) => {
  const f = await runtimeProvider(t, "auto-memory-runtime-delete-");
  const path = join(f.owner.paths.projectDir, "topic.md");
  await f.owner.write(path, "original");
  const configGate = { reached: () => {}, released: () => {} };
  const target = await f.owner.prepareDelete(path);
  const configLocked = f.owner.config.locked.bind(f.owner.config);
  const configWaiting = new Promise<void>((resolve) => { configGate.reached = resolve; });
  const configBarrier = new Promise<void>((resolve) => { configGate.released = resolve; });
  t.mock.method(f.owner.config, "locked", async (...args: Parameters<typeof configLocked>) => {
    configGate.reached();
    await configBarrier;
    return configLocked(...args);
  });
  const first = f.owner.deleteConfirmed(target, true);
  const firstRejected = assert.rejects(first, /session change; confirm again/);
  await configWaiting;
  f.clash();
  configGate.released();
  await firstRejected;
  assert.equal(await readFile(path, "utf8"), "original");
  t.mock.reset();
  f.clear();
  const queuedTarget = await f.owner.prepareDelete(path);
  const queueGate = { entered: () => {}, release: () => {} };
  const entered = new Promise<void>((resolve) => { queueGate.entered = resolve; });
  const release = new Promise<void>((resolve) => { queueGate.release = resolve; });
  const holder = withFileMutationQueue(path, async () => { queueGate.entered(); await release; });
  await entered;
  let reachedFinalCheck!: () => void;
  let releaseFinalCheck!: () => void;
  const finalCheck = new Promise<void>((resolve) => { reachedFinalCheck = resolve; });
  const finalGate = new Promise<void>((resolve) => { releaseFinalCheck = resolve; });
  const assertCurrent = f.owner.paths.assertCurrent.bind(f.owner.paths);
  t.mock.method(f.owner.paths, "assertCurrent", async (...args: Parameters<typeof assertCurrent>) => {
    const result = await assertCurrent(...args);
    reachedFinalCheck();
    await finalGate;
    return result;
  });
  const second = f.owner.deleteConfirmed(queuedTarget, true);
  const secondRejected = assert.rejects(second, /session change; confirm again/);
  queueGate.release();
  await holder;
  await finalCheck;
  f.clash();
  releaseFinalCheck();
  await secondRejected;
  assert.equal(await readFile(path, "utf8"), "original");
  t.mock.reset();
  f.clear();
  const seeded = await f.owner.prepareDelete(path);
  f.clash();
  await assert.rejects(f.owner.deleteConfirmed(seeded, true), /session change; confirm again/);
  assert.equal(await readFile(path, "utf8"), "original");
});

test("a conflict between the two checks of one managed read rejects the read and leaves the file untouched", async (t) => {
  const f = await runtimeProvider(t, "auto-memory-runtime-readcheck-");
  const path = join(f.owner.paths.projectDir, "topic.md");
  await f.owner.write(path, "original");
  const editor = new MemoryStore(f.owner.paths, f.owner.config, f.owner.child, f.owner);
  let reads = 0;
  const read = editor.config.read.bind(editor.config);
  t.mock.method(editor.config, "read", async () => {
    reads += 1;
    if (reads === 2) f.clash();
    return read();
  });
  await assert.rejects(editor.readFull(path), /Memory paused/);
  assert.equal(reads >= 2, true);
  await assert.rejects(editor.write(path, "after read conflict"), /Memory paused/);
  assert.equal(await readFile(path, "utf8"), "original");
});

test("owner invalidation is permanent for a draft, including missing targets; new editor has separate coverage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = await makeStore(root);
  const path = join(owner.paths.projectDir, "topic.md");
  await owner.write(path, "original");
  const editor = new MemoryStore(owner.paths, owner.config, owner.child, owner);
  await editor.readFull(path);
  const missing = join(owner.paths.projectDir, "new.md");
  owner.invalidate();
  editor.invalidate();
  await assert.rejects(editor.readFull(path), /invalidated by a session change/);
  await assert.rejects(editor.write(path, "old draft"), /invalidated by a session change/);
  await assert.rejects(editor.write(missing, "old new draft"), /invalidated by a session change/);
  await assert.rejects(readFile(missing), { code: "ENOENT" });
  assert.equal(await readFile(path, "utf8"), "original");
  const fresh = new MemoryStore(owner.paths, owner.config, owner.child, owner);
  await fresh.readFull(path);
  await fresh.write(path, "fresh draft");
  await assert.rejects(owner.write(path, "unseen fresh draft"), /no complete read baseline/);
});

test("retirement permanently rejects body access, commits, deletion and newly created owner-bound clones", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-retired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = await makeStore(root);
  const path = join(owner.paths.projectDir, "topic.md");
  await owner.write(path, "original");
  const target = await owner.prepareDelete(path);
  owner.retire();
  owner.invalidate();
  await assert.rejects(owner.readFull(path), /invalidated by a session change/);
  await assert.rejects(owner.write(join(owner.paths.projectDir, "new.md"), "old request"), /invalidated by a session change/);
  await owner.config.setEnabled(false);
  await assert.rejects(owner.prepareDelete(path), /session change; confirm again/);
  await assert.rejects(owner.deleteConfirmed(target, true), /session change; confirm again/);
  await owner.config.setEnabled(true);
  const clone = new MemoryStore(owner.paths, owner.config, owner.child, owner);
  await assert.rejects(clone.readFull(path), /invalidated by a session change/);
  await assert.rejects(clone.prepareDelete(path), /session change; confirm again/);
  assert.equal(await readFile(path, "utf8"), "original");
});

test("reload rejects a draft waiting for the config lock and releases locks for a fresh editor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-owner-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = sessionStoreProvider(join(root, "agent"));
  const ctx = { cwd: root, hasUI: false } as ExtensionCommandContext;
  const owner = await provider.obtain(ctx);
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const reports: string[] = [];
  registerCommands({ registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
    sendMessage: (message: { content: string }) => reports.push(message.content),
  } as unknown as ExtensionAPI, { getStore: (context) => provider.obtain(context), reset: () => provider.reset() });
  const path = join(owner.paths.projectDir, "topic.md");
  await owner.write(path, "original");
  const editor = new MemoryStore(owner.paths, owner.config, owner.child, owner);
  await editor.readFull(path);
  let rejected!: Promise<void>;
  await owner.config.locked(async () => {
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const locked = editor.config.locked.bind(editor.config);
    const mock = t.mock.method(editor.config, "locked", (...args: Parameters<typeof locked>) => {
      reached();
      return locked(...args);
    });
    const pending = editor.write(path, "waiting draft");
    rejected = assert.rejects(pending, /invalidated by a session change/);
    await waiting;
    await command("reload", ctx);
    assert.match(reports.at(-1)!, /记忆快照已重置/);
    mock.mock.restore();
  });
  await rejected;
  assert.equal(await readFile(path, "utf8"), "original");
  const freshOwner = await provider.obtain(ctx);
  assert.notEqual(freshOwner, owner);
  await assert.rejects(freshOwner.write(path, "unseen overwrite"), /no complete read baseline/);
  const fresh = new MemoryStore(freshOwner.paths, freshOwner.config, freshOwner.child, freshOwner);
  await fresh.readFull(path);
  await fresh.write(path, "fresh after lock");
  assert.equal(await readFile(path, "utf8"), "fresh after lock");
  assert.equal((await readdir(owner.paths.projectDir)).some((name) => name.endsWith(".tmp")), false);
});


test("activity history survives refresh without reviving owner-bound drafts or model baselines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-activity-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activity = new MemoryActivity();
  const provider = sessionStoreProvider(join(root, "agent"), undefined, activity);
  const ctx = { cwd: root } as ExtensionCommandContext;
  const owner = await provider.obtain(ctx);
  const path = join(owner.paths.projectDir, "topic.md");
  await owner.write(path, "original");
  const draft = owner.fork("user");
  await draft.readFull(path);
  activity.reset("refresh");
  provider.reset();
  assert.equal(activity.snapshot().lastSave!.path, "topic.md");
  await assert.rejects(draft.write(path, "stale"), /invalidated by a session change/);
  const current = await provider.obtain(ctx);
  await assert.rejects(current.write(path, "history does not authorize"), /no complete read baseline/);
  assert.equal(await readFile(path, "utf8"), "original");
});
