import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../src/pi/commands.js";
import { MemoryActivity } from "../src/pi/activity.js";
import { registerLifecycle } from "../src/pi/lifecycle.js";
import { MemoryStore } from "../src/core/store.js";
import { MemoryPaths } from "../src/core/paths.js";
import { makeStore } from "./helpers/store.js";
import type { MemoryRuntime, DiagnosticContext } from "../src/pi/registration.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = await makeStore(join(root, "agent"));
  const path = join(writer.paths.projectDir, "topic.md");
  await writer.write(path, "original");
  const store = await makeStore(join(root, "agent"));
  const reports: string[] = [];
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => { throw new Error("No command"); };
  let resets = 0;
  const reasons: (string | undefined)[] = [];
  const activity = new MemoryActivity();
  const runtime: MemoryRuntime = { activity, getStore: async () => store, reset: () => { resets++; store.invalidate(); } };
  const events = new Map<string, ((event: any, ctx: ExtensionCommandContext) => any)[]>();
  const pi = { on: (event: string, callback: (event: any, ctx: ExtensionCommandContext) => any) => { events.set(event, [...(events.get(event) ?? []), callback]); },
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    sendMessage: (message: { content: string }) => reports.push(message.content),
    sendUserMessage: () => { assert.fail("Management commands must not start model tasks"); },
  } as unknown as ExtensionAPI;
  const lifecycle = registerLifecycle(pi, runtime);
  registerCommands(pi, runtime, { lifecycleState: lifecycle.status, resetLifecycle: (reason) => { reasons.push(reason); lifecycle.reset(reason); } });
  const ui = {
    notify: (text: string) => reports.push(text),
    select: async (_title: string, _options: string[]): Promise<string | undefined> => undefined,
    editor: async (_title: string, _prefill: string): Promise<string | undefined> => undefined,
    confirm: async (_title: string, _message: string) => false,
  };
  const ctx = { cwd: root, hasUI: true, mode: "tui", ui } as unknown as ExtensionCommandContext;
  const run = (args: string) => handler(args, ctx);
  const emit = (event: string) => { for (const callback of events.get(event) ?? []) callback({ type: event }, ctx); };
  const task = async () => {
    const systemPromptOptions = { sections: {} };
    for (const callback of events.get("before_agent_start") ?? []) await callback({ messageType: "user", systemPromptOptions }, ctx);
  };
  return { root, writer, store, path, reports, ui, ctx, run, runtime, lifecycle, activity, pi, emit, task, resets: () => resets, reasons: () => reasons };
}

test("doctor uses the same report in explicit, menu and noninteractive commands without obtaining a store", async (t) => {
  const f = await fixture(t);
  const context: DiagnosticContext = {
    agentDir: f.store.config.agentDir, child: true, assertCurrent() {},
    identify: async () => { throw new Error("Child identity must not be inspected"); },
    tools: () => ({ entries: [], paused: false }),
  };
  f.runtime.diagnostics = () => context;
  f.runtime.getStore = async () => { throw new Error("Store must not be obtained"); };
  await f.run("doctor");
  const expected = f.reports.at(-1)!;
  assert.match(expected, /记忆 doctor：仅做当前时刻的只读检查/);
  assert.match(expected, /\[failure\] runtime\.scope/);
  assert.match(expected, /\[ok\] runtime\.node/);
  assert.match(expected, /runner 子会话不受支持/);
  f.ctx.hasUI = false;
  await f.run("doctor");
  assert.equal(f.reports.at(-1), expected);
  f.ctx.hasUI = true;
  f.ui.select = async (_title, choices) => { assert.ok(choices.includes("诊断")); return "诊断"; };
  await f.run("");
  assert.equal(f.reports.at(-1), expected);
  assert.equal(f.resets(), 0);
  assert.equal(f.lifecycle.status().loaded, false);
});

test("doctor extra arguments skip all probes and stale observations never publish a report", async (t) => {
  const f = await fixture(t);
  f.runtime.getStore = async () => { throw new Error("Store must not be obtained"); };
  f.runtime.diagnostics = () => { throw new Error("Probe must not run"); };
  await f.run("doctor extra");
  assert.match(f.reports.at(-1)!, /用法：/);
  f.runtime.diagnostics = () => ({
    agentDir: f.store.config.agentDir, child: false,
    assertCurrent() { throw new Error("Memory diagnosis invalidated by a session change; retry in the current session."); },
    identify: async () => { throw new Error("Unexpected identity lookup"); },
    tools: () => ({ entries: [], paused: false }),
  });
  await f.run("doctor");
  assert.match(f.reports.at(-1)!, /诊断失败.*会话变化使诊断失效/);
  assert.doesNotMatch(f.reports.at(-1)!, /记忆 doctor：/);
});

