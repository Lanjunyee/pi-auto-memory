import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { diagnoseMemory, formatDoctor, type DoctorCheck, type DoctorOptions } from "../src/pi/doctor.js";
import { existingBinary } from "../src/pi/scan-binary.js";
import { MemoryConfig } from "../src/core/config.js";
import { MemoryPaths } from "../src/core/paths.js";
import { identifyProject } from "../src/core/project-identity.js";
import { MemoryStore } from "../src/core/store.js";
import type { DiagnosticContext, ToolObservation } from "../src/pi/registration.js";

function find(checks: DoctorCheck[], id: string): DoctorCheck {
  const check = checks.find((entry) => entry.id === id);
  assert.ok(check, `expected check ${id}; got ${checks.map((entry) => entry.id).join(",")}`);
  return check;
}

function observe(name: string, registered: boolean, active: boolean, conflict = false): ToolObservation {
  return { name, registered, active, conflict };
}

function allSix(): ToolObservation[] {
  return ["read", "write", "edit", "grep", "find", "ls"].map((name) => observe(name, true, true));
}

async function environment(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "ordinary.txt"), "ordinary");
  const project = await identifyProject(cwd);
  const paths = await MemoryPaths.create(agentDir, project.projectId);
  const context = (override: Partial<DiagnosticContext> = {}): DiagnosticContext => ({
    agentDir,
    child: false,
    assertCurrent: () => {},
    identify: async () => project,
    tools: () => ({ entries: allSix(), paused: false }),
    ...override,
  });
  return { root, cwd, agentDir, project, paths, context };
}

const stableBinary = async (tool: "rg" | "fd", agentDir: string): Promise<string> => join(agentDir, "bin", tool === "fd" ? "fd" : "rg");

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, item.name);
      const key = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) { entries[`${key}/`] = "dir"; await walk(path, key); }
      else if (item.isSymbolicLink()) entries[key] = "link";
      else { const info = await stat(path); entries[key] = `file:${info.size}`; }
    }
  };
  await walk(root, "");
  return entries;
}

test("normal new project reports defaults without creating configuration, directory or index", async (t) => {
  const f = await environment(t);
  const before = await snapshot(f.root);
  const checks = await diagnoseMemory(f.context(), { binary: stableBinary });
  assert.equal(find(checks, "runtime.node").level, "ok");
  assert.equal(find(checks, "runtime.pi").level, "ok", "current host must fall inside the declared range");
  assert.equal(find(checks, "runtime.scope").level, "ok");
  assert.equal(find(checks, "config").level, "ok");
  assert.match(find(checks, "config").reason, /配置不存在；记忆默认开启/);
  assert.equal(find(checks, "project.identity").level, "ok");
  assert.equal(find(checks, "project.identity").reason.includes(f.project.projectId), false);
  assert.equal(find(checks, "project.directory").level, "ok");
  assert.match(find(checks, "project.directory").reason, /新项目属正常情况/);
  assert.equal(find(checks, "project.index").level, "ok");
  assert.match(find(checks, "project.index").reason, /索引不存在；属于正常空记忆/);
  for (const name of ["read", "write", "edit", "grep", "find", "ls"]) assert.equal(find(checks, `tool.${name}`).level, "ok");
  assert.equal(find(checks, "tools.pause").level, "ok");
  assert.equal(find(checks, "scan.rg").level, "ok");
  assert.equal(find(checks, "scan.fd").level, "ok");
  assert.deepEqual(await snapshot(f.root), before);
});

test("invalid, off and unknown configuration are reported separately from other checks", async (t) => {
  const f = await environment(t);
  for (const [body, reason] of [["{ not json", "invalid-format"], ['{"version":9,"enabled":true}', "unsupported-version"], ['{"version":1,"enabled":"yes"}', "invalid-format"]] as const) {
    await t.test(reason + ":" + body, async (t) => {
      await mkdir(f.agentDir, { recursive: true });
      await writeFile(join(f.agentDir, "auto-memory.json"), body);
      const checks = await diagnoseMemory(f.context(), { binary: stableBinary });
      assert.equal(find(checks, "config").level, "failure");
      assert.equal(find(checks, "config").reason.includes(body), false);
      assert.equal(find(checks, "project.identity").level, "ok");
      assert.equal(find(checks, "scan.rg").level, "ok");
      await rm(join(f.agentDir, "auto-memory.json"));
    });
  }
  await t.test("off", async (t) => {
    await mkdir(f.agentDir, { recursive: true });
    await writeFile(join(f.agentDir, "auto-memory.json"), '{"version":1,"enabled":false}');
    const checks = await diagnoseMemory(f.context(), { binary: stableBinary });
    assert.equal(find(checks, "config").level, "ok");
    assert.match(find(checks, "config").reason, /记忆当前为关闭/);
    assert.equal(find(checks, "project.index").level, "ok");
  });
});

