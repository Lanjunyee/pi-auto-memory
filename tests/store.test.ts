import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createEditToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { LOCK_STALE_MS } from "../src/core/constants.js";
import { makeStore } from "./helpers/store.js";
import { fixtureChild } from "./helpers/child.js";

test("storage validates final contents, requires complete versions, and preserves old files on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-store-"));
  try {
    const store = await makeStore(root);
    const path = join(store.paths.projectDir, "topic.md");
    await store.write(path, "original");
    const other = await makeStore(root);
    await assert.rejects(other.write(path, "unseen"), /no complete read baseline/);
    const partial = await other.readBuffer(path);
    other.recordRange(partial.path, partial.buffer, 0, 2);
    await assert.rejects(other.write(path, "partial"), /no complete read baseline/);
    await other.readFull(path);
    await store.write(path, "changed");
    await assert.rejects(other.write(path, "stale"), /stale version/);
    assert.equal(await readFile(path, "utf8"), "changed");
    await other.readFull(path);
    const secret = `sk-proj-${"SYNTHETIC1234".repeat(4)}`;
    await assert.rejects(other.write(path, secret), /provider-token/);
    assert.equal(await readFile(path, "utf8"), "changed");
    await assert.rejects(other.write(path, "---\nbroken: [\n---\nbody"), /frontmatter/);
    assert.equal(await readFile(path, "utf8"), "changed");
    await assert.rejects(other.write(path, "safe", { write: async (handle) => {
      await handle.writeFile("partial"); throw new Error("injected write failure");
    } }), /injected write failure/);
    assert.equal(await readFile(path, "utf8"), "changed");
    assert.equal((await readdir(store.paths.projectDir)).some((name) => name.endsWith(".tmp")), false);
    await other.write(path, "---\ntype: feedback\n---\nbody");
    assert.match(await readFile(path, "utf8"), /modified: /);
    assert.match(await readFile(path, "utf8"), /type: feedback/);
    const index = join(store.paths.projectDir, "MEMORY.md");
    const oversized = Array(201).fill("line").join("\n");
    const saved = await other.write(index, oversized);
    assert.equal(saved.isError, true); assert.equal(saved.saved, true);
    assert.equal(await readFile(index, "utf8"), oversized);
    await assert.rejects(other.write(index, oversized + "\n" + secret), /provider-token/);
    assert.equal(await readFile(index, "utf8"), oversized);
    await other.readFull(path);
    const before = await readFile(path);
    await assert.rejects(other.write(path, "invalidated", { beforeRename: async () => other.invalidate() }), /session change/);
    assert.deepEqual(await readFile(path), before);
    assert.equal((await readdir(store.paths.projectDir)).some((name) => name.endsWith(".tmp")), false);
    await other.readFull(path);
    await other.write(path, "retry after exception");
    assert.equal(await readFile(path, "utf8"), "retry after exception");
    await other.config.setEnabled(false);
    await assert.rejects(other.readFull(path), /Memory is off/);
    await assert.rejects(other.write(path, "off"), /Memory is off/);
    await writeFile(other.config.path, "invalid");
    await assert.rejects(other.write(path, "unknown"), /Memory paused/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same-buffer ranges accumulate completely, while changed digests discard prior coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-store-ranges-"));
  try {
    const writer = await makeStore(root);
    const path = join(writer.paths.projectDir, "topic.md");
    await writer.write(path, "abcdefghi");
    const reader = await makeStore(root);
    const first = await reader.readBuffer(path);
    reader.recordRange(first.path, first.buffer, 0, 3, first.generation);
    const second = await reader.readBuffer(path);
    reader.recordRange(second.path, second.buffer, 3, 6, second.generation);
    await assert.rejects(reader.write(path, "incomplete"), /no complete read baseline/);
    reader.recordRange(second.path, second.buffer, 6, 9, second.generation);
    await reader.write(path, "completed");
    assert.equal(await readFile(path, "utf8"), "completed");
    const changedReader = await makeStore(root);
    const old = await changedReader.readBuffer(path);
    changedReader.recordRange(old.path, old.buffer, 0, 5, old.generation);
    await writer.readFull(path);
    await writer.write(path, "new value");
    const changed = await changedReader.readBuffer(path);
    changedReader.recordRange(changed.path, changed.buffer, 5, 9, changed.generation);
    await assert.rejects(changedReader.write(path, "mixed versions"), /no complete read baseline/);
    changedReader.recordRange(changed.path, changed.buffer, 0, 5, changed.generation);
    await changedReader.write(path, "fresh ranges");
    assert.equal(await readFile(path, "utf8"), "fresh ranges");
    changedReader.recordRange(old.path, old.buffer, 0, old.buffer.length, old.generation);
    await assert.rejects(changedReader.write(path, "stale buffer"), /stale version/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real processes reject stale overwrites and competing creation", { timeout: 15_000 }, async () => {
  for (const mode of ["existing", "new"]) {
    const root = await mkdtemp(join(tmpdir(), "auto-memory-store-processes-"));
    const children: ReturnType<typeof fixtureChild>[] = [];
    try {
      const store = await makeStore(root);
      const path = join(store.paths.projectDir, "topic.md");
      if (mode === "existing") await store.write(path, "original");
      const a = fixtureChild("tests/fixtures/store-worker.ts", [root, mode, "winner"]); children.push(a);
      const b = fixtureChild("tests/fixtures/store-worker.ts", [root, mode, "loser"]); children.push(b);
      await a.next("ready"); await b.next("ready");
      a.go(); await a.next("renaming"); a.go(); await a.next("done");
      b.go(); const rejection = await b.next("rejected");
      assert.match(String(rejection.message), mode === "existing" ? /stale version/ : /no complete read baseline/);
      assert.equal(await readFile(path, "utf8"), "winner");
      assert.equal(await a.exited, 0); assert.equal(await b.exited, 2);
    } finally {
      for (const child of children) if (child.child.exitCode === null) child.child.kill();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("lock timeout rejects safely; SIGKILL before rename preserves old content and stale-lock recovery works", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-store-crash-"));
  const children: ReturnType<typeof fixtureChild>[] = [];
  try {
    const store = await makeStore(root);
    const path = join(store.paths.projectDir, "topic.md");
    await store.write(path, "original");
    for (const mode of ["lock", "project-lock"]) {
      const holder = fixtureChild("tests/fixtures/store-worker.ts", [root, mode]); children.push(holder);
      await holder.next("locked");
      await assert.rejects(store.write(path, "timeout"), /Memory lock unavailable/);
      assert.equal(await readFile(path, "utf8"), "original");
      holder.go(); await holder.next("done"); assert.equal(await holder.exited, 0);
    }
    const crash = fixtureChild("tests/fixtures/store-worker.ts", [root, "existing", "crash-content"]); children.push(crash);
    await crash.next("ready"); crash.go(); await crash.next("renaming");
    assert.equal(await readFile(path, "utf8"), "original");
    crash.child.kill("SIGKILL"); await crash.exited;
    await delay(LOCK_STALE_MS + 1200);
    const recovered = await makeStore(root);
    await recovered.readFull(path);
    await recovered.write(path, "recovered");
    assert.equal(await readFile(path, "utf8"), "recovered");
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("live process heartbeats retain both locks beyond the stale threshold", { timeout: 22_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-store-heartbeat-"));
  let holder: ReturnType<typeof fixtureChild> | undefined;
  try {
    const store = await makeStore(root);
    const path = join(store.paths.projectDir, "topic.md");
    await store.write(path, "original");
    holder = fixtureChild("tests/fixtures/store-worker.ts", [root, "existing", "holder commit"]);
    await holder.next("ready"); holder.go(); await holder.next("renaming");
    const anchors = [store.config.anchor, store.projectAnchor];
    const initial = await Promise.all(anchors.map((anchor) => lstat(`${anchor}.lock`)));
    await delay(LOCK_STALE_MS + 1200);
    const refreshed = await Promise.all(anchors.map((anchor) => lstat(`${anchor}.lock`)));
    for (let i = 0; i < anchors.length; i++) assert.ok(refreshed[i].mtimeMs > initial[i].mtimeMs);
    await assert.rejects(store.write(path, "must not steal"), /Memory lock unavailable/);
    assert.equal(await readFile(path, "utf8"), "original");
    holder.go(); await holder.next("done"); assert.equal(await holder.exited, 0);
    assert.equal(await readFile(path, "utf8"), "holder commit");
  } finally {
    if (holder && holder.child.exitCode === null) holder.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("barriers prove both off/rename orderings across processes", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-store-off-"));
  const children: ReturnType<typeof fixtureChild>[] = [];
  try {
    const store = await makeStore(root);
    const path = join(store.paths.projectDir, "topic.md");
    await store.write(path, "original");
    const first = fixtureChild("tests/fixtures/store-worker.ts", [root, "existing", "before-off"]); children.push(first);
    await first.next("ready"); first.go(); await first.next("renaming");
    const off = fixtureChild("tests/fixtures/config-worker.ts", [root, "off"]); children.push(off);
    first.go(); await first.next("done");
    await off.next("locked");
    assert.equal(await readFile(path, "utf8"), "before-off");
    off.go(); await off.next("done");
    assert.equal((await store.config.read()).enabled, false);
    await store.config.setEnabled(true);
    const second = fixtureChild("tests/fixtures/store-worker.ts", [root, "existing", "after-off"]); children.push(second);
    await second.next("ready");
    const offFirst = fixtureChild("tests/fixtures/config-worker.ts", [root, "off"]); children.push(offFirst);
    await offFirst.next("locked"); offFirst.go(); await offFirst.next("done");
    second.go(); const error = await second.next("rejected");
    assert.match(String(error.message), /Memory is off/);
    assert.equal(await readFile(path, "utf8"), "before-off");
    for (const child of children) await child.exited;
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("same-process write/host-factory edit use config -> project -> queue without reentrant deadlock", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-store-queue-"));
  try {
    const store = await makeStore(root);
    const path = join(store.paths.projectDir, "topic.md");
    await store.write(path, "original");
    await store.readFull(path);
    const operations = store.mutate(path, async (file) => {
      const factory = createEditToolDefinition(root, { operations: {
        access: async () => { if (!file.buffer) throw new Error("missing"); },
        readFile: async () => file.buffer!,
        writeFile: async (_path, content) => { await file.write(content); },
      } });
      return factory.execute("edit", { path, edits: [{ oldText: "original", newText: "edited" }] },
        undefined, undefined, { cwd: root } as ExtensionToolContext);
    });
    const concurrent = store.write(path, "parallel");
    const results = await Promise.allSettled([operations, concurrent]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.match(await readFile(path, "utf8"), /^(edited|parallel)$/);
    await store.readFull(path);
    await store.write(path, "retry works");
    assert.equal(await readFile(path, "utf8"), "retry works");
  } finally { await rm(root, { recursive: true, force: true }); }
});
