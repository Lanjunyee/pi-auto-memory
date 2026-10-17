import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore, type LockedFile } from "../src/core/store.js";
import type { AtomicHooks } from "../src/core/atomic-file.js";
import { MemoryActivity } from "../src/pi/activity.js";
import { managedFileTools } from "../src/pi/tools.js";
import { makeStore } from "./helpers/store.js";

test("actual commits and returned model reads are distinct from user inspection and write coverage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-activity-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = await makeStore(join(root, "agent"));
  const activity = new MemoryActivity(() => new Date(0));
  const store = new MemoryStore(base.paths, base.config, false, undefined, undefined, activity.bind(base.paths.projectDir));
  const path = join(store.paths.projectDir, "topic.md");
  const index = join(store.paths.projectDir, "MEMORY.md");
  const ctx = { cwd: root } as ExtensionToolContext;
  const tools = managedFileTools(root, store);
  await tools.write.execute("save", { path, content: "first\nsecond\n" }, undefined, undefined, ctx);
  assert.equal(activity.snapshot().lastSave!.path, "topic.md");
  assert.equal(activity.snapshot().lastSave!.source, "model");
  assert.equal(activity.snapshot().topics.length, 0);
  const draft = store.fork("user");
  await draft.readFull(path);
  assert.equal(activity.snapshot().topics.length, 0);
  await draft.write(path, "first\nsecond\n");
  assert.equal(activity.snapshot().lastSave!.source, "user");
  await tools.read.execute("partial", { path, offset: 1, limit: 1 }, undefined, undefined, ctx);
  assert.equal(activity.snapshot().topics[0].complete, false);
  await tools.read.execute("remaining", { path, offset: 2, limit: 1 }, undefined, undefined, ctx);
  assert.equal(activity.snapshot().topics[0].complete, true);
  await writeFile(path, "changed\nversion\n");
  await tools.read.execute("changed", { path, limit: 1 }, undefined, undefined, ctx);
  assert.equal(activity.snapshot().topics[0].complete, false);
  activity.prepared(false);
  const saved = await tools.write.execute("index", { path: index, content: "index" }, undefined, undefined, ctx);
  assert.match(JSON.stringify(saved), /下一条用户任务/);
  assert.equal(activity.snapshot().changed, true);
  await tools.read.execute("index-baseline", { path: index }, undefined, undefined, ctx);
  const oversized = await tools.write.execute("large-index", { path: index, content: "line\n".repeat(201) }, undefined, undefined, ctx);
  assert.equal(oversized.isError, true);
  assert.match(JSON.stringify(oversized), /file IS SAVED/);
  assert.equal(activity.snapshot().lastSave!.path, "MEMORY.md");
  assert.equal(activity.snapshot().changed, true);
  const lastSave = activity.snapshot().lastSave;
  await assert.rejects(tools.write.execute("secret", { path: join(store.paths.projectDir, "rejected.md"), content: "-----BEGIN PRIVATE KEY-----" }, undefined, undefined, ctx));
  assert.deepEqual(activity.snapshot().lastSave, lastSave);
  const target = await store.prepareDelete(index);
  await store.deleteConfirmed(target, false);
  assert.equal(await readFile(index, "utf8"), "line\n".repeat(201));
  activity.prepared(false);
  await store.deleteConfirmed(await store.prepareDelete(index), true);
  assert.equal(activity.snapshot().changed, true);
  await writeFile(path, "a".repeat(60 * 1024));
  activity.reset();
  await tools.read.execute("long-line", { path }, undefined, undefined, ctx);
  assert.equal(activity.snapshot().topics.length, 0);
});

test("observer exceptions cannot turn a completed commit into a failed save", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-observer-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = await makeStore(join(root, "agent"));
  const store = new MemoryStore(base.paths, base.config, false, undefined, undefined,
    { capture: () => () => { throw new Error("observer failed"); } });
  const path = join(store.paths.projectDir, "topic.md");
  const saved = await store.write(path, "committed");
  assert.equal(saved.saved, true);
  assert.equal(await readFile(path, "utf8"), "committed");
  await store.deleteConfirmed(await store.prepareDelete(path), true);
});


test("a commit remains observable when host cancellation happens after replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-activity-post-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = await makeStore(join(root, "agent"));
  const activity = new MemoryActivity();
  const store = new MemoryStore(base.paths, base.config, false, undefined, undefined, activity.bind(base.paths.projectDir));
  const abort = new AbortController();
  const mutate = store.mutate.bind(store);
  store.mutate = async function<T>(path: string, action: (file: LockedFile) => Promise<T>, hooks: AtomicHooks = {}): Promise<T> {
    return mutate(path, (file) => action({ ...file, write: async (text) => {
      const saved = await file.write(text);
      abort.abort();
      return saved;
    } }), hooks);
  };
  const path = join(store.paths.projectDir, "saved.md");
  const result = await managedFileTools(root, store).write.execute("cancelled", { path, content: "committed" }, abort.signal, undefined, { cwd: root } as ExtensionToolContext);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /file IS SAVED/);
  assert.equal(activity.snapshot().lastSave!.path, "saved.md");
  assert.equal(await readFile(path, "utf8"), "committed");
});