test("configuration failure does not hide tool conflict, missing scan tools or project checks", async (t) => {
  const f = await environment(t);
  await mkdir(f.agentDir, { recursive: true });
  await writeFile(join(f.agentDir, "auto-memory.json"), "{ corrupt");
  const context = f.context({
    tools: () => ({ paused: true, entries: allSix().map((entry) => entry.name === "read" ? { ...entry, conflict: true } : entry) }),
  });
  const checks = await diagnoseMemory(context, { binary: async () => { throw new Error("secret-path-internal"); } });
  assert.equal(find(checks, "config").level, "failure");
  assert.equal(find(checks, "tool.read").level, "failure");
  assert.match(find(checks, "tool.read").reason, /存在同名工具的所有权或参数结构冲突/);
  assert.equal(find(checks, "tool.read").reason.includes("config"), false);
  assert.equal(find(checks, "tools.pause").level, "failure");
  assert.match(find(checks, "tools.pause").reason, /记录了一次工具兼容暂停/);
  assert.equal(find(checks, "scan.rg").level, "warning");
  assert.equal(find(checks, "scan.rg").reason.includes("secret-path-internal"), false);
  assert.equal(find(checks, "project.identity").level, "ok");
});

test("unregistered or inactive standard tools are described individually without declaring conflict", async (t) => {
  const f = await environment(t);
  const entries = [
    observe("read", true, false),
    observe("write", false, false),
    ...["edit", "grep", "find", "ls"].map((name) => observe(name, true, true)),
  ];
  const checks = await diagnoseMemory(f.context({ tools: () => ({ entries, paused: false }) }), { binary: stableBinary });
  assert.equal(find(checks, "tool.read").level, "ok");
  assert.match(find(checks, "tool.read").reason, /停用/);
  assert.equal(find(checks, "tool.write").level, "ok");
  assert.match(find(checks, "tool.write").reason, /未注册；未检测到冲突/);
  assert.equal(find(checks, "tool.read").reason.includes("Incompatible same-name"), false);
});

test("host version outside the verified scope warns and unavailability is unchecked without changing runtime support", async (t) => {
  const f = await environment(t);
  for (const inside of ["1.2.0", "1.3.0"]) {
    const supported = await diagnoseMemory(f.context(), { binary: stableBinary, hostVersion: inside });
    assert.equal(find(supported, "runtime.pi").level, "ok", inside);
    assert.match(find(supported, "runtime.pi").reason, /属于已验证范围 1\.2\.0 至 1\.3\.0/, inside);
    assert.equal(find(supported, "runtime.pi").advice, undefined, inside);
  }
  for (const below of ["1.1.0"]) {
    const older = await diagnoseMemory(f.context(), { binary: stableBinary, hostVersion: below });
    assert.equal(find(older, "runtime.pi").level, "warning", below);
    assert.match(find(older, "runtime.pi").reason, /超出已验证范围/, below);
  }
  const mismatched = await diagnoseMemory(f.context(), { binary: stableBinary, hostVersion: "9.9.9" });
  assert.equal(find(mismatched, "runtime.pi").level, "warning");
  assert.match(find(mismatched, "runtime.pi").reason, /超出已验证范围/);
  assert.equal(find(mismatched, "runtime.node").level, "ok");
  const unknown = await diagnoseMemory(f.context(), { binary: stableBinary, hostVersion: null });
  assert.equal(find(unknown, "runtime.pi").level, "unchecked");
  assert.match(find(unknown, "runtime.pi").reason, /无法可靠获取当前 pi 版本/);
  const low = await diagnoseMemory(f.context(), { binary: stableBinary, nodeVersion: "22.18.0" });
  assert.equal(find(low, "runtime.node").level, "failure");
  assert.match(find(low, "runtime.node").advice!, /22\.19\.0/);
});

test("missing scan binaries are local warnings that do not claim overall memory is unavailable", async (t) => {
  const f = await environment(t);
  const checks = await diagnoseMemory(f.context(), { binary: async (tool) => { if (tool === "fd") throw new Error("missing"); return "rg"; } });
  assert.equal(find(checks, "scan.rg").level, "ok");
  assert.equal(find(checks, "scan.fd").level, "warning");
  assert.match(find(checks, "scan.fd").reason, /未找到 fd\/fdfind/);
  assert.match(find(checks, "scan.fd").advice!, /agentDir\/bin 或 PATH/);
  assert.equal(find(checks, "scan.fd").reason.toLowerCase().includes("unavailable"), false);
  assert.equal(find(checks, "project.identity").level, "ok");
});

