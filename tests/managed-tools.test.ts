import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionToolContext, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { managedFileTools, standardFileTools } from "../src/pi/tools.js";
import type { LockedFile } from "../src/core/store.js";
import type { AtomicHooks } from "../src/core/atomic-file.js";
import { makeStore } from "./helpers/store.js";

test("managed wrappers preserve ordinary schema, renderers, preparation, output, errors and text bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-diff-"));
  try {
    const store = await makeStore(join(root, "agent"));
    await store.config.setEnabled(false);
    const adapted = managedFileTools(root, store);
    const host = standardFileTools(root);
    const ctx = { cwd: root } as ExtensionToolContext;
    for (const name of ["read", "write", "edit"] as const) {
      assert.equal(adapted[name].name, host[name].name);
      assert.deepEqual(adapted[name].parameters, host[name].parameters);
      assert.equal(adapted[name].renderCall, host[name].renderCall);
      assert.equal(adapted[name].renderResult, host[name].renderResult);
      assert.equal(adapted[name].prepareArguments, host[name].prepareArguments);
    }
    const secret = `sk-proj-${"SYNTHETIC1234".repeat(4)}`;
    const text = `\uFEFF---\r\ntype: feedback\r\n---\r\nalpha\r\n${secret}\r\n`;
    const run = async (tools: typeof host) => {
      const write = await tools.write.execute("w", { path: "ordinary.md", content: text }, undefined, undefined, ctx);
      const read = await tools.read.execute("r", { path: "ordinary.md", offset: 2, limit: 1 }, undefined, undefined, ctx);
      const edit = await tools.edit.execute("e", { path: "ordinary.md", edits: [{ oldText: "alpha", newText: "beta" }] }, undefined, undefined, ctx);
      const bytes = await readFile(join(root, "ordinary.md"));
      const error = await tools.edit.execute("bad", { path: "ordinary.md", edits: [{ oldText: "absent", newText: "x" }] }, undefined, undefined, ctx).catch((error: Error) => error.message);
      const missing = await tools.read.execute("missing", { path: "missing.md" }, undefined, undefined, ctx).catch((error: Error) => error.message);
      const invalidParent = await tools.read.execute("parent", { path: "ordinary.md/child" }, undefined, undefined, ctx).catch((error: Error) => error.message);
      return { write, read, edit, bytes, error, missing, invalidParent };
    };
    assert.deepEqual(await run(adapted), await run(host));
    await writeFile(join(root, "large.txt"), Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n"));
    assert.deepEqual(await adapted.read.execute("r", { path: "large.txt" }, undefined, undefined, ctx), await host.read.execute("r", { path: "large.txt" }, undefined, undefined, ctx));
    await writeFile(join(root, "cafe\u0301.txt"), "normalized filename");
    assert.deepEqual(await adapted.read.execute("r", { path: "@café.txt" }, undefined, undefined, ctx), await host.read.execute("r", { path: "@café.txt" }, undefined, undefined, ctx));
    const abort = new AbortController(); abort.abort();
    assert.equal(
      await adapted.write.execute("w", { path: "abort.md", content: "x" }, abort.signal, undefined, ctx).catch((error: Error) => error.message),
      await host.write.execute("w", { path: "abort.md", content: "x" }, abort.signal, undefined, ctx).catch((error: Error) => error.message),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a managed read rejects a runtime conflict after body IO before returning text or granting coverage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-read-revocation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await makeStore(join(root, "agent"));
  const path = join(store.paths.projectDir, "topic.md");
  await store.write(path, "synthetic private body");
  store.invalidate();
  const readBuffer = store.readBuffer.bind(store);
  t.mock.method(store, "readBuffer", async (...args: Parameters<typeof readBuffer>) => {
    const result = await readBuffer(...args);
    store.retire();
    return result;
  });
  const tools = managedFileTools(root, store);
  const ctx = { cwd: root } as ExtensionToolContext;
  await assert.rejects(tools.read.execute("read", { path }, undefined, undefined, ctx), /invalidated by a session change/);
  await assert.rejects(store.write(path, "old response"), /invalidated by a session change/);
  assert.equal(await readFile(path, "utf8"), "synthetic private body");
  const ordinary = join(root, "ordinary.md");
  await writeFile(ordinary, "ordinary body");
  const result = await tools.read.execute("ordinary", { path: ordinary }, undefined, undefined, ctx);
  assert.match(JSON.stringify(result), /ordinary body/);
});

test("memory write/edit validate final text and preserve old bytes on secret or malformed metadata rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-commit-"));
  try {
    const store = await makeStore(join(root, "agent"));
    const tools = managedFileTools(root, store);
    const ctx = { cwd: root } as ExtensionToolContext;
    const path = join(store.paths.projectDir, "topic.md");
    const text = "\uFEFF---\r\ntype: feedback\r\nreference: keep\r\n---\r\nalpha\r\nbeta\r\n";
    const first = await tools.write.execute("w", { path, content: text }, undefined, undefined, ctx);
    assert.match(JSON.stringify(first.content), /\u4E3B\u9898\u5DF2\u4FDD\u5B58/);
    assert.match(JSON.stringify(first.content), /\u672A\u6838\u5B9E MEMORY\.md \u5173\u8054/);
    assert.match(JSON.stringify(first.content), /\u68C0\u67E5\u5DF2\u6709\u5165\u53E3/);
    assert.match(await readFile(path, "utf8"), /modified: /);
    await tools.read.execute("r", { path }, undefined, undefined, ctx);
    await tools.edit.execute("e", { path, edits: [{ oldText: "alpha", newText: "gamma" }, { oldText: "beta", newText: "delta" }] }, undefined, undefined, ctx);
    const before = await readFile(path);
    assert.ok(before.toString("utf8").includes("gamma\r\ndelta\r\n"));
    assert.match(before.toString("utf8"), /type: feedback\r\nreference: keep/);
    const secret = `sk-proj-${"SYNTHETIC1234".repeat(4)}`;
    for (const action of [
      () => tools.write.execute("secret-write", { path, content: secret }, undefined, undefined, ctx),
      () => tools.edit.execute("secret-edit", { path, edits: [{ oldText: "gamma", newText: secret }] }, undefined, undefined, ctx),
      () => tools.edit.execute("private-edit", { path, edits: [{ oldText: "gamma", newText: "-----BEGIN PRIVATE KEY-----\nSYNTHETIC" }] }, undefined, undefined, ctx),
      () => tools.write.execute("yaml-write", { path, content: "---\ntype: [broken\n---\nbody" }, undefined, undefined, ctx),
      () => tools.edit.execute("secret-mismatch", { path, edits: [{ oldText: secret, newText: "safe" }] }, undefined, undefined, ctx),
    ]) {
      await assert.rejects(action(), (error: Error) => {
        assert.ok(error.message.startsWith("Memory "));
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes("SYNTHETIC"), false);
        return true;
      });
      assert.deepEqual(await readFile(path), before);
    }
    const plain = join(store.paths.projectDir, "MEMORY.md");
    await tools.write.execute("plain", { path: plain, content: "plain index" }, undefined, undefined, ctx);
    assert.equal(await readFile(plain, "utf8"), "plain index");
    const oversized = Array(201).fill("line").join("\n");
    const saved = await tools.write.execute("oversize", { path: plain, content: oversized }, undefined, undefined, ctx);
    assert.equal(saved.isError, true);
    assert.match(JSON.stringify(saved.content), /file IS SAVED/);
    assert.equal(await readFile(plain, "utf8"), oversized);
    await tools.edit.execute("oversize-edit", { path: plain, edits: [{ oldText: oversized, newText: oversized + "\nline" }] }, undefined, undefined, ctx).then((result) => {
      assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /file IS SAVED/);
    });
    assert.equal(await readFile(plain, "utf8"), oversized + "\nline");
    await symlink(join(root, "ordinary.txt"), join(store.paths.projectDir, "link.md"));
    await assert.rejects(tools.read.execute("link", { path: join(store.paths.projectDir, "link.md") }, undefined, undefined, ctx), /symbolic links/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("external dangling file aliases cannot bypass memory validation or the off gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-dangling-"));
  try {
    const store = await makeStore(join(root, "agent"));
    await store.write(join(store.paths.projectDir, "sibling.md"), "establish the project directory");
    const tools = managedFileTools(root, store);
    const ctx = { cwd: root } as ExtensionToolContext;
    const target = join(store.paths.projectDir, "new.md");
    const alias = join(root, "alias.md");
    await symlink(target, alias);
    const secret = `sk-proj-${"SYNTHETIC1234".repeat(4)}`;
    await assert.rejects(tools.write.execute("secret", { path: alias, content: secret }, undefined, undefined, ctx), /provider-token/);
    await assert.rejects(readFile(target), { code: "ENOENT" });
    await store.config.setEnabled(false);
    await assert.rejects(tools.write.execute("off", { path: alias, content: "safe text" }, undefined, undefined, ctx), /Memory is off/);
    await assert.rejects(readFile(target), { code: "ENOENT" });
    await store.config.setEnabled(true);
    await tools.write.execute("allowed", { path: alias, content: "---\ntype: feedback\n---\nsafe" }, undefined, undefined, ctx);
    assert.match(await readFile(target, "utf8"), /modified: /);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary dangling file aliases still delegate default host writing with unchanged results", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-ordinary-alias-"));
  try {
    const store = await makeStore(join(root, "agent"));
    await store.config.setEnabled(false);
    const tools = managedFileTools(root, store);
    const host = standardFileTools(root);
    const ctx = { cwd: root } as ExtensionToolContext;
    const target = join(root, "new-ordinary.md");
    const alias = join(root, "ordinary-alias.md");
    await symlink(target, alias);
    const content = `sk-proj-${"SYNTHETIC1234".repeat(4)}`;
    const adapted = await tools.write.execute("w", { path: alias, content }, undefined, undefined, ctx);
    assert.equal(await readFile(target, "utf8"), content);
    await rm(target);
    const original = await host.write.execute("w", { path: alias, content }, undefined, undefined, ctx);
    assert.deepEqual(adapted, original);
    assert.equal(await readFile(target, "utf8"), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown classification errors never authorize default IO", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-classify-fault-"));
  try {
    const store = await makeStore(join(root, "agent"));
    const target = join(store.paths.projectDir, "topic.md");
    await store.write(target, "original");
    const tools = managedFileTools(root, store);
    const ctx = { cwd: root } as ExtensionToolContext;
    for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"]) {
      const mocked = t.mock.method(store.paths, "classify", async () => { throw Object.assign(new Error("injected classification fault"), { code }); });
      for (const action of [
        () => tools.read.execute("r", { path: target }, undefined, undefined, ctx),
        () => tools.write.execute("w", { path: target, content: "bypass" }, undefined, undefined, ctx),
        () => tools.edit.execute("e", { path: target, edits: [{ oldText: "original", newText: "bypass" }] }, undefined, undefined, ctx),
      ]) await assert.rejects(action(), { code });
      assert.equal(await readFile(target, "utf8"), "original");
      mocked.mock.restore();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing memory file reports that it can be created instead of a generic operation failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-missing-"));
  try {
    const store = await makeStore(join(root, "agent"));
    const tools = managedFileTools(root, store);
    const ctx = { cwd: root } as ExtensionToolContext;
    const error = await tools.read.execute("missing", { path: join(store.paths.projectDir, "MEMORY.md") }, undefined, undefined, ctx)
      .catch((value: Error) => value);
    assert.ok(error instanceof Error);
    assert.match(error.message, /Memory file not found/);
    assert.doesNotMatch(error.message, /No successful save was reported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a saved topic followed by a stale index edit keeps the topic and reports the index step as incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-partial-"));
  try {
    const store = await makeStore(join(root, "agent"));
    const tools = managedFileTools(root, store);
    const ctx = { cwd: root } as ExtensionToolContext;
    const topic = join(store.paths.projectDir, "topics/partial.md");
    const index = join(store.paths.projectDir, "MEMORY.md");
    await tools.write.execute("index", { path: index, content: "# Memory\n\n- [old](topics/old.md): old entry\n" }, undefined, undefined, ctx);
    await tools.read.execute("read-index", { path: index }, undefined, undefined, ctx);
    const topicResult = await tools.write.execute("topic", { path: topic, content: "durable topic" }, undefined, undefined, ctx);
    assert.equal(topicResult.isError, false);
    assert.match(JSON.stringify(topicResult.content), /主题已保存/);
    const other = await makeStore(join(root, "agent"));
    await other.readFull(index);
    await other.write(index, "# Memory\n\n- [concurrent](topics/concurrent.md): concurrent entry\n");
    const edited = await tools.edit.execute("stale-index", { path: index, edits: [{ oldText: "old entry", newText: "partial entry" }] }, undefined, undefined, ctx).catch((error: Error) => error);
    assert.ok(edited instanceof Error);
    assert.match(edited.message, /stale version/);
    assert.equal(await readFile(topic, "utf8"), "durable topic");
    assert.match(await readFile(index, "utf8"), /concurrent entry/);
    assert.doesNotMatch(await readFile(index, "utf8"), /partial entry/);
    await tools.read.execute("read-index-again", { path: index }, undefined, undefined, ctx);
    const retried = await tools.edit.execute("retry-index", { path: index, edits: [{ oldText: "concurrent entry", newText: "partial entry" }] }, undefined, undefined, ctx);
    assert.equal(retried.isError, false);
    assert.match(await readFile(index, "utf8"), /partial entry/);
    assert.equal(await readFile(topic, "utf8"), "durable topic");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a closed store during the index step leaves the saved topic and never claims overall success", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-closed-"));
  try {
    const store = await makeStore(join(root, "agent"));
    const tools = managedFileTools(root, store);
    const ctx = { cwd: root } as ExtensionToolContext;
    const topic = join(store.paths.projectDir, "topics/closed.md");
    const index = join(store.paths.projectDir, "MEMORY.md");
    await tools.write.execute("topic", { path: topic, content: "kept after close" }, undefined, undefined, ctx);
    await store.config.setEnabled(false);
    const closed = await tools.write.execute("index", { path: index, content: "# Memory\n\n- [closed](topics/closed.md): entry\n" }, undefined, undefined, ctx).catch((error: Error) => error);
    assert.ok(closed instanceof Error);
    assert.match(closed.message, /Memory is off/);
    assert.equal(await readFile(topic, "utf8"), "kept after close");
    await assert.rejects(readFile(index), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancellation after atomic replacement reports saved rather than suggesting rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-cancel-"));
  try {
    const store = await makeStore(join(root, "agent"));
    const abort = new AbortController();
    const mutate = store.mutate.bind(store);
    store.mutate = async function<T>(path: string, action: (file: LockedFile) => Promise<T>, hooks: AtomicHooks = {}): Promise<T> {
      return mutate(path, (file) => action({ ...file, write: async (text) => {
        const saved = await file.write(text);
        abort.abort();
        return saved;
      } }), hooks);
    };
    const tools = managedFileTools(root, store);
    const ctx = { cwd: root } as ExtensionToolContext;
    const path = join(store.paths.projectDir, "saved.md");
    const result = await tools.write.execute("cancelled", { path, content: "committed" }, abort.signal, undefined, ctx);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /file IS SAVED/);
    assert.equal(await readFile(path, "utf8"), "committed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("wrapper instances share no accidental read baseline, and register as same-named public definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-wrapper-load-"));
  try {
    const store = await makeStore(join(root, "agent"));
    const path = join(store.paths.projectDir, "topic.md");
    await store.write(path, "original");
    const reader = await makeStore(join(root, "agent"));
    const tools = managedFileTools(root, reader);
    const ctx = { cwd: root } as ExtensionToolContext;
    await assert.rejects(tools.write.execute("unread", { path, content: "overwrite" }, undefined, undefined, ctx), /no complete read baseline/);
    await tools.read.execute("read", { path }, undefined, undefined, ctx);
    await store.write(path, "new value");
    await assert.rejects(tools.edit.execute("stale", { path, edits: [{ oldText: "original", newText: "overwrite" }] }, undefined, undefined, ctx), /stale version/);
    await tools.read.execute("read", { path }, undefined, undefined, ctx);
    await tools.edit.execute("fresh", { path, edits: [{ oldText: "new value", newText: "fresh edit" }] }, undefined, undefined, ctx);
    assert.equal(await readFile(path, "utf8"), "fresh edit");
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "isolated-agent"), settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [(pi) => { pi.registerTool(tools.read); pi.registerTool(tools.write); pi.registerTool(tools.edit); }],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), ["edit", "read", "write"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
