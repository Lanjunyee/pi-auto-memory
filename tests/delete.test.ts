import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeStore } from "./helpers/store.js";

test("confirmed deletion while off uses metadata only and deletes exactly one private target", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-delete-"));
  try {
    const store = await makeStore(root);
    const a = join(store.paths.projectDir, "a.md");
    const b = join(store.paths.projectDir, "b.md");
    await store.write(a, "selected"); await store.write(b, "not selected");
    await store.config.setEnabled(false);
    if (process.platform !== "win32") await chmod(a, 0o000);
    await assert.rejects(store.readFull(a), /Memory is off/);
    const cancelled = await store.prepareDelete(a);
    assert.deepEqual(await store.deleteConfirmed(cancelled, false), { deleted: false });
    const selected = await store.prepareDelete(a);
    assert.deepEqual(await store.deleteConfirmed(selected, true), { deleted: true });
    await assert.rejects(readFile(a), { code: "ENOENT" });
    assert.equal(await readFile(b, "utf8"), "not selected");
    await assert.rejects(store.deleteConfirmed(selected, true), /confirm the exact target again/);
    await assert.rejects(store.deleteConfirmed({ path: b }, true), /confirm the exact target again/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("delete confirmation rejects replaced, in-place modified and session-invalidated targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-delete-version-"));
  try {
    const store = await makeStore(root);
    const path = join(store.paths.projectDir, "topic.md");
    await store.write(path, "original");
    const replacement = await store.prepareDelete(path);
    await writeFile(join(store.paths.projectDir, "new.md"), "original");
    await rename(join(store.paths.projectDir, "new.md"), path);
    await assert.rejects(store.deleteConfirmed(replacement, true), /target changed; confirm again/);
    assert.equal(await readFile(path, "utf8"), "original");
    const modification = await store.prepareDelete(path);
    await writeFile(path, "modified");
    await assert.rejects(store.deleteConfirmed(modification, true), /target changed; confirm again/);
    const lifecycle = await store.prepareDelete(path);
    store.invalidate();
    await assert.rejects(store.deleteConfirmed(lifecycle, true), /session change; confirm again/);
    assert.equal(await readFile(path, "utf8"), "modified");
    await assert.rejects(store.prepareDelete(join(root, "outside.md")), /only the current project/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