test("runner child reports unsupported and skips identity, path and index checks without placeholder fallback", async (t) => {
  const f = await environment(t);
  let identifyCalls = 0;
  const context = f.context({ child: true, identify: async () => { identifyCalls++; throw new Error("must not run"); } });
  const checks = await diagnoseMemory(context, { binary: stableBinary });
  assert.equal(identifyCalls, 0);
  assert.equal(find(checks, "runtime.scope").level, "failure");
  assert.match(find(checks, "runtime.scope").reason, /runner 子会话不受支持/);
  assert.equal(find(checks, "project.identity").level, "unchecked");
  assert.equal(find(checks, "project.directory").level, "unchecked");
  assert.equal(find(checks, "project.index").level, "unchecked");
  assert.equal(JSON.stringify(checks).includes("cwd-0000"), false);
  assert.equal(find(checks, "runtime.node").level, "ok");
});

test("identity failure reports a fault and marks dependent path checks unchecked without a substitute path", async (t) => {
  const f = await environment(t);
  const context = f.context({ identify: async () => { throw new Error("git repository is broken"); } });
  const checks = await diagnoseMemory(context, { binary: stableBinary });
  assert.equal(find(checks, "project.identity").level, "failure");
  assert.equal(find(checks, "project.identity").reason.includes("git repository is broken"), false);
  assert.match(find(checks, "project.identity").advice!, /未检查回退路径/);
  assert.equal(find(checks, "project.directory").level, "unchecked");
  assert.equal(find(checks, "project.index").level, "unchecked");
  assert.equal(find(checks, "runtime.node").level, "ok");
});

test("a small index is verified by metadata only and never reads the body or counts lines", async (t) => {
  const f = await environment(t);
  await mkdir(f.paths.projectDir, { recursive: true });
  const index = join(f.paths.projectDir, "MEMORY.md");
  const secret = "top-secret-body-marker\n".repeat(4);
  await writeFile(index, secret);
  const tracked = access;
  let reads = 0;
  const permissions: typeof access = async (path, mode) => { reads++; return tracked(path, mode); };
  const metadata: NonNullable<DoctorOptions["metadata"]> = async (path) => { if (String(path) === index) reads++; return lstat(path); };
  const checks = await diagnoseMemory(f.context(), { binary: stableBinary, permissions, metadata });
  const check = find(checks, "project.index");
  assert.equal(check.level, "ok");
  assert.match(check.reason, /索引大小：\d+ 字节/);
  assert.match(check.reason, /在 25KiB 字节上限内/);
  assert.match(check.reason, /未检查 200 行上限/);
  assert.equal(check.reason.includes("top-secret-body-marker"), false);
  assert.ok(reads > 0);
});

test("an index over 25KiB warns about truncation and the unchecked line limit without reading content", async (t) => {
  const f = await environment(t);
  await mkdir(f.paths.projectDir, { recursive: true });
  const index = join(f.paths.projectDir, "MEMORY.md");
  const filler = "x".repeat(26 * 1024);
  await writeFile(index, filler);
  const checks = await diagnoseMemory(f.context(), { binary: stableBinary });
  const check = find(checks, "project.index");
  assert.equal(check.level, "warning");
  assert.match(check.reason, /25KiB 加载上限会截断它/);
  assert.match(check.reason, /未检查 200 行上限/);
  assert.equal(check.reason.includes(filler), false);
  assert.equal(find(checks, "project.directory").level, "ok");
});

test("symbolic link or unexpected type in the memory tree fails path checks without following the target", async (t) => {
  const f = await environment(t);
  await mkdir(f.paths.projectDir, { recursive: true });
  const outside = join(f.root, "outside.md");
  await writeFile(outside, "outside body");
  const index = join(f.paths.projectDir, "MEMORY.md");
  await writeFile(index, "real body");
  await rm(index);
  await symlink(outside, index);
  const linked = await diagnoseMemory(f.context(), { binary: stableBinary });
  assert.equal(find(linked, "project.index").level, "failure");
  assert.match(find(linked, "project.index").reason, /路径安全检查拒绝了符号链接或无效的父级类型/);
  assert.match(find(linked, "project.index").advice!, /未更改任何权限/);
  assert.equal(await readFile(outside, "utf8"), "outside body");
  await rm(index);
  await mkdir(index);
  const directory = await diagnoseMemory(f.context(), { binary: stableBinary });
  assert.equal(find(directory, "project.index").level, "failure");
  assert.match(find(directory, "project.index").reason, /文件类型异常或为符号链接/);
  assert.equal(find(directory, "project.directory").level, "ok");
});