test("status and noninteractive explicit commands work without loading bodies; unknown config is not overwritten", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.store, "readBuffer", async () => { throw new Error("Body must not be read"); });
  t.mock.method(f.store, "readFull", async () => { throw new Error("Body must not be read"); });
  f.ctx.hasUI = false; f.ctx.mode = "print";
  await f.run("status");
  assert.match(f.reports.at(-1)!, /记忆：开启/);
  assert.match(f.reports.at(-1)!, /前 200 行 \/ 25KiB/);
  assert.match(f.reports.at(-1)!, /\/memory reload 将刷新安排到下一条用户任务/);
  assert.match(f.reports.at(-1)!, /旧的受管理读取与待提交编辑或保存失效/);
  assert.match(f.reports.at(-1)!, /关闭或刷新后历史上下文仍保留/);
  await f.run("off");
  assert.equal((await f.store.config.read()).enabled, false);
  assert.equal(f.resets(), 1);
  assert.deepEqual(f.reasons(), ["toggle"]);
  await f.run("status");
  assert.match(f.reports.at(-1)!, /记忆：关闭/);
  assert.doesNotMatch(f.reports.join("\n"), /original/);
  await f.run(""); assert.match(f.reports.at(-1)!, /用法：/);
  await f.run("on"); assert.equal((await f.store.config.read()).enabled, true);
  assert.deepEqual(f.reasons(), ["toggle", "toggle"]);
  await writeFile(f.store.config.path, "corrupt");
  await f.run("status"); assert.match(f.reports.at(-1)!, /暂停/);
  await f.run("on"); assert.match(f.reports.at(-1)!, /auto-memory\.json/);
  assert.equal(await readFile(f.store.config.path, "utf8"), "corrupt");
  await f.run("status extra"); assert.match(f.reports.at(-1)!, /用法：/);
});

test("list browses index and nested files, refreshes names after viewing, and exits on cancellation", async (t) => {
  const f = await fixture(t);
  await f.writer.write(join(f.store.paths.projectDir, "MEMORY.md"), "index");
  await f.writer.write(join(f.store.paths.projectDir, "notes/topic.md"), "nested");
  const selections = ["MEMORY.md", "notes/topic.md", undefined];
  let selected = 0;
  f.ui.select = async (_title, names) => {
    assert.deepEqual(names, selected === 0 ? ["MEMORY.md", "notes/topic.md", "topic.md"]
      : ["MEMORY.md", "added.md", "notes/topic.md", "topic.md"]);
    return selections[selected++];
  };
  const viewed: string[] = [];
  f.ui.editor = async (title, prefill) => {
    assert.match(title, /只读查看/);
    viewed.push(prefill);
    if (viewed.length === 1) await f.writer.write(join(f.store.paths.projectDir, "added.md"), "new");
    return "not saved";
  };
  await f.run("list");
  assert.deepEqual(viewed, ["index", "nested"]);
  assert.equal(selected, 3);
});

test("menu routes file viewing through list and does not expose a view subcommand", async (t) => {
  const f = await fixture(t);
  let selected = 0;
  f.ui.select = async (_title, names) => {
    if (selected++ === 0) {
      assert.ok(names.includes("列出文件"));
      assert.ok(!names.includes("View index"));
      return "列出文件";
    }
    assert.deepEqual(names, ["topic.md"]);
    return undefined;
  };
  await f.run("");
  assert.equal(selected, 2);
  await f.run("view");
  assert.match(f.reports.at(-1)!, /用法：/);
});

test("empty or absent memory directories report no files without creating an index", async (t) => {
  const f = await fixture(t);
  f.ui.select = async () => { assert.fail("No selector for an empty directory"); };
  await rm(f.path);
  await f.run("list");
  assert.match(f.reports.at(-1)!, /没有可选择的项目文件/);
  await rm(f.store.paths.projectDir, { recursive: true });
  await f.run("list");
  assert.match(f.reports.at(-1)!, /没有可选择的项目文件/);
  await assert.rejects(stat(f.store.paths.projectDir), { code: "ENOENT" });
});

