import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryConfig, isProjectId, projectDisabled, projectPolicy, resolveEffectiveState } from "../src/core/config.js";
import { MemoryPaths } from "../src/core/paths.js";
import { fixtureChild } from "./helpers/child.js";

test("missing config defaults on; corrupt, unsupported and linked config pause without repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-"));
  try {
    const config = await MemoryConfig.create(root);
    assert.deepEqual(await config.read(), { status: "known", enabled: true, data: { version: 1, enabled: true }, missing: true });
    for (const invalid of ["{", "null", "[]", '{"version":3,"enabled":true}', '{"version":1,"enabled":"yes"}', '{"version":2,"enabled":true}', '{"version":2,"enabled":true,"disabledProjects":"x"}']) {
      await writeFile(config.path, invalid);
      assert.equal((await config.read()).status, "unknown");
      await assert.rejects(config.setEnabled(false), /repair it/);
      assert.equal(await readFile(config.path, "utf8"), invalid);
    }
    await rm(config.path);
    await writeFile(join(root, "foreign.json"), '{"version":1,"enabled":true}');
    await symlink(join(root, "foreign.json"), config.path);
    assert.equal((await config.read()).status, "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v1 and v2 configs resolve a pure project-effective state without migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-effective-"));
  try {
    const config = await MemoryConfig.create(root);
    const project = `cwd-${"a".repeat(64)}`;
    const other = `git-${"b".repeat(64)}`;
    const v1 = { status: "known" as const, enabled: true, data: { version: 1 as const, enabled: true }, missing: false };
    assert.deepEqual(resolveEffectiveState(v1, project), { status: "known", globalEnabled: true, projectPolicy: "inherit",
      effectiveEnabled: true, reason: "enabled", data: v1.data, missing: false });
    const v1Off = { ...v1, enabled: false, data: { version: 1 as const, enabled: false } };
    const offState = resolveEffectiveState(v1Off, project);
    assert.equal(offState.effectiveEnabled, false);
    assert.equal(offState.status === "known" && offState.reason, "global-off");
    const v2 = { status: "known" as const, enabled: true,
      data: { version: 2 as const, enabled: true, disabledProjects: [project] }, missing: false };
    const disabledState = resolveEffectiveState(v2, project);
    assert.equal(disabledState.effectiveEnabled, false);
    assert.equal(disabledState.status === "known" && disabledState.reason, "project-disabled");
    assert.equal(resolveEffectiveState(v2, other).effectiveEnabled, true);
    assert.equal(resolveEffectiveState({ status: "unknown", enabled: false, fault: "x" }, project).status, "unknown");
    assert.equal(projectDisabled(v1.data, project), false);
    assert.equal(projectPolicy(v2.data, project), "disabled");
    assert.equal(projectPolicy(v2.data, other), "inherit");
    assert.equal(isProjectId(project), true);
    assert.equal(isProjectId("cwd-abc"), false);

    await writeFile(config.path, JSON.stringify(v1Off.data));
    const before = await readFile(config.path);
    await config.read();
    await config.inspect();
    assert.deepEqual(await readFile(config.path), before);
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 1, enabled: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("settings preserve fields, use private atomic files, and pre-rename failure preserves effective state", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-atomic-"));
  try {
    const config = await MemoryConfig.create(root);
    await writeFile(config.path, JSON.stringify({ version: 1, enabled: true, foreign: { count: 7 } }));
    await config.setEnabled(false);
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 1, enabled: false, foreign: { count: 7 } });
    if (process.platform !== "win32") assert.equal((await lstat(config.path)).mode & 0o777, 0o600);
    const prior = await readFile(config.path);
    await assert.rejects(config.setEnabled(true, { write: async (handle) => {
      await handle.writeFile("partial"); throw new Error("injected write failure");
    } }), /injected write failure/);
    assert.deepEqual(await readFile(config.path), prior);
    assert.equal((await config.read()).enabled, false);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspection reports known, missing, unsafe-path, invalid-format and unsupported-version categories without leaking content", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-inspect-"));
  try {
    const config = await MemoryConfig.create(root);
    assert.deepEqual(await config.inspect(), { status: "known", enabled: true, data: { version: 1, enabled: true }, missing: true });
    assert.deepEqual(await config.read(), await config.inspect());
    const missingA = await config.inspect();
    const missingB = await config.inspect();
    assert.notEqual(missingA, missingB);
    if (missingA.status === "known" && missingB.status === "known") assert.notEqual(missingA.data, missingB.data);
    const secret = "s3cr3t-token-value";
    await writeFile(config.path, JSON.stringify({ version: 1, enabled: false, secret }));
    const known = await config.inspect();
    assert.deepEqual(known, { status: "known", enabled: false, data: { version: 1, enabled: false, secret }, missing: false });
    assert.equal(JSON.stringify(known).includes(secret), true);
    for (const corrupt of ["{", '"unterminated', '{"version":1', "[1,2"]) {
      await writeFile(config.path, corrupt);
      assert.deepEqual(await config.inspect(), { status: "unknown", enabled: false, reason: "invalid-format" });
    }
    for (const invalid of ["null", "[]", "3", '"string"', '{"version":1,"enabled":"yes"}', '{"version":2,"enabled":true}']) {
      await writeFile(config.path, invalid);
      assert.deepEqual(await config.inspect(), { status: "unknown", enabled: false, reason: "invalid-format" });
    }
    for (const unsupported of ["{}", '{"enabled":true}', '{"version":3,"enabled":true}', '{"version":0,"enabled":true}', '{"version":"1","enabled":true}']) {
      await writeFile(config.path, unsupported);
      assert.deepEqual(await config.inspect(), { status: "unknown", enabled: false, reason: "unsupported-version" });
    }
    const v2 = { version: 2, enabled: true, disabledProjects: [`git-${"c".repeat(64)}`] };
    await writeFile(config.path, JSON.stringify(v2));
    assert.deepEqual(await config.inspect(), { status: "known", enabled: true, data: v2, missing: false });
    for (const invalidProjects of [{ version: 2, enabled: true, disabledProjects: "x" },
      { version: 2, enabled: true, disabledProjects: ["cwd-short"] },
      { version: 2, enabled: true, disabledProjects: [`cwd-${"d".repeat(64)}`, `cwd-${"d".repeat(64)}`] }]) {
      await writeFile(config.path, JSON.stringify(invalidProjects));
      assert.deepEqual(await config.inspect(), { status: "unknown", enabled: false, reason: "invalid-format" });
    }
    await rm(config.path);
    await writeFile(join(root, "foreign.json"), '{"version":1,"enabled":true}');
    await symlink(join(root, "foreign.json"), config.path);
    assert.deepEqual(await config.inspect(), { status: "unknown", enabled: false, reason: "unsafe-path" });
    await rm(config.path, { force: true });
    await mkdir(config.path);
    assert.deepEqual(await config.inspect(), { status: "unknown", enabled: false, reason: "unsafe-path" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspection maps failures to the legacy fault text through read without leaking raw errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-inspect-read-"));
  const config = await MemoryConfig.create(root);
  const fault = "Memory paused: auto-memory.json is unreadable, corrupt or unsupported; repair it before retrying.";
  try {
    for (const mode of ["corrupt", "unsupported", "linked"]) {
      if (mode === "corrupt") await writeFile(config.path, '{"version":1,"enabled":"maybe"}');
      if (mode === "unsupported") await writeFile(config.path, '{"version":9,"enabled":true}');
      if (mode === "linked") {
        await writeFile(join(root, "foreign.json"), '{"version":1,"enabled":true}');
        await rm(config.path, { force: true });
        await symlink(join(root, "foreign.json"), config.path);
      }
      const state = await config.read();
      assert.deepEqual(state, { status: "unknown", enabled: false, fault });
      assert.equal(JSON.stringify(state).includes("reason"), false);
      assert.equal(JSON.stringify(state).includes("maybe"), false);
      assert.equal(JSON.stringify(state).includes("foreign.json"), false);
    }
    assert.deepEqual(await config.locked((state) => Promise.resolve(state)), { status: "unknown", enabled: false, fault });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real processes reread under the config lock and preserve concurrent fields and switch changes", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-processes-"));
  const children: ReturnType<typeof fixtureChild>[] = [];
  try {
    const config = await MemoryConfig.create(root);
    const a = fixtureChild("tests/fixtures/config-worker.ts", [root, "field-a"]); children.push(a);
    await a.next("locked");
    const b = fixtureChild("tests/fixtures/config-worker.ts", [root, "field-b"]); children.push(b);
    a.go(); await a.next("done");
    await b.next("locked"); b.go(); await b.next("done");
    const c = fixtureChild("tests/fixtures/config-worker.ts", [root, "off"]); children.push(c);
    await c.next("locked"); c.go(); await c.next("done");
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 1, enabled: false, "field-a": true, "field-b": true });
    for (const child of children) assert.equal(await child.exited, 0);
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("project settings update under the config lock and keep global and other project data", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-project-"));
  try {
    const config = await MemoryConfig.create(root);
    const first = `cwd-${"a".repeat(64)}`;
    const second = `git-${"b".repeat(64)}`;
    await writeFile(config.path, JSON.stringify({ version: 1, enabled: true, foreign: { keep: true } }));
    const upgraded = await config.setProjectDisabled(first, true);
    assert.equal(upgraded.status, "known");
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 2, enabled: true, foreign: { keep: true }, disabledProjects: [first] });
    await config.setProjectDisabled(second, true);
    await config.setEnabled(false);
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 2, enabled: false, foreign: { keep: true }, disabledProjects: [first, second] });
    await config.setEnabled(true);
    await config.setProjectDisabled(first, false);
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 2, enabled: true, foreign: { keep: true }, disabledProjects: [second] });
    await assert.rejects(config.setProjectDisabled("not-a-project", true), /invalid current project identity/);
    await assert.rejects(config.setProjectDisabled(first.toUpperCase(), true), /invalid current project identity/);

    await writeFile(config.path, JSON.stringify({ version: 1, enabled: true, disabledProjects: ["foreign"] }));
    await assert.rejects(config.setProjectDisabled(first, true), /reserves disabledProjects/);
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 1, enabled: true, disabledProjects: ["foreign"] });

    const prior = await readFile(config.path);
    await writeFile(config.path, JSON.stringify({ version: 2, enabled: true, disabledProjects: [] }));
    const priorV2 = await readFile(config.path);
    await assert.rejects(config.setProjectDisabled(first, true, { write: async (handle) => {
      await handle.writeFile("partial"); throw new Error("injected project write failure");
    } }), /injected project write failure/);
    assert.deepEqual(await readFile(config.path), priorV2);
    assert.notDeepEqual(priorV2, prior);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a v2 config is rejected by the legacy version gate instead of being silently enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-v2-legacy-"));
  try {
    const config = await MemoryConfig.create(root);
    const project = `cwd-${"a".repeat(64)}`;
    await writeFile(config.path, JSON.stringify({ version: 2, enabled: true, disabledProjects: [project] }));
    const legacyGate = (data: { version?: unknown; enabled?: unknown }) => data.version === 1 && typeof data.enabled === "boolean";
    assert.equal(legacyGate(JSON.parse(await readFile(config.path, "utf8"))), false);
    assert.equal((await config.inspect()).status, "known");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent project and global updates reread under the lock and lose no fields", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-project-processes-"));
  const children: ReturnType<typeof fixtureChild>[] = [];
  try {
    const config = await MemoryConfig.create(root);
    const first = `cwd-${"a".repeat(64)}`;
    const second = `git-${"b".repeat(64)}`;
    const a = fixtureChild("tests/fixtures/config-worker.ts", [root, "disable", first]); children.push(a);
    await a.next("locked");
    const b = fixtureChild("tests/fixtures/config-worker.ts", [root, "disable", second]); children.push(b);
    a.go(); await a.next("done");
    await b.next("locked"); b.go(); await b.next("done");
    const c = fixtureChild("tests/fixtures/config-worker.ts", [root, "off"]); children.push(c);
    await c.next("locked"); c.go(); await c.next("done");
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 2, enabled: false, disabledProjects: [first, second] });
    const d = fixtureChild("tests/fixtures/config-worker.ts", [root, "inherit", first]); children.push(d);
    await d.next("locked"); d.go(); await d.next("done");
    assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { version: 2, enabled: false, disabledProjects: [second] });
    for (const child of children) assert.equal(await child.exited, 0);
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("one agentDir shares the persistent switch across projects while separate agentDirs stay isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-config-scope-"));
  try {
    const config = await MemoryConfig.create(join(root, "shared-agent"));
    const first = await MemoryPaths.create(join(root, "shared-agent"), `cwd-${"a".repeat(64)}`);
    const second = await MemoryPaths.create(join(root, "shared-agent"), `cwd-${"b".repeat(64)}`);
    assert.equal(first.projectDir === second.projectDir, false);
    assert.equal(config.path, (await MemoryConfig.create(join(root, "shared-agent"))).path);
    await config.setEnabled(false);
    assert.equal((await (await MemoryConfig.create(join(root, "shared-agent"))).read()).enabled, false);
    const other = await MemoryConfig.create(join(root, "other-agent"));
    assert.deepEqual(await other.read(), { status: "known", enabled: true, data: { version: 1, enabled: true }, missing: true });
    await config.setEnabled(true);
    assert.equal((await other.read()).enabled, true);
    assert.equal(first.projectDir.includes("shared-agent"), true);
    assert.equal(second.projectDir.includes("shared-agent"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