test("permission failures are reported with advice and never change permissions", async (t) => {
  const f = await environment(t);
  await mkdir(f.paths.projectDir, { recursive: true });
  const index = join(f.paths.projectDir, "MEMORY.md");
  await writeFile(index, "body");
  const info = await stat(index);
  const permissions: typeof access = async (path) => { if (String(path) === index) { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EACCES"; throw error; } return access(path); };
  const tracked: typeof access = access;
  const metadata: NonNullable<DoctorOptions["metadata"]> = (path: string) => lstat(path);
  const checks = await diagnoseMemory(f.context(), { binary: stableBinary, permissions, metadata });
  assert.equal(find(checks, "project.index").level, "failure");
  assert.match(find(checks, "project.index").reason, /读取或遍历权限不可用/);
  assert.equal(find(checks, "project.directory").level, "ok");
  assert.equal(find(checks, "project.index").reason.includes("denied"), false);
  const after = await stat(index);
  assert.equal(after.mode, info.mode);
  await tracked(index);
});

test("diagnosis does not create files or locks, change the store coverage or pending edit or alter file tree", async (t) => {
  const f = await environment(t);
  const config = await MemoryConfig.create(f.agentDir);
  const store = new MemoryStore(f.paths, config);
  const target = join(f.paths.projectDir, "topic.md");
  const indexFile = join(f.paths.projectDir, "MEMORY.md");
  await store.write(indexFile, "index body");
  await store.write(target, "baseline text");
  await store.readFull(target);
  const sizeBefore = (await stat(target)).size;
  const before = await snapshot(f.root);
  for (const checks of [await diagnoseMemory(f.context(), { binary: existingBinary }), await diagnoseMemory(f.context(), { binary: stableBinary, hostVersion: null, nodeVersion: "22.18.0" })]) {
    assert.ok(checks.length > 0);
    assert.equal(find(checks, "project.index").reason.includes("index body"), false);
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal((await stat(target)).size, sizeBefore);
  }
  await store.write(target, "pending edit");
  assert.equal(await readFile(target, "utf8"), "pending edit");
  assert.equal(await store.readFull(target), "pending edit");
  await store.readFull(target);
  await store.write(target, "committed edit");
  assert.equal(await readFile(target, "utf8"), "committed edit");
  assert.equal((await config.inspect()).status, "known");
});

test("generation or cwd invalidation barrier aborts the old diagnosis before a report is produced", async (t) => {
  const f = await environment(t);
  await mkdir(f.paths.projectDir, { recursive: true });
  await writeFile(join(f.paths.projectDir, "MEMORY.md"), "index");
  let ready!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let current = true;
  let paused = false;
  const context = f.context({
    assertCurrent: () => { if (!current) throw new Error("Memory diagnosis invalidated by a session change; retry in the current session."); },
    identify: async () => {
      if (!paused) { paused = true; ready(); await barrier; }
      return f.project;
    },
  });
  const pending = diagnoseMemory(context, { binary: stableBinary });
  await started;
  current = false;
  release();
  await assert.rejects(pending, /invalidated by a session change/);
});

test("reports never echo configuration secrets, bodies or raw exceptions", async (t) => {
  const f = await environment(t);
  await mkdir(f.agentDir, { recursive: true });
  await writeFile(join(f.agentDir, "auto-memory.json"), '{"version":1,"enabled":true,"secret":"S3CRET-TOKEN-VALUE"}');
  const context = f.context({ tools: () => { throw new Error("raw-tool-exception"); } });
  const checks = await diagnoseMemory(context, { binary: async () => { throw new Error("raw-binary-exception"); } });
  assert.equal(find(checks, "config").level, "ok");
  assert.equal(find(checks, "tools").level, "unchecked");
  assert.match(find(checks, "tools").reason, /无法检查工具注册状态/);
  const text = formatDoctor(checks);
  for (const forbidden of ["S3CRET-TOKEN-VALUE", "raw-tool-exception", "raw-binary-exception"]) assert.equal(text.includes(forbidden), false);
  assert.match(text, /记忆 doctor：仅做当前时刻的只读检查/);
  assert.match(text, /未更改开关、快照、受管理读取许可或任何待处理操作/);
});