test("noninteractive and off lists report only names, and unavailable lists never read bodies or open UI", async (t) => {
  for (const mode of ["print", "off", "unknown", "compatibility", "child", "extra"]) {
    const f = await fixture(t);
    let reads = 0;
    const read = t.mock.method(MemoryStore.prototype, "readBuffer", async () => { reads++; throw new Error("No body access"); });
    f.ui.select = async () => { assert.fail("No selector"); };
    f.ui.editor = async () => { assert.fail("No viewer"); };
    if (mode === "print") { f.ctx.hasUI = false; f.ctx.mode = "print"; }
    if (mode === "off") await f.store.config.setEnabled(false);
    if (mode === "unknown") await writeFile(f.store.config.path, "corrupt");
    if (mode === "compatibility") t.mock.method(f.store.config, "read", async () => ({ status: "unknown", enabled: false, fault: "Memory paused: incompatible same-name tool override (read)." }));
    if (mode === "child") Object.defineProperty(f.store, "child", { value: true });
    await f.run(mode === "extra" ? "list extra" : "list");
    assert.equal(reads, 0, mode);
    assert.doesNotMatch(f.reports.join("\n"), /original/);
    if (mode === "print" || mode === "off") assert.match(f.reports.join("\n"), /记忆文件：\ntopic.md/);
    if (mode === "off") assert.match(f.reports.at(-1)!, /记忆已关闭.*\/memory on/);
    if (mode === "unknown") assert.match(f.reports.at(-1)!, /auto-memory.json/);
    if (mode === "compatibility") assert.match(f.reports.at(-1)!, /工具兼容性冲突.*暂时停用/);
    if (mode === "child") assert.match(f.reports.at(-1)!, /runner 子会话/);
    if (mode === "extra") assert.match(f.reports.at(-1)!, /用法：/);
    read.mock.restore();
  }
});

test("list viewer keeps file contents, metadata and model coverage unchanged with character-safe limits", async (t) => {
  const f = await fixture(t);
  const contents = new Map([
    ["MEMORY.md", "index\n"],
    ["topic.md", `---\nname: topic\nmodified: 2020-01-01\n---\n${Array(201).fill("line").join("\n")}`],
    ["unicode.txt", `${"界".repeat(8532)}😀tail`],
    ["long.md", "z".repeat(30 * 1024)],
  ]);
  for (const [name, text] of contents) await writeFile(join(f.store.paths.projectDir, name), text);
  const before = new Map(await Promise.all([...contents.keys()].map(async (name) => [name, await stat(join(f.store.paths.projectDir, name), { bigint: true })] as const)));
  const selected = [...contents.keys(), undefined];
  f.ui.select = async () => selected.shift();
  const seen: string[] = [];
  const read = t.mock.method(MemoryStore.prototype, "readFull", async () => { assert.fail("Viewing must not record coverage"); });
  f.ui.editor = async (title, prefill) => {
    const name = [...contents.keys()][seen.length];
    seen.push(name);
    assert.ok(title.startsWith(name));
    assert.match(title, /只读查看.*200 行 \/ 25KiB/);
    assert.ok(Buffer.byteLength(prefill) <= 25 * 1024);
    assert.ok(prefill.split("\n").length - (prefill.endsWith("\n") ? 1 : 0) <= 200);
    assert.doesNotMatch(prefill, /�/);
    if (name === "MEMORY.md") { assert.doesNotMatch(title, /已截断/); assert.equal(prefill, "index\n"); }
    else assert.match(title, /已截断/);
    if (name === "unicode.txt") assert.equal(prefill, `${"界".repeat(8532)}😀`);
    if (name === "long.md") assert.equal(prefill.length, 25 * 1024);
    return "discarded changes";
  };
  await f.run("list");
  read.mock.restore();
  assert.deepEqual(seen, [...contents.keys()]);
  for (const [name, text] of contents) {
    const path = join(f.store.paths.projectDir, name);
    assert.equal(await readFile(path, "utf8"), text);
    const after = await stat(path, { bigint: true });
    const original = before.get(name)!;
    for (const field of ["ino", "size", "mode", "mtimeNs", "ctimeNs"] as const) assert.equal(after[field], original[field], `${name}: ${field}`);
    await assert.rejects(f.store.write(path, "unseen model overwrite"), /no complete read baseline/);
  }
});

