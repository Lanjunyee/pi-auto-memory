import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MemoryConfig } from "../src/core/config.js";
import { MemoryPaths } from "../src/core/paths.js";
import { MemoryStore } from "../src/core/store.js";
import { indexPrefix } from "../src/core/content-policy.js";
import { registerCommands } from "../src/pi/commands.js";
import { registerLifecycle, projectMemorySection } from "../src/pi/lifecycle.js";
import { memoryGuidance } from "../src/pi/memory-guidance.js";
import { MemoryActivity } from "../src/pi/activity.js";
import { registerLifecycleProvider } from "./fixtures/lifecycle-provider.js";

const wrap = (text: string) => `<auto_memory>\n${text}\n</auto_memory>`;
const system = (sections: Record<string, string | null> = {}): SystemMessage => ({ role: "system", content: "", sections, timestamp: 1 });
const user: AgentMessage = { role: "user", content: "retain user index references: OLD_INDEX", timestamp: 2 };

async function harness(t: TestContext, text?: string | Buffer, child = false) {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await MemoryPaths.create(join(root, "agent"), `cwd-${"a".repeat(64)}`);
  await mkdir(paths.projectDir, { recursive: true });
  const path = join(paths.projectDir, "MEMORY.md");
  if (text !== undefined) await writeFile(path, text);
  const store = new MemoryStore(paths, await MemoryConfig.create(join(root, "agent")), child);
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const warnings: string[] = [];
  const ctx = { cwd: root, hasUI: true, ui: { notify: (text: string) => warnings.push(text) },
    sessionManager: { getHeader: () => ({ parentSession: "not-a-child-signal" }) } } as unknown as ExtensionContext;
  let resets = 0;
  let reads = 0;
  let configs = 0;
  let compatibilityChecks = 0;
  let compatibilityFailure: Error | undefined;
  const read = store.readBuffer.bind(store);
  store.readBuffer = async (...args) => { reads++; return read(...args); };
  const readConfig = store.config.read.bind(store.config);
  store.config.read = async () => { configs++; return readConfig(); };
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pi = { on: (name: string, handler: any) => { handlers.set(name, handler); },
    sendMessage: (message: { content: string }) => warnings.push(message.content),
    registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
  } as unknown as ExtensionAPI;
  const activity = new MemoryActivity(() => new Date(0));
  const runtime = { activity, getStore: async () => store, reset: () => { resets++; store.invalidate(); },
    assertCompatible: () => { compatibilityChecks++; if (compatibilityFailure) throw compatibilityFailure; } };
  const controller = registerLifecycle(pi, runtime);
  registerCommands(pi, runtime, { lifecycleState: controller.status, resetLifecycle: controller.reset });
  const run = (args: string) => command(args, ctx as ExtensionCommandContext);
  const emit = async (name: string, event: any = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
  const task = async (messageType = "user") => {
    const options = { sections: { foreign: "unchanged" } as Record<string, string> };
    await emit("before_agent_start", { messageType, prompt: "normal task", systemPromptOptions: options });
    return options.sections;
  };
  const project = async (messages: AgentMessage[]) => (await emit("context_with_system", { messages }))?.messages ?? messages;
  const failCompatibility = () => { compatibilityFailure = new Error("Memory paused: incompatible same-name tool override (write); disable the conflicting extension and reload."); };
  const restoreCompatibility = () => { compatibilityFailure = undefined; };
  return { root, paths, path, store, activity, controller, warnings, ctx, emit, task, project, run,
    failCompatibility, restoreCompatibility,
    counts: () => ({ reads, configs, resets, compatibilityChecks }) };
}

test("lifecycle: first user task loads once; custom runs do not load; subsequent tasks reuse the exact snapshot", async (t) => {
  const f = await harness(t, "FIRST_INDEX");
  assert.equal((await f.task("custom")).auto_memory, undefined);
  assert.equal(f.counts().reads, 0);
  const first = await f.task();
  assert.match(first.auto_memory, /FIRST_INDEX/);
  await f.project([system({ auto_memory: wrap(first.auto_memory), foreign: "keep" }), user]);
  await writeFile(f.path, "MANUAL_CHANGE");
  assert.deepEqual(await f.task(), first);
  assert.deepEqual(await f.task(), first);
  assert.equal(f.counts().reads, 1);
  assert.ok(f.counts().configs >= 4, "each run checks config, without refreshing the index");
  assert.deepEqual(f.controller.status(), { loaded: true });
  await assert.rejects(f.store.write(f.path, "stale overwrite"), /stale version/);
});

test("lifecycle: pi 1.2.0 session_start reasons and tree navigation invalidate snapshot AND read baseline", async (t) => {
  const f = await harness(t, "ENTRY_0");
  for (const [i, reason] of ["startup", "new", "resume", "reload", "fork", "tree"].entries()) {
    const loaded = await f.task();
    await f.project([system({ auto_memory: wrap(loaded.auto_memory) })]);
    await writeFile(f.path, `ENTRY_${i + 1}`);
    await f.emit(reason === "tree" ? "session_tree" : "session_start", { reason, newLeafId: "other", oldLeafId: "old" });
    assert.equal(f.controller.status().loaded, false);
    await assert.rejects(f.store.write(f.path, "not read on this branch"), /no complete read baseline/);
    assert.match((await f.task()).auto_memory, new RegExp(`ENTRY_${i + 1}`));
  }
  assert.equal(f.counts().reads, 7);
  assert.equal(f.counts().resets, 6);
});

test("lifecycle: off stops injection without clearing history; on loads next task and rejects old baselines", async (t) => {
  const f = await harness(t, "OLD_INDEX");
  const loaded = await f.task();
  const history = [system({ auto_memory: wrap(loaded.auto_memory) }), user];
  await f.project(history);
  await f.store.config.setEnabled(false);
  assert.equal((await f.task()).auto_memory, undefined);
  assert.equal(await f.project(history), history, "off leaves history untouched");
  await writeFile(f.path, "REENABLED_INDEX");
  await f.store.config.setEnabled(true);
  const current = await f.task();
  assert.match(current.auto_memory, /REENABLED_INDEX/);
  await assert.rejects(f.store.write(f.path, "not yet delivered"), /no complete read baseline/);
  await f.project([system({ auto_memory: wrap(current.auto_memory) })]);
  await f.store.write(f.path, "delivered");
  assert.equal(f.counts().reads, 2);
  assert.equal(await readFile(f.path, "utf8"), "delivered");
});

test("lifecycle: empty and missing index supply guidance; no topic scan or extra reads", async (t) => {
  for (const text of [undefined, ""]) await t.test(text === undefined ? "missing" : "empty", async (t) => {
    const f = await harness(t, text);
    await writeFile(join(f.paths.projectDir, "topic.md"), "MUST_NOT_AUTOLOAD");
    const sections = await f.task();
    assert.match(sections.auto_memory, /No index content yet/);
    assert.ok(!sections.auto_memory.includes("MUST_NOT_AUTOLOAD"));
    await f.project([system({ auto_memory: wrap(sections.auto_memory) })]);
    await f.store.write(f.path, "first index");
    await f.task();
    assert.equal(f.counts().reads, 1);
  });
});

test("lifecycle: index 200-line/25KiB prefix and same-buffer coverage, including CRLF and Unicode", async (t) => {
  for (const [label, text, complete] of [
    ["CRLF complete", "alpha\r\nbeta\r\n", true],
    ["200 CRLF lines", "x\r\n".repeat(200), true],
    ["201 CRLF lines", "x\r\n".repeat(200) + "OMITTED", false],
    ["Unicode byte cap", "界".repeat(9000), false],
    ["exact byte cap", "x".repeat(25 * 1024), true],
  ] as const) await t.test(label, async (t) => {
    const f = await harness(t, text);
    const ranges: { buffer: Buffer; start: number; end: number }[] = [];
    const original = f.store.recordRange.bind(f.store);
    f.store.recordRange = (path, buffer, start, end, generation) => { ranges.push({ buffer, start, end }); original(path, buffer, start, end, generation); };
    const sections = await f.task();
    assert.equal(ranges.length, 0, "not granted until request projection succeeds");
    const expected = indexPrefix(text);
    assert.ok(sections.auto_memory.includes(expected.prefix));
    assert.equal(sections.auto_memory.includes("[Snapshot truncated"), !complete);
    const requests = await f.project([system({ auto_memory: wrap(sections.auto_memory) })]);
    assert.equal(requests[0].role, "system");
    assert.equal(ranges.length, 1);
    assert.deepEqual(ranges[0], { buffer: Buffer.from(text), start: 0, end: Buffer.byteLength(expected.prefix) });
    if (complete) await f.store.write(f.path, "safe change");
    else await assert.rejects(f.store.write(f.path, "incomplete"), /no complete read baseline/);
    await f.project([system({ auto_memory: wrap(sections.auto_memory) })]);
    assert.equal(ranges.length, complete ? 2 : 1, "reused snapshot does not overwrite new coverage after a save");
  });
});

test("lifecycle: snapshot coverage is bound to the returned buffer even when disk changes before projection", async (t) => {
  const f = await harness(t, "BUFFER_SEEN_BY_MODEL");
  const read = f.store.readBuffer;
  f.store.readBuffer = async (...args) => {
    const result = await read(...args);
    await writeFile(f.path, "NEW_DISK_BUFFER");
    return result;
  };
  const loaded = await f.task();
  assert.match(loaded.auto_memory, /BUFFER_SEEN_BY_MODEL/);
  assert.ok(!loaded.auto_memory.includes("NEW_DISK_BUFFER"));
  await f.project([system({ auto_memory: wrap(loaded.auto_memory) })]);
  await assert.rejects(f.store.write(f.path, "overwrite changed disk"), /stale version/);
  assert.equal(f.counts().reads, 1);
});

test("lifecycle: replacement bytes from invalid UTF-8 cannot grant a complete baseline", async (t) => {
  const f = await harness(t, Buffer.from([0xff]));
  const sections = await f.task();
  await f.project([system({ auto_memory: wrap(sections.auto_memory) })]);
  await assert.rejects(f.store.write(f.path, "overwrite"), /no complete read baseline/);
});

test("lifecycle: fault warns without content and lets tasks continue; index failures are not retried until entry", async (t) => {
  const f = await harness(t, "SECRET_CANARY_NOT_LOGGED");
  const read = f.store.readBuffer;
  f.store.readBuffer = async () => { throw Object.assign(new Error("SECRET_CANARY_NOT_LOGGED"), { code: "EACCES" }); };
  assert.equal((await f.task()).auto_memory, undefined);
  assert.match(f.controller.status().fault!, /normal tasks can continue/);
  assert.ok(!f.warnings.join().includes("SECRET_CANARY"));
  f.store.readBuffer = read;
  assert.equal((await f.task()).auto_memory, undefined);
  assert.equal(f.counts().reads, 0);
  await f.emit("session_start", { reason: "resume" });
  assert.match((await f.task()).auto_memory, /SECRET_CANARY_NOT_LOGGED/);
});

test("lifecycle: print-mode faults produce visible custom notifications without extra model calls", async (t) => {
  const f = await harness(t, "CANARY");
  f.ctx.hasUI = false;
  await writeFile(f.store.config.path, "corrupt");
  assert.equal((await f.task()).auto_memory, undefined);
  assert.match(f.warnings.at(-1)!, /auto-memory.json/);
  assert.ok(!f.warnings.join().includes("CANARY"));
});

test("lifecycle: reset during an in-flight index read cannot publish an old snapshot or baseline", async (t) => {
  const f = await harness(t, "OLD_IN_FLIGHT");
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const read = f.store.readBuffer;
  f.store.readBuffer = async (...args) => {
    const result = await read(...args);
    started();
    await barrier;
    return result;
  };
  const pending = f.task();
  await ready;
  await f.emit("session_tree", { newLeafId: "new", oldLeafId: "old" });
  await writeFile(f.path, "NEW_AFTER_TREE");
  release();
  assert.equal((await pending).auto_memory, undefined);
  assert.equal(f.controller.status().loaded, false);
  await assert.rejects(f.store.write(f.path, "not delivered"), /no complete read baseline/);
  f.store.readBuffer = read;
  assert.match((await f.task()).auto_memory, /NEW_AFTER_TREE/);
});

test("lifecycle: old index load cannot overwrite a newer snapshot after the reload command", async (t) => {
  const f = await harness(t, "OLD_IN_FLIGHT");
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const read = f.store.readBuffer;
  f.store.readBuffer = async (...args) => {
    const result = await read(...args);
    started();
    await barrier;
    return result;
  };
  const pending = f.task();
  await ready;
  await f.run("reload");
  assert.equal(f.controller.status().loaded, false);
  f.store.readBuffer = read;
  await writeFile(f.path, "NEW_AFTER_RELOAD");
  const current = await f.task();
  assert.match(current.auto_memory, /NEW_AFTER_RELOAD/);
  await f.project([system({ auto_memory: wrap(current.auto_memory) })]);
  release();
  assert.equal((await pending).auto_memory, undefined);
  assert.equal(f.controller.status().loaded, true);
  assert.deepEqual(await f.task(), current);
  await f.store.write(f.path, "new delivered baseline");
  assert.equal(await readFile(f.path, "utf8"), "new delivered baseline");
});

test("lifecycle: session shutdown invalidates an in-flight commit before atomic rename", async (t) => {
  const f = await harness(t, "original");
  const loaded = await f.task();
  await f.project([system({ auto_memory: wrap(loaded.auto_memory) })]);
  let ready!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const pending = f.store.write(f.path, "must not commit", { beforeRename: async () => { ready(); await barrier; } });
  const rejected = assert.rejects(pending, /invalidated by a session change/);
  await started;
  await f.emit("session_shutdown", { reason: "resume" });
  release();
  await rejected;
  assert.equal(await readFile(f.path, "utf8"), "original");
  assert.equal(f.controller.status().loaded, false);
});

test("lifecycle: explicit controller reset supports on/off between tasks without reusing a loaded snapshot", async (t) => {
  const f = await harness(t, "BEFORE_COMMAND");
  await f.task();
  await f.store.config.setEnabled(false);
  await writeFile(f.path, "AFTER_COMMAND");
  await f.store.config.setEnabled(true);
  f.controller.reset();
  assert.match((await f.task()).auto_memory, /AFTER_COMMAND/);
  assert.equal(f.counts().reads, 2);
});

test("lifecycle: reload command loads the latest index on the next user task and then reuses it", async (t) => {
  const f = await harness(t, "BEFORE_RELOAD");
  const old = await f.task();
  const history = [system({ auto_memory: wrap(old.auto_memory), foreign: "KEEP" }), user];
  await f.project(history);
  await writeFile(f.path, "AFTER_RELOAD");
  await writeFile(join(f.paths.projectDir, "topic.md"), "TOPIC_MUST_NOT_LOAD");
  const before = f.counts().reads;
  await f.run("reload");
  assert.deepEqual(f.controller.status(), { loaded: false });
  assert.equal(f.counts().reads, before);
  assert.equal(await f.project(history), history);
  await assert.rejects(f.store.write(f.path, "old baseline"), /no complete read baseline/);
  assert.equal((await f.task("custom")).auto_memory, undefined);
  assert.equal(f.counts().reads, before);
  const current = await f.task();
  assert.match(current.auto_memory, /AFTER_RELOAD/);
  assert.doesNotMatch(current.auto_memory, /BEFORE_RELOAD|TOPIC_MUST_NOT_LOAD/);
  const projected = await f.project(history);
  assert.equal(projected[0].sections?.auto_memory, wrap(current.auto_memory));
  assert.equal(projected[0].sections?.foreign, "KEEP");
  assert.equal(projected[1], user);
  await writeFile(f.path, "LATER_DISK_CHANGE");
  assert.deepEqual(await f.task(), current);
  assert.equal(f.counts().reads, before + 1);
});

test("lifecycle: reload followed by a missing or unreadable index never restores the old snapshot", async (t) => {
  for (const failure of ["missing", "unreadable"]) {
    const f = await harness(t, "OLD_RELOAD_INDEX");
    const old = await f.task();
    await f.project([system({ auto_memory: wrap(old.auto_memory) })]);
    await f.run("reload");
    if (failure === "missing") await rm(f.path);
    else t.mock.method(f.store, "readBuffer", async () => { throw Object.assign(new Error("BODY_MUST_NOT_LEAK"), { code: "EACCES" }); });
    const next = await f.task();
    assert.doesNotMatch(JSON.stringify(next), /OLD_RELOAD_INDEX|BODY_MUST_NOT_LEAK/);
    if (failure === "missing") {
      assert.match(next.auto_memory, /No index content yet/);
      await assert.rejects(readFile(f.path), { code: "ENOENT" });
      assert.equal(f.controller.status().loaded, true);
    } else {
      assert.equal(next.auto_memory, undefined);
      assert.equal(f.controller.status().loaded, false);
      assert.match(f.controller.status().fault!, /normal tasks can continue/);
      assert.doesNotMatch(f.warnings.join("\n"), /BODY_MUST_NOT_LEAK/);
    }
    assert.deepEqual(await f.task(), next);
  }
});

test("lifecycle: unknown config pauses; repair reloads on next task; store.child alone disables runner", async (t) => {
  const f = await harness(t, "INDEX");
  await writeFile(f.store.config.path, "corrupt");
  assert.equal((await f.task()).auto_memory, undefined);
  assert.equal(f.counts().reads, 0);
  assert.match(f.warnings.join(), /配置文件.*不可读取、损坏或版本不受支持/);
  await writeFile(f.store.config.path, '{"version":1,"enabled":true}');
  assert.match((await f.task()).auto_memory, /INDEX/, "parentSession is not a child flag");
  const child = await harness(t, "CHILD_INDEX", true);
  assert.equal((await child.task()).auto_memory, undefined);
  assert.equal(child.counts().reads, 0);
  assert.equal(child.counts().configs, 0);
  assert.equal(child.warnings.length, 0);
});

test("lifecycle: a late tool conflict before projection withdraws only the current snapshot and keeps other sections and history", async (t) => {
  const f = await harness(t, "LOADED_INDEX");
  const loaded = await f.task();
  const stale = wrap(loaded.auto_memory);
  const history = [system({ auto_memory: stale, foreign: "KEEP", preamble: "FIRST" }), user];
  await f.project(history);
  f.failCompatibility();
  const projected = await f.project(history);
  assert.equal(projected[0].role, "system");
  if (projected[0].role !== "system") throw new Error();
  assert.equal(projected[0].sections?.auto_memory, undefined, "the stale snapshot is not injected as current memory");
  assert.equal(projected[0].sections?.foreign, "KEEP");
  assert.equal(projected[0].sections?.preamble, "FIRST");
  assert.equal(projected[1], user, "user history is preserved");
  assert.match(f.controller.status().fault!, /compatibility could not be confirmed/);
  assert.match(f.warnings.at(-1)!, /停用.*完整重载 Pi 扩展/);
  assert.equal(f.controller.status().loaded, false);
  await assert.rejects(f.store.write(f.path, "old coverage"), /no complete read baseline/);
  assert.equal(f.counts().resets, 0, "the lifecycle pause does not reset the runtime on its own");
  const recordedFault = f.controller.status().fault;
  const forceCurrent = await f.project([{ role: "system", content: `FIRST\n\n${stale}`, timestamp: 1 } as AgentMessage, user]);
  assert.equal(forceCurrent[0].content, "FIRST\n\n", "only this extension's own current snapshot is removed");
  assert.equal(forceCurrent[1], user);
  assert.equal((await f.task()).auto_memory, undefined, "a new user task injects no memory while the conflict stands");
  assert.equal(f.counts().reads, 1, "no index reread after the conflict");
  f.restoreCompatibility();
  assert.equal((await f.task()).auto_memory, undefined, "the recorded conflict is not cleared by a recovered snapshot");
  assert.equal(f.counts().reads, 1);
  assert.equal(f.controller.status().fault, recordedFault, "the same safe pause notice is kept instead of a silent recovery");
  const repeated = await f.project(history);
  assert.equal(repeated.length, 2);
  assert.equal(repeated[0].role, "system");
  if (repeated[0].role !== "system") throw new Error();
  assert.equal(repeated[0].sections?.auto_memory, undefined);
  assert.equal(repeated[0].sections?.foreign, "KEEP");
  assert.equal(repeated[1], user);
});

test("lifecycle: a compatibility check failure pauses projection without copying the check error or updating store state", async (t) => {
  const f = await harness(t, "LOADED_INDEX");
  const loaded = await f.task();
  const history = [system({ auto_memory: wrap(loaded.auto_memory) })];
  await f.project(history);
  f.failCompatibility();
  const before = f.counts();
  const projected = await f.project(history);
  assert.equal(projected[0].role, "system");
  if (projected[0].role !== "system") throw new Error();
  assert.equal(projected[0].sections?.auto_memory, undefined);
  assert.equal(f.warnings.join("\n").includes("incompatible same-name tool override (write)"), false, "the raw check error body is not surfaced");
  assert.ok(!f.warnings.join("\n").includes("LOADED_INDEX"), "no snapshot body in the fault");
  const after = f.counts();
  assert.equal(after.configs, before.configs);
  assert.equal(after.resets, before.resets);
  const nextTask = await f.task("user");
  assert.equal(nextTask.auto_memory, undefined);
  assert.equal(f.counts().reads, 1);
  assert.equal(f.controller.status().loaded, false);
});

test("lifecycle: a conflict during index IO reports compatibility recovery and never injects the result", async (t) => {
  const f = await harness(t, "WITHDRAW_DURING_READ");
  const read = f.store.readBuffer.bind(f.store);
  t.mock.method(f.store, "readBuffer", async (...args: Parameters<typeof read>) => {
    await read(...args);
    f.failCompatibility();
    throw new Error("Memory paused: incompatible same-name tool override (write)");
  });
  assert.equal((await f.task()).auto_memory, undefined);
  assert.match(f.warnings.at(-1)!, /完整重载 Pi 扩展/);
  assert.equal(f.controller.status().loaded, false);
  assert.equal((await f.task()).auto_memory, undefined);
  assert.equal(f.counts().reads, 1);
});

test("lifecycle: consecutive tasks with a passing compatibility check load the index once and never consult it again", async (t) => {
  const f = await harness(t, "STEADY_INDEX");
  const first = await f.task();
  assert.match(first.auto_memory, /STEADY_INDEX/);
  await f.project([system({ auto_memory: wrap(first.auto_memory) })]);
  for (const _ of [0, 1, 2]) {
    assert.deepEqual(await f.task(), first);
    const projected = await f.project([system({ auto_memory: wrap(first.auto_memory) })]);
    assert.equal(projected[0].role, "system");
    if (projected[0].role !== "system") throw new Error();
    assert.equal(projected[0].sections?.auto_memory, wrap(first.auto_memory));
  }
  assert.equal(f.counts().reads, 1, "a healthy check reuses the existing snapshot");
  assert.equal(f.counts().compatibilityChecks, 8, "each task start and each projection checks registration metadata only");
  assert.equal(f.warnings.length, 0);
  await f.failCompatibility();
  assert.equal((await f.project([system({ auto_memory: wrap(first.auto_memory) })])).length, 1);
  f.restoreCompatibility();
});

test("memoryGuidance snapshot covers types, correction, AGENTS dedup, secrets and topic-before-index saves", () => {
  const text = memoryGuidance("/isolated/project", "topic.md - durable knowledge", false);
  for (const phrase of ["user: stable user preferences", "feedback: corrections", "project: durable project knowledge", "reference: pointers",
    "Follow current user instructions over old memory", "update or remove the obsolete record", "Do not duplicate rules already in AGENTS.md",
    "Skip temporary progress", "Never save secrets", "even when asked", "Save a focused topic file first", "then add or update a concise link",
    "no end-of-task summary or extra model call", "Read relevant topic files on demand", "read its complete current contents", "AFTER saving",
    "first user task after session entry, re-enabling or /memory reload", "Reload invalidates old managed reads and pending edits or commits",
    "Historical conversation content remains"]) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.equal(createHash("sha256").update(text).digest("hex"), "f68fda1915f80a3a6e159bd1ddddc4ae36bdfa473e2232a90f569da81f4328d3", "exact guidance snapshot");
});

test("memoryGuidance considers first-time durable project feedback without an explicit save request or task-specific answers", () => {
  const text = memoryGuidance("/isolated/project", "", false);
  for (const phrase of ["A user correction can introduce a new feedback memory", "not just update an existing record",
    "an explicit request to remember or save is not required", "durable project-scoped working preference or lesson",
    "proactively consider preserving it as feedback", "If you judge it useful for future tasks and allowed by current instructions",
    "save the reusable preference with the standard tools rather than only adapting the current reply",
    "Saving is the current model's choice", "no end-of-task summary or extra model call"]) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.doesNotMatch(text, /\b(?:curl|localhost|health|troubleshooting)\b|https?:\/\//i);
});

test("memoryGuidance excludes one-off, unclear and prohibited memory writes without inferring permission", () => {
  const text = memoryGuidance("/isolated/project", "", false);
  for (const phrase of ["Do not turn a one-off output request into a lasting preference",
    "If scope or durability is unclear, skip saving rather than inventing a lasting rule",
    "Do not write memory when the user forbids saving", "when memory writes fall within their no-write instructions",
    "do not treat ambiguous restrictions as permission", "Follow current user instructions over old memory",
    "Never save secrets", "Do not duplicate rules already in AGENTS.md"]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test("lifecycle: an empty project receives first-time feedback guidance without lifecycle-created memory files", async (t) => {
  const f = await harness(t);
  await f.task();
  const projected = await f.project([system()]);
  const first = projected[0];
  assert.equal(first.role, "system");
  if (first.role !== "system") throw new Error("Missing projected system message");
  assert.equal(first.sections?.auto_memory, wrap(memoryGuidance(f.paths.projectDir, "", false)));
  assert.ok(first.sections?.auto_memory?.includes("A user correction can introduce a new feedback memory"));
  assert.deepEqual((await readdir(f.paths.projectDir)).filter((name) => name.endsWith(".md")), []);
  assert.equal(f.warnings.length, 0);
});

test("projection: remove only exact own sections and history deltas; preserve leading system, foreign/tool/dynamic state and conversations", () => {
  const old = memoryGuidance("/old", "OLD_INDEX", false);
  const current = memoryGuidance("/new", "CURRENT_INDEX", false);
  const added = { name: "dynamic", description: "dynamic tool", parameters: { type: "object", properties: {} } };
  const assistant: AgentMessage = { role: "assistant", content: [{ type: "text", text: "OLD_INDEX is user data" }], api: "openai-completions", provider: "test", model: "fake",
    stopReason: "stop", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const messages: AgentMessage[] = [
    { ...system({ preamble: "FIRST_SYSTEM", auto_memory: wrap(old), foreign: "FOREIGN_0" }), toolsAdded: [added] },
    user, assistant, system({ auto_memory: wrap(old) }),
    { ...system({ auto_memory: wrap(old), foreign: "FOREIGN_1" }), toolsRemoved: [{ name: "dynamic" }], toolsAdded: [added] },
    system({ auto_memory: null }), system({ foreign: "FOREIGN_2" }),
  ];
  const before = structuredClone(messages);
  const result = projectMemorySection(messages, current);
  assert.deepEqual(messages, before, "projection never mutates persisted input");
  assert.equal(result.length, messages.length - 2);
  assert.equal(result[0].role, "system");
  if (result[0].role !== "system") throw new Error();
  assert.equal(result[0].sections!.preamble, "FIRST_SYSTEM");
  assert.equal(result[0].sections!.foreign, "FOREIGN_0");
  assert.equal(result[0].sections!.auto_memory, wrap(current));
  assert.deepEqual(result[0].toolsAdded, [added]);
  assert.equal(result[1], user);
  assert.equal(result[2], assistant);
  assert.deepEqual(result[3], { ...messages[4], sections: { foreign: "FOREIGN_1" } });
  assert.deepEqual(result[4], messages[6]);
  assert.equal(JSON.stringify(result).split("CURRENT_INDEX").length - 1, 1);
});

test("projection: exact owned section in forced system content is replaced, foreign text is preserved", () => {
  const old = memoryGuidance("/old", "OLD", false);
  const current = memoryGuidance("/new", "NEW", false);
  const leading = { role: "system", content: `FIRST\n\n${wrap(old)}\n\n<foreign>keep</foreign>`, timestamp: 1 } as AgentMessage;
  const result = projectMemorySection([leading, user, { role: "system", content: wrap(old), timestamp: 2 }], current);
  assert.equal(result.length, 2, "body-only owned delta is removed when made empty");
  if (result[0].role !== "system") throw new Error();
  assert.equal(result[0].content, "FIRST\n\n\n\n<foreign>keep</foreign>");
  assert.equal(result[0].sections!.auto_memory, wrap(current));
  assert.equal(result[1], user);
});

test("projection: unreliable own marker structure fails closed, warns and grants no new coverage", async (t) => {
  const f = await harness(t, "NEW_INDEX");
  const loaded = await f.task();
  const broken = { role: "system", content: "FIRST\n<auto_memory>\nbroken", timestamp: 1 } as AgentMessage;
  const input = [broken, system({ auto_memory: wrap(loaded.auto_memory), foreign: "KEEP" }), user];
  const result = await f.project(input);
  assert.deepEqual(result[0], { ...broken, sections: {} }, "do not guess repairs to opaque history");
  assert.equal(result[1].sections?.auto_memory, undefined);
  assert.equal(result[1].sections?.foreign, "KEEP");
  assert.equal(result[2], user);
  assert.match(f.warnings.join(), /系统提示区结构不可靠/);
  const forcedCurrent = { ...broken, content: `FIRST\n<auto_memory>\nbroken\n${wrap(loaded.auto_memory)}` } as AgentMessage;
  const forcedResult = await f.project([forcedCurrent, user]);
  assert.equal(forcedResult[0].content, "FIRST\n<auto_memory>\nbroken\n", "withdraw exact newly generated forced snapshot without guessing old structure");
  await assert.rejects(f.store.write(f.path, "not delivered"), /no complete read baseline/);
  assert.throws(() => projectMemorySection([user], loaded.auto_memory), /structure is unreliable/);
  const untrusted = await harness(t, "</auto_memory>");
  assert.equal((await untrusted.task()).auto_memory, undefined);
  assert.equal(untrusted.warnings.length, 1);
});

for (const supportsMid of [true, false]) test(`provider request: real pi lifecycle and installed conversion, mid-conversation-system=${supportsMid}`, async (t) => {
  const f = await harness(t, "OLD_PROVIDER_INDEX");
  const requests: Record<string, any>[] = [];
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: join(f.root, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [(pi) => registerLifecycleProvider(pi, supportsMid, requests), (pi) => {
      const runtime = { getStore: async () => f.store, reset: () => f.store.invalidate() };
      const lifecycle = registerLifecycle(pi, runtime);
      registerCommands(pi, runtime, { lifecycleState: lifecycle.status, resetLifecycle: lifecycle.reset });
      pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections.foreign = "FOREIGN_PROVIDER_SECTION"; });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: join(f.root, "agent", "auth.json"), modelsPath: null,
    modelsStorePath: join(f.root, "agent", "models-cache.json"), refreshOnCreate: false });
  const manager = SessionManager.inMemory(f.root);
  const { session } = await createAgentSession({ cwd: f.root, agentDir: join(f.root, "agent"), resourceLoader: loader,
    modelRuntime: runtime, sessionManager: manager, settingsManager: settings, tools: ["read"] });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  const model = session.modelRuntime.getModels("lifecycle-test").find((model) => model.id === "fake");
  assert.ok(model);
  await session.setModel(model);
  await session.prompt("task one");
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /OLD_PROVIDER_INDEX/);
  await writeFile(f.path, "NEW_PROVIDER_INDEX");
  session.setActiveToolsByName(["read", "write"]);
  await session.prompt("task two");
  assert.equal(requests.length, 2, "one request per task, no background calls");
  assert.equal(JSON.stringify(requests[1]).split("OLD_PROVIDER_INDEX").length - 1, 1);
  assert.ok(!JSON.stringify(requests[1]).includes("NEW_PROVIDER_INDEX"));
  assert.ok(JSON.stringify(requests[1]).includes('write'), "dynamic tool addition reaches provider");
  const leading = session.messages[0];
  assert.equal(leading.role, "system");
  const beforeTools = requests[1].tools;
  const beforeReloadReads = f.counts().reads;
  const beforeReloadHistory = structuredClone(session.messages);
  await session.prompt("/memory reload");
  assert.equal(requests.length, 2, "reload does not request the provider");
  assert.equal(f.counts().reads, beforeReloadReads, "reload does not read the index");
  assert.deepEqual(session.messages.slice(0, beforeReloadHistory.length), beforeReloadHistory, "reload retains the conversation");
  assert.equal(session.messages.at(-1)?.role, "custom", "headless command adds its visible status notification");
  await session.prompt("task three");
  assert.equal(requests.length, 3);
  const request = requests[2];
  const full = JSON.stringify(request);
  assert.equal(full.split("NEW_PROVIDER_INDEX").length - 1, 1);
  assert.ok(!full.includes("OLD_PROVIDER_INDEX"), "old own history delta is not in provider request");
  assert.equal(full.split("<auto_memory>").length - 1, 1);
  assert.ok(full.includes("FOREIGN_PROVIDER_SECTION"));
  assert.equal(request.messages[0].role, "system");
  assert.match(request.messages[0].content, /expert coding assistant/);
  assert.deepEqual(request.tools, beforeTools);
  const requestText = (message: any) => typeof message.content === "string" ? message.content : message.content.map((block: any) => block.text ?? "").join("");
  assert.ok(request.messages.some((m: any) => m.role === "user" && requestText(m) === "task one"));
  assert.ok(request.messages.some((m: any) => m.role === "assistant" && requestText(m) === "normal task completed"));
  assert.ok(JSON.stringify(session.messages).includes("OLD_PROVIDER_INDEX"), "projection did not erase stored history");
  const leadingClone = structuredClone(leading);
  const fresh = session.messages[0];
  assert.deepEqual(fresh, leadingClone, "first persistent system was not overwritten");
  await f.store.config.setEnabled(false);
  session.setActiveToolsByName(["read"]);
  await session.prompt("task while off");
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].tools.map((tool: any) => tool.function.name), ["read"]);
  if (supportsMid) {
    assert.ok(JSON.stringify(requests[3]).includes("OLD_PROVIDER_INDEX"), "off is not history erasure");
    assert.equal(JSON.stringify(requests[3]).split("NEW_PROVIDER_INDEX").length - 1, 1, "only the already-persisted update remains");
    assert.match(JSON.stringify(requests[3]), /Removed system prompt section.*auto_memory/);
  } else assert.ok(!JSON.stringify(requests[3]).includes("NEW_PROVIDER_INDEX"), "collapsed current state has no memory section while off");
  await writeFile(f.store.config.path, "corrupt");
  await session.prompt("normal task with unknown memory config");
  assert.equal(requests.length, 5);
  assert.match(JSON.stringify(session.messages.at(-1)), /normal task completed/);
  await writeFile(f.store.config.path, '{"version":1,"enabled":true}');
  await writeFile(f.path, "FAULT_INDEX_MUST_NOT_INJECT");
  const readBuffer = f.store.readBuffer;
  f.store.readBuffer = async () => { throw Object.assign(new Error("fault body must not be logged"), { code: "EACCES" }); };
  await session.prompt("normal task with unreadable index");
  assert.equal(requests.length, 6);
  assert.ok(!JSON.stringify(requests[5]).includes("FAULT_INDEX_MUST_NOT_INJECT"));
  assert.match(JSON.stringify(session.messages.at(-1)), /normal task completed/);
  f.store.readBuffer = readBuffer;
});


test("lifecycle activity distinguishes preparation, successful projection, refresh and session entry", async (t) => {
  const f = await harness(t, "INDEX");
  assert.equal(f.activity.snapshot().phase, "initial");
  const loaded = await f.task();
  assert.equal(f.activity.snapshot().phase, "prepared");
  assert.equal(f.activity.snapshot().projectedAt, undefined);
  await f.project([user]);
  assert.equal(f.activity.snapshot().projectedAt, undefined);
  await f.project([system({ auto_memory: wrap(loaded.auto_memory) }), user]);
  assert.equal(f.activity.snapshot().phase, "projected");
  const first = f.activity.snapshot().projectedAt;
  await f.project([system({ auto_memory: wrap(loaded.auto_memory) }), user]);
  assert.equal(f.activity.snapshot().projectedAt, first);
  const record = f.activity.bind(f.paths.projectDir).capture("model");
  record({ kind: "save", path: join(f.paths.projectDir, "topic.md") });
  await f.run("reload");
  assert.equal(f.activity.snapshot().phase, "refresh");
  assert.equal(f.activity.snapshot().lastSave!.path, "topic.md");
  record({ kind: "save", path: join(f.paths.projectDir, "late.md") });
  assert.equal(f.activity.snapshot().lastSave!.path, "topic.md");
  await f.task();
  assert.equal(f.activity.snapshot().phase, "prepared");
  await f.emit("session_tree");
  assert.equal(f.activity.snapshot().phase, "initial");
  assert.equal(f.activity.snapshot().lastSave, undefined);
  assert.equal(f.counts().reads, 2);
});

test("lifecycle activity marks a missing index empty and never reports a failed projection as injected", async (t) => {
  const f = await harness(t);
  await f.task();
  assert.equal(f.activity.snapshot().empty, true);
  assert.equal(f.activity.snapshot().phase, "prepared");
  await f.project([user]);
  assert.equal(f.activity.snapshot().projectedAt, undefined);
  assert.ok(f.activity.snapshot().fault);
  f.failCompatibility();
  await f.project([system()]);
  assert.equal(f.activity.snapshot().phase, "initial");
  assert.ok(f.activity.snapshot().fault);
});