test("list skips file and directory links and never lists another project", async (t) => {
  const f = await fixture(t);
  const other = new MemoryStore(await MemoryPaths.create(f.store.paths.agentDir, `cwd-${"c".repeat(64)}`), f.store.config, false);
  const otherPath = join(other.paths.projectDir, "other.md");
  await other.write(otherPath, "OTHER_PROJECT_BODY");
  await symlink(otherPath, join(f.store.paths.projectDir, "file-link.md"));
  await symlink(other.paths.projectDir, join(f.store.paths.projectDir, "directory-link"));
  f.ui.select = async (_title, names) => { assert.deepEqual(names, ["topic.md"]); return undefined; };
  await f.run("list");
  assert.doesNotMatch(f.reports.join("\n"), /OTHER_PROJECT_BODY|other.md/);
});

test("list rejects selection after off, unknown config, session changes, deletion or link replacement", async (t) => {
  for (const change of ["off", "unknown", "session_start", "session_tree", "session_shutdown", "different-store", "deleted", "link"]) {
    const f = await fixture(t);
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "OUTSIDE_BODY");
    f.ui.editor = async () => { assert.fail(`No body should be displayed after ${change}`); };
    let reads = 0;
    const read = t.mock.method(MemoryStore.prototype, "readBuffer", async () => { reads++; assert.fail("No body read after selection invalidation"); });
    f.ui.select = async () => {
      if (change === "off") await f.store.config.setEnabled(false);
      else if (change === "unknown") await writeFile(f.store.config.path, "corrupt");
      else if (change === "different-store") {
        const next = await makeStore(join(f.root, "next-agent"));
        t.mock.method(f.runtime, "getStore", async () => next);
      } else if (change === "deleted" || change === "link") {
        await rm(f.path);
        if (change === "link") await symlink(outside, f.path);
      } else f.emit(change);
      return "topic.md";
    };
    if (change === "deleted") {
      read.mock.restore();
      const original = MemoryStore.prototype.readBuffer;
      t.mock.method(MemoryStore.prototype, "readBuffer", async function (this: MemoryStore, path: string) {
        reads++;
        return original.call(this, path);
      });
    }
    await f.run("list");
    assert.equal(reads, change === "deleted" ? 1 : 0, change);
    assert.match(f.reports.at(-1)!, change === "off" ? /记忆已关闭/ : change === "unknown" ? /auto-memory\.json/
      : change === "deleted" ? /记忆文件已消失，无法查看/ : change === "link" ? /符号链接/
      : change === "different-store" ? /记忆文件已不可用|文件浏览已失效/ : /会话变化，文件浏览已失效/, change);
    assert.doesNotMatch(f.reports.join("\n"), /original|OUTSIDE_BODY/);
    if (change === "deleted") await assert.rejects(stat(f.path), { code: "ENOENT" });
    t.mock.restoreAll();
  }
});

test("list checks session and configuration again after reading and during enumeration", async (t) => {
  for (const phase of ["enumeration", "read-off", "read-session"]) {
    const f = await fixture(t);
    f.ui.editor = async () => { assert.fail("No viewer after invalidation"); };
    f.ui.select = async () => { assert.notEqual(phase, "enumeration"); return "topic.md"; };
    if (phase === "enumeration") {
      const check = f.store.paths.assertCurrent.bind(f.store.paths);
      t.mock.method(f.store.paths, "assertCurrent", async (path: string) => {
        const result = await check(path);
        await f.store.config.setEnabled(false);
        return result;
      });
    } else {
      const read = MemoryStore.prototype.readBuffer;
      t.mock.method(MemoryStore.prototype, "readBuffer", async function (this: MemoryStore, path: string) {
        const result = await read.call(this, path);
        if (phase === "read-off") await f.store.config.setEnabled(false);
        else f.emit("session_tree");
        return result;
      });
    }
    await f.run("list");
    assert.match(f.reports.at(-1)!, phase === "read-session" ? /会话变化，文件浏览已失效/ : /记忆已关闭/);
    t.mock.restoreAll();
  }
});

test("reload resets a loaded snapshot exactly once without config writes, body reads or model calls", async (t) => {
  for (const standalone of [false, true]) {
    const f = await fixture(t);
    await f.task();
    assert.equal(f.lifecycle.status().loaded, true);
    await f.store.config.setEnabled(true);
    const before = await readFile(f.store.config.path);
    const metadata = await stat(f.store.config.path, { bigint: true });
    const reads = t.mock.method(MemoryStore.prototype, "readBuffer", async () => { assert.fail("Reload must not read bodies"); });
    t.mock.method(f.store.config, "setEnabled", async () => { assert.fail("Reload must not write config"); });
    t.mock.method(f.pi, "sendUserMessage", () => { assert.fail("Reload must not start a model task"); });
    if (standalone) registerCommands(f.pi, f.runtime);
    await f.run("reload");
    assert.equal(f.resets(), 1);
    if (!standalone) {
      assert.equal(f.reasons().at(-1), "refresh");
      assert.equal(f.activity.snapshot().phase, "refresh");
      assert.equal(f.lifecycle.status().loaded, false);
      await f.run("status");
      assert.match(f.reports.at(-1)!, /索引快照：尚未加载|索引快照：刷新已安排/);
    }
    assert.match(f.reports.join("\n"), /下一条用户任务将重载索引.*旧的受管理读取与待提交编辑或保存已失效.*历史上下文仍保留/);
    assert.deepEqual(await readFile(f.store.config.path), before);
    assert.equal((await stat(f.store.config.path, { bigint: true })).mtimeNs, metadata.mtimeNs);
    reads.mock.restore();
  }
});

test("reload menu resets once; off, unknown, compatibility, child and extra arguments refuse reset", async (t) => {
  const menu = await fixture(t);
  menu.ui.select = async (_title, choices) => { assert.ok(choices.includes("刷新")); return "刷新"; };
  await menu.run("");
  assert.equal(menu.resets(), 1);
  assert.equal(menu.reasons().at(-1), "refresh");
  for (const mode of ["off", "unknown", "compatibility", "child", "extra"]) {
    const f = await fixture(t);
    const read = t.mock.method(MemoryStore.prototype, "readBuffer", async () => { assert.fail("No body read"); });
    if (mode === "off") await f.store.config.setEnabled(false);
    if (mode === "unknown") await writeFile(f.store.config.path, "corrupt");
    if (mode === "compatibility") t.mock.method(f.store.config, "read", async () => ({ status: "unknown", enabled: false, fault: "Memory paused: incompatible tool override." }));
    if (mode === "child") Object.defineProperty(f.store, "child", { value: true });
    await f.run(mode === "extra" ? "reload extra" : "reload");
    assert.equal(f.resets(), 0, mode);
    assert.match(f.reports.at(-1)!, mode === "off" ? /记忆已关闭.*\/memory on/ : mode === "unknown" ? /auto-memory\.json/
      : mode === "compatibility" ? /工具兼容性冲突.*暂时停用/ : mode === "child" ? /runner 子会话/ : /用法：/);
    if (mode === "off") assert.equal((await f.store.config.read()).enabled, false);
    if (mode === "unknown") assert.equal(await readFile(f.store.config.path, "utf8"), "corrupt");
    read.mock.restore();
  }
});

test("editor works on a private temporary copy; cancel/secret rejection preserve formal file and model permissions", async (t) => {
  const f = await fixture(t);
  let temporary: string | undefined;
  f.ui.editor = async (_title, prefill) => {
    assert.equal(prefill, "original");
    const entries = (await readdir(f.store.paths.agentDir)).filter((name) => name.startsWith(".auto-memory-edit-"));
    assert.equal(entries.length, 1);
    temporary = join(f.store.paths.agentDir, entries[0]);
    assert.equal((await stat(temporary)).mode & 0o777, 0o700);
    assert.equal((await stat(join(temporary, "draft.md"))).mode & 0o777, 0o600);
    return undefined;
  };
  await f.run("edit topic.md");
  assert.equal(await readFile(f.path, "utf8"), "original");
  assert.match(f.reports.at(-1)!, /已取消编辑/);
  await assert.rejects(stat(temporary!), { code: "ENOENT" });
  await assert.rejects(f.store.write(f.path, "model overwrite"), /no complete read baseline/);
  const secret = `sk-proj-${"SYNTHETIC1234".repeat(4)}`;
  f.ui.editor = async () => secret;
  await f.run("edit topic.md");
  assert.match(f.reports.at(-1)!, /检测到疑似敏感凭据/);
  assert.equal(f.reports.join("\n").includes(secret), false);
  assert.equal(await readFile(f.path, "utf8"), "original");
  assert.equal((await readdir(f.store.paths.agentDir)).some((name) => name.startsWith(".auto-memory-edit-")), false);
});

test("editor conflict and off-during-edit reject; successful user edit never grants model a newer unseen baseline", async (t) => {
  const f = await fixture(t);
  f.ui.editor = async () => { await f.writer.write(f.path, "concurrent"); return "old editor"; };
  await f.run("edit topic.md");
  assert.match(f.reports.at(-1)!, /保存冲突：文件版本已变化/);
  assert.equal(await readFile(f.path, "utf8"), "concurrent");
  f.ui.editor = async () => { await f.writer.config.setEnabled(false); return "disabled editor"; };
  await f.run("edit topic.md");
  assert.match(f.reports.at(-1)!, /记忆已关闭/);
  assert.equal(await readFile(f.path, "utf8"), "concurrent");
  await f.writer.config.setEnabled(true);
  await f.store.readFull(f.path);
  f.ui.editor = async () => "user edit";
  await f.run("edit topic.md");
  assert.equal(await readFile(f.path, "utf8"), "user edit");
  assert.match(f.reports.at(-1)!, /主题文件已保存.*按需读取/);
  await assert.rejects(f.store.write(f.path, "overwrite old model snapshot"), /stale version/);
});

test("editor lifecycle owner rejects old drafts after session events even when runtime returns the same store", async (t) => {
  for (const event of ["session_start", "session_tree", "session_shutdown", "reload"]) {
    const f = await fixture(t);
    f.ui.editor = async () => { if (event === "reload") await f.run("reload"); else f.emit(event); return "invalid draft"; };
    await f.run("edit topic.md");
    assert.match(f.reports.at(-1)!, /会话变化，编辑已失效|会话变化使旧操作失效/, event);
    assert.equal(await readFile(f.path, "utf8"), "original");
    assert.equal((await readdir(f.store.paths.agentDir)).some((name) => name.startsWith(".auto-memory-edit-")), false);
    f.ui.editor = async () => "fresh draft";
    await f.run("edit topic.md");
    assert.equal(await readFile(f.path, "utf8"), "fresh draft");
    await assert.rejects(f.store.write(f.path, "unseen"), /no complete read baseline/);
  }
});

test("editor lifecycle owner rejects session invalidation after the runtime identity check, immediately before rename", async (t) => {
  for (const event of ["session_start", "session_tree", "session_shutdown", "reload"]) {
    const f = await fixture(t);
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const write = MemoryStore.prototype.write;
    const mock = t.mock.method(MemoryStore.prototype, "write", function (this: MemoryStore, path: string, text: string) {
      return write.call(this, path, text, { beforeRename: async () => { ready(); await barrier; } });
    });
    f.ui.editor = async () => "must not rename";
    const pending = f.run("edit topic.md");
    await started;
    if (event === "reload") await f.run("reload"); else f.emit(event);
    release();
    await pending;
    mock.mock.restore();
    assert.match(f.reports.at(-1)!, /会话变化，编辑已失效|会话变化使旧操作失效/, event);
    assert.equal(await readFile(f.path, "utf8"), "original");
    assert.equal((await readdir(f.store.paths.projectDir)).some((name) => name.endsWith(".tmp")), false);
    assert.equal((await readdir(f.store.paths.agentDir)).some((name) => name.startsWith(".auto-memory-edit-")), false);
  }
});

test("relative selection refuses escapes/aliases and edit without UI; cancellation leaves files unchanged", async (t) => {
  const f = await fixture(t);
  for (const target of [f.path, "../topic.md", "dir/../../topic.md", "."]) {
    await f.run(`edit ${target}`); assert.match(f.reports.at(-1)!, /目标必须是当前项目的相对文件名/);
  }
  f.ctx.hasUI = false; f.ctx.mode = "print";
  await f.run("edit topic.md"); assert.match(f.reports.at(-1)!, /记忆编辑需要交互式编辑器/);
  await f.run("delete topic.md"); assert.match(f.reports.at(-1)!, /记忆删除需要显式确认界面/);
  f.ctx.hasUI = true; f.ctx.mode = "tui";
  f.ui.select = async (_title, options) => { assert.deepEqual(options, ["topic.md"]); return undefined; };
  await f.run("edit");
  assert.equal(await readFile(f.path, "utf8"), "original");
});

test("delete while off is metadata-only and single-target; cancellation/changed target require reconfirmation", async (t) => {
  const f = await fixture(t);
  const sibling = join(f.store.paths.projectDir, "sibling.md");
  await f.writer.write(sibling, "keep sibling");
  await f.store.config.setEnabled(false);
  t.mock.method(f.store, "readBuffer", async () => { throw new Error("No body access during delete"); });
  t.mock.method(f.store, "readFull", async () => { throw new Error("No body access during delete"); });
  await f.run("delete topic.md");
  assert.equal(await readFile(f.path, "utf8"), "original");
  f.ui.confirm = async (_title, message) => {
    assert.ok(message.includes(f.path));
    assert.match(message, /本扩展不提供撤销/);
    assert.match(message, /历史上下文/);
    assert.match(message, /重新记住/);
    await writeFile(f.path, "changed while confirming");
    return true;
  };
  await f.run("delete topic.md"); assert.match(f.reports.at(-1)!, /目标已变化或消失.*重新确认删除目标/);
  assert.equal(await readFile(f.path, "utf8"), "changed while confirming");
  f.ui.confirm = async () => true;
  await f.run("delete topic.md");
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  assert.equal(await readFile(sibling, "utf8"), "keep sibling");
  assert.match(f.reports.at(-1)!, /不是永久忘记.*本扩展不提供撤销/);
});

test("status renders current activity, distinguishes phases and never reads bodies when off", async (t) => {
  const f = await fixture(t);
  const now = new Date("2026-01-02T03:04:05.000Z");
  const activity = new MemoryActivity(() => now);
  f.runtime.activity = activity;
  const read = t.mock.method(MemoryStore.prototype, "readBuffer", async () => { assert.fail("Status must not read bodies"); });
  await f.run("status");
  assert.match(f.reports.at(-1)!, /索引快照：等待首次用户任务加载/);
  assert.match(f.reports.at(-1)!, /本会话未观察到向模型返回的记忆主题正文/);
  assert.match(f.reports.at(-1)!, /这不代表磁盘为空或模型未使用历史/);
  activity.prepared(true);
  await f.run("status");
  assert.match(f.reports.at(-1)!, /索引快照：已准备，等待该请求成功注入/);
  activity.projected();
  await f.run("status");
  assert.match(f.reports.at(-1)!, /索引快照：已成功注入（首次投影时间：2026-01-02T03:04:05\.000Z）/);
  assert.match(f.reports.at(-1)!, /当前为空索引/);
  const observe = activity.bind(f.store.paths.projectDir).capture("model");
  observe({ kind: "save", path: join(f.store.paths.projectDir, "topic.md") });
  observe({ kind: "save", path: join(f.store.paths.projectDir, "MEMORY.md") });
  observe({ kind: "read", path: join(f.store.paths.projectDir, "topic.md"), digest: "d", length: 10, start: 0, end: 4 });
  await f.run("status");
  assert.match(f.reports.at(-1)!, /最近保存：MEMORY\.md（来源：模型工具/);
  assert.match(f.reports.at(-1)!, /已知索引变更：本实例已修改或删除 MEMORY\.md/);
  assert.match(f.reports.at(-1)!, /topic\.md（局部读取/);
  assert.match(f.reports.at(-1)!, /不代表模型理解或遵循记忆/);
  observe({ kind: "read", path: join(f.store.paths.projectDir, "topic.md"), digest: "d", length: 10, start: 4, end: 10 });
  await f.run("status");
  assert.match(f.reports.at(-1)!, /topic\.md（完整读取/);
  await f.store.config.setEnabled(false);
  await f.run("status");
  assert.match(f.reports.at(-1)!, /记忆：关闭/);
  assert.match(f.reports.at(-1)!, /以上保存和读取均为历史记录；当前不注入索引/);
  assert.match(f.reports.at(-1)!, /topic\.md（完整读取/);
  assert.doesNotMatch(f.reports.join("\n"), /original/);
  t.mock.method(f.store.config, "read", async () => ({ status: "unknown", enabled: false, fault: "Memory paused: incompatible same-name tool override (read)." }));
  activity.fault("Memory paused: incompatible same-name tool override (read).");
  await f.run("status");
  assert.match(f.reports.at(-1)!, /索引快照：暂停。原因：工具兼容性冲突/);
  assert.match(f.reports.at(-1)!, /以上保存和读取均为历史记录；当前不注入索引/);
  read.mock.restore();
});

test("reload and toggle report lifecycle reasons; failed reload keeps history and does not reset", async (t) => {
  const f = await fixture(t);
  await f.task();
  const observe = f.activity.bind(f.store.paths.projectDir).capture("model");
  observe({ kind: "save", path: join(f.store.paths.projectDir, "topic.md") });
  observe({ kind: "read", path: join(f.store.paths.projectDir, "topic.md"), digest: "d", length: 5, start: 0, end: 5 });
  await f.run("reload");
  assert.deepEqual(f.reasons().at(-1), "refresh");
  assert.equal(f.activity.snapshot().phase, "refresh");
  await f.run("status");
  assert.match(f.reports.at(-1)!, /索引快照：刷新已安排，等待下一条用户任务加载/);
  assert.match(f.reports.at(-1)!, /最近保存：topic\.md（来源：模型工具/);
  assert.match(f.reports.at(-1)!, /topic\.md（完整读取/);
  await f.run("off");
  assert.deepEqual(f.reasons().at(-1), "toggle");
  await f.run("on");
  assert.deepEqual(f.reasons().at(-1), "toggle");
  assert.equal(f.activity.snapshot().phase, "refresh");
  assert.equal(f.lifecycle.status().loaded, false);
  assert.match(f.reports.at(-1)!, /其他会话在下一任务或访问检查时感知变化/);
  const before = f.resets();
  await f.task();
  await f.store.config.setEnabled(true);
  f.runtime.getStore = async () => f.store.fork();
  await f.run("reload");
  assert.match(f.reports.at(-1)!, /会话已变化，刷新已失效/);
  assert.equal(f.resets(), before);
  assert.equal(f.activity.snapshot().phase, "prepared");
  assert.equal(f.lifecycle.status().loaded, true);
});

test("user edits are observed as user-source saves and list viewing never records model reads", async (t) => {
  const f = await fixture(t);
  const activity = new MemoryActivity();
  f.runtime.activity = activity;
  const observed = new MemoryStore(f.store.paths, f.store.config, false, undefined, undefined, activity.bind(f.store.paths.projectDir));
  f.runtime.getStore = async () => observed;
  f.ui.editor = async () => "edited by user";
  await f.run("edit topic.md");
  assert.equal(await readFile(f.path, "utf8"), "edited by user");
  const lastSave = activity.snapshot().lastSave;
  assert.deepEqual(lastSave ? { path: lastSave.path, source: lastSave.source } : undefined, { path: "topic.md", source: "user" });
  assert.equal(activity.snapshot().topics.length, 0);
  let selected = 0;
  f.ui.select = async (_title, names) => { assert.deepEqual(names, ["topic.md"]); return selected++ === 0 ? "topic.md" : undefined; };
  f.ui.editor = async (title) => { assert.match(title, /只读查看/); return "discarded"; };
  await f.run("list");
  assert.equal(activity.snapshot().topics.length, 0);
  assert.equal(f.activity.snapshot().topics.length, 0);
  assert.equal(activity.snapshot().lastSave?.source, "user");
  await f.task();
  assert.equal(activity.snapshot().phase, "prepared");
});

test("status refuses to publish a placeholder project path when identity is unverified", async (t) => {
  const f = await fixture(t);
  f.store.markIdentityUnverified();
  await f.run("status");
  const text = f.reports.at(-1)!;
  assert.match(text, /项目记忆：不可用/);
  assert.equal(text.includes("0".repeat(64)), false);
  assert.equal(text.includes(f.store.paths.projectDir), false);
  assert.match(text, /修复仓库或 Git 配置/);
});

test("management commands classify an unavailable user directory instead of reporting an unknown access failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-cmd-degraded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { registerMemoryTools } = await import("../src/pi/registration.js");
  const reports: string[] = [];
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pi = { on: () => {}, registerTool: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
    getSettings: () => ({}), registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    sendMessage: (message: { content: string }) => reports.push(message.content) } as unknown as ExtensionAPI;
  await symlink("b", join(root, "a"));
  await symlink("a", join(root, "b"));
  const runtime = registerMemoryTools(pi, { agentDir: join(root, "a", "agent") });
  registerCommands(pi, runtime, {});
  const ctx = { cwd: root, hasUI: false, mode: "print", ui: {} } as unknown as ExtensionCommandContext;
  for (const command of ["status", "reload", "on", "off", "list"]) {
    reports.length = 0;
    await handler(command, ctx);
    const report = reports.at(-1)!;
    assert.match(report, /记忆存储无法初始化/, command);
    assert.doesNotMatch(report, /访问失败（未知错误）/, command);
    assert.doesNotMatch(report, /请重试/, command);
  }
});
