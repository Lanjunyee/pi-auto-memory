import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createAgentSession, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  DefaultResourceLoader, ModelRuntime, AgentSession, convertToLlm,
  SessionManager, SettingsManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { registerCommands } from "../src/pi/commands.js";
import { registerLifecycle } from "../src/pi/lifecycle.js";
import { registerMemoryTools, sessionStoreProvider, type MemoryRuntime } from "../src/pi/registration.js";
import type { LifecycleRuntime } from "../src/pi/lifecycle.js";
import { MemoryConfig } from "../src/core/config.js";
import { MemoryPaths } from "../src/core/paths.js";
import { identifyProject } from "../src/core/project-identity.js";
import { MemoryStore } from "../src/core/store.js";

const PROVIDER = "registration-test";
const MODEL = "fake";
let pending: { name: string; input: Record<string, unknown> } = { name: "read", input: {} };

function setToolCall(name: string, input: Record<string, unknown>) {
  pending = { name, input };
}

function syntheticProvider(pi: ExtensionAPI, requests: Record<string, any>[]) {
  let callSerial = 0;
  pi.registerProvider(PROVIDER, {
    baseUrl: "https://never-contact.invalid/v1", apiKey: "synthetic-test-only", api: "registration-test-api",
    models: [{ id: MODEL, name: "Registration fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
      compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } }],
    streamSimple: (model, context, options) => streamSimple({ ...model, api: "openai-completions" }, context, {
      ...options, apiKey: "synthetic-test-only", fetch: async (_url, init) => {
        if (requests.length >= 24) throw new Error("Synthetic provider exceeded the request budget; a task looped instead of finishing.");
        const request = JSON.parse(String(init?.body));
        requests.push(request);
        const messages = request.messages ?? [];
        const last = messages[messages.length - 1];
        const done = last?.role === "tool";
        const chunk = done
          ? { id: "fake-response", object: "chat.completion.chunk", created: 1, model: MODEL,
            choices: [{ index: 0, delta: { role: "assistant", content: "synthetic task completed" }, finish_reason: null }] }
          : { id: "fake-response", object: "chat.completion.chunk", created: 1, model: MODEL,
            choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${callSerial++}`, type: "function",
              function: { name: pending.name, arguments: JSON.stringify(pending.input) } }] }, finish_reason: null }] };
        const stop = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`, {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      },
    }),
  });
}

interface HarnessOptions {
  tools?: string[];
  extra?: (pi: ExtensionAPI) => void;
  order?: "before" | "after";
  active?: string[];
  base?: string[];
}

async function baseSession(cwd: string, loader: DefaultResourceLoader,
  runtime: ModelRuntime, settingsManager: SettingsManager, base: string[]) {
  const override: Record<string, AgentTool> = {};
  for (const name of base) override[name] = agentTool(name, cwd);
  const agent = new Agent({ initialState: { systemPrompt: "", model: undefined, thinkingLevel: "off", tools: [], messages: [] },
    convertToLlm, streamFn: async () => { throw new Error("the base session is never streamed"); } });
  return new AgentSession({ agent, sessionManager: SessionManager.inMemory(cwd), settingsManager, cwd,
    resourceLoader: loader, modelRuntime: runtime, baseToolsOverride: override });
}

function agentTool(name: string, cwd: string): AgentTool {
  const definition = name === "read" ? createReadToolDefinition(cwd) : createWriteToolDefinition(cwd);
  return { name, label: name, description: definition.description, parameters: definition.parameters, execute: definition.execute } as unknown as AgentTool;
}

async function harnessWith(t: TestContext, options: HarnessOptions = {}) {
  const { tools, extra, order = "before", active, base } = options;
  const cwd = await mkdtemp(join(tmpdir(), "auto-memory-registration-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  const settingsManager = SettingsManager.inMemory();
  const requests: Record<string, any>[] = [];
  let memoryRuntime!: MemoryRuntime;
  let ownApi!: ExtensionAPI;
  const own = (pi: ExtensionAPI) => {
    ownApi = pi;
    memoryRuntime = registerMemoryTools(pi, { agentDir });
    const lifecycle = registerLifecycle(pi, memoryRuntime);
    registerCommands(pi, memoryRuntime, { lifecycleState: lifecycle.status, resetLifecycle: lifecycle.reset });
  };
  const providerFactory = (pi: ExtensionAPI) => syntheticProvider(pi, requests);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: order === "before"
      ? [providerFactory, ...(extra ? [extra] : []), own]
      : [providerFactory, own, ...(extra ? [extra] : [])],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
  const { session } = base
    ? { session: await baseSession(cwd, loader, runtime, settingsManager, base) }
    : await createAgentSession({ cwd, agentDir, tools, modelRuntime: runtime,
        settingsManager, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader });
  t.after(() => session.dispose());
  const before = session.getAllTools().map((tool) => tool.name);
  if (active) session.setActiveToolsByName(active);
  const activeNames = session.getActiveToolNames();
  await session.bindExtensions({});
  const model = session.modelRuntime.getModels(PROVIDER).find((candidate) => candidate.id === MODEL);
  assert.ok(model, "synthetic provider is registered");
  await session.setModel(model);
  const project = await identifyProject(cwd);
  const paths = await MemoryPaths.create(agentDir, project.projectId);
  const store = new MemoryStore(paths, await MemoryConfig.create(agentDir));
  const ctx = { cwd } as ExtensionToolContext;
  let serial = 0;
  const dispatch = async (name: string, input: Record<string, unknown>) => {
    setToolCall(name, input);
    const mark = session.messages.length;
    await session.prompt(`synthetic task ${serial++}`);
    const added = session.messages.slice(mark);
    const calls = added.flatMap((message: any) => message.role === "assistant" && ((message.content ?? []).some((part: any) => part.type === "toolCall") || (message.toolCalls?.length ?? 0) > 0)
      ? (message.toolCalls?.length ? message.toolCalls.map((call: any) => ({ name: call.name }))
        : message.content.filter((part: any) => part.type === "toolCall").map((part: any) => ({ name: part.name }))) : []);
    assert.equal(calls.length, 1, `prompt dispatched exactly one ${name} call`);
    assert.equal(calls[0].name, name);
    const results = added.filter((message: any) => message.role === "toolResult");
    assert.equal(results.length, 1, `the ${name} call produced exactly one tool result`);
    return JSON.stringify((results[0] as any).content ?? results[0]);
  };
  return { cwd, agentDir, session, before, active: activeNames, paths, store, ctx, memoryRuntime, ownApi, requests, dispatch };
}

function harness(t: TestContext, tools?: string[], extra?: (pi: ExtensionAPI) => void, order: "before" | "after" = "before") {
  return harnessWith(t, { tools, extra, order });
}

function customSchemaShape(foreign: ReturnType<typeof createReadToolDefinition>) {
  return { ...foreign.parameters, properties: { target: foreign.parameters.properties.path }, required: ["target"] };
}

test("real isolated pi registration preserves configured and active tool sets, excluding absent tools", async (t) => {
  for (const selected of [["read", "bash"], ["read", "write", "edit", "grep", "find", "ls"], []]) {
    await t.test(JSON.stringify(selected), async (t) => {
      const f = await harness(t, selected);
      assert.deepEqual(f.session.getAllTools().map((tool) => tool.name), f.before);
      assert.deepEqual(f.session.getActiveToolNames(), f.active);
      assert.deepEqual(f.active, selected);
      for (const name of selected.filter((name) => name !== "bash")) {
        assert.notEqual(f.session.getAllTools().find((tool) => tool.name === name)!.sourceInfo.source, "builtin");
      }
    });
  }
});

test("registered read/write/edit gates reject off, unknown and cross-project while ordinary files work", async (t) => {
  const f = await harness(t, ["read", "write", "edit"]);
  const path = join(f.paths.projectDir, "topic.md");
  await f.store.write(path, "original");
  const ordinary = join(f.cwd, "ordinary.md");
  await writeFile(ordinary, "ordinary");
  const call = (name: string, params: Record<string, unknown>) => f.session.getToolDefinition(name)!.execute("test", params, undefined, undefined, f.ctx);
  for (const state of ["off", "unknown", "cross-project"])  {
    let target = path;
    if (state === "off") await f.store.config.setEnabled(false);
    if (state === "unknown") await writeFile(f.store.config.path, "broken");
    if (state === "cross-project") { await writeFile(f.store.config.path, '{"version":1,"enabled":true}'); target = join(f.paths.memoryRoot, `cwd-${"f".repeat(64)}`, "topic.md"); }
    for (const [name, params] of [
      ["read", { path: target }], ["write", { path: target, content: "overwrite" }],
      ["edit", { path: target, edits: [{ oldText: "original", newText: "overwrite" }] }],
    ] as const) await assert.rejects(call(name, params));
    assert.equal(await readFile(path, "utf8"), "original");
    const result = await call("read", { path: ordinary });
    assert.equal(JSON.stringify(result.content).includes("ordinary"), true);
  }
});

test("identified runner child registered wrappers reject memory and leave ordinary reads usable", async (t) => {
  const f = await harness(t, ["read", "write", "edit"]);
  const path = join(f.paths.projectDir, "topic.md");
  await f.store.write(path, "original");
  const previous = process.env.PI_SUBAGENT_CHILD;
  t.after(() => { if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous; });
  process.env.PI_SUBAGENT_CHILD = "1";
  for (const [name, params] of [
    ["read", { path }], ["write", { path, content: "overwrite" }],
    ["edit", { path, edits: [{ oldText: "original", newText: "overwrite" }] }],
  ] as const) await assert.rejects(f.session.getToolDefinition(name)!.execute("child", params, undefined, undefined, f.ctx), /runner child/);
  const ordinary = join(f.cwd, "ordinary.md");
  await writeFile(ordinary, "ordinary");
  const result = await f.session.getToolDefinition("read")!.execute("ordinary", { path: ordinary }, undefined, undefined, f.ctx);
  assert.equal(JSON.stringify(result.content).includes("ordinary"), true);
});

test("same-name override is not silently replaced and protected calls are blocked, ordinary calls remain usable", async (t) => {
  const foreign = createReadToolDefinition(process.cwd());
  const f = await harness(t, ["read", "write"], (pi) => pi.registerTool(foreign));
  const path = join(f.paths.projectDir, "topic.md");
  await f.store.write(path, "original");
  assert.equal(f.session.getToolDefinition("read")!.execute, foreign.execute);
  const blocked = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "blocked", input: { path } });
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason!, /same-name tool override/);
  const ordinary = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "ordinary", input: { path: join(f.cwd, "ordinary.md") } });
  assert.equal(ordinary, undefined);
});

test("late same-name registration is detected before model memory calls, without expanding active tools", async (t) => {
  let replace!: () => void;
  const foreign = createReadToolDefinition(process.cwd());
  const f = await harness(t, ["read"], (pi) => { replace = () => pi.registerTool(foreign); });
  const active = f.session.getActiveToolNames();
  replace();
  const result = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "late", input: { path: join(f.paths.projectDir, "topic.md") } });
  assert.equal(result?.block, true);
  assert.match(result!.reason!, /same-name tool override/);
  assert.deepEqual(f.session.getActiveToolNames(), active);
});

test("a standard write registered at startup is gated when an external extension replaces it later at the host dispatch boundary", async (t) => {
  let register!: () => void;
  let executions = 0;
  const f = await harness(t, ["read", "write"], (pi) => {
    register = () => pi.registerTool({ name: "write", label: "foreign write", description: "External same-name write",
      parameters: createWriteToolDefinition(process.cwd()).parameters,
      execute: async () => { executions++; return { content: [{ type: "text", text: "foreign write ran" }], details: undefined }; },
    });
  });
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().entries.find((entry) => entry.name === "write")!.conflict, false,
    "the managed write is compatible before the external replacement");
  const active = f.session.getActiveToolNames();
  register();
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().entries.find((entry) => entry.name === "write")!.conflict, true,
    "the late replacement is observed as a conflict");
  const memoryTarget = join(f.paths.projectDir, "topic.md");
  const blocked = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "late-replace", input: { path: memoryTarget, content: "must not land" } });
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason!, /same-name tool override/);
  assert.equal(executions, 0, "the external same-name implementation never ran");
  await assert.rejects(readFile(memoryTarget), { code: "ENOENT" }, "the memory write never landed");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true, "the late replacement is a recorded compatibility pause");
  assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name tool override/);
  assert.deepEqual(f.session.getActiveToolNames(), active, "detection does not expand the active tool set");
});

test("a startup standard write replaced by an external unknown-schema implementation is gated at the host dispatch boundary", async (t) => {
  let register!: () => void;
  let executions = 0;
  const f = await harness(t, ["read", "write"], (pi) => {
    register = () => pi.registerTool({ name: "write", label: "foreign write", description: "External same-name write",
      parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      execute: async () => { executions++; return { content: [{ type: "text", text: "bypass" }], details: undefined }; },
    });
  });
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().entries.find((entry) => entry.name === "write")!.conflict, false);
  register();
  const ordinary = join(f.cwd, "ordinary.md");
  const blocked = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "late-unknown", input: { target: ordinary } });
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason!, /incompatible same-name tool override/);
  assert.equal(executions, 0, "an unknown schema is never invoked, not even for a plausible ordinary target");
  await assert.rejects(readFile(ordinary), { code: "ENOENT" });
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true);
});

test("factory order does not misattribute a startup external write that owns the name before or after this extension", async (t) => {
  for (const order of ["before", "after"] as const) await t.test(`external ${order}`, async (t) => {
    let executions = 0;
    const f = await harnessWith(t, { tools: ["read", "write", "edit"], extra: (pi) => pi.registerTool({ name: "write", label: "external write", description: "External write owning the name",
      parameters: createWriteToolDefinition(process.cwd()).parameters,
      execute: async () => { executions++; return { content: [{ type: "text", text: "external ran" }], details: undefined }; },
    }), order });
    const owned = f.session.getAllTools().find((tool) => tool.name === "write")!;
    assert.equal(owned.sourceInfo.source, "inline", "the external startup registration keeps its own source");
    assert.notEqual(owned.sourceInfo.path, f.session.getAllTools().find((tool) => tool.name === "read")!.sourceInfo.path,
      "the external write keeps its own source path");
    assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().entries.find((entry) => entry.name === "write")!.conflict, true);
    const blocked = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "order", input: { path: join(f.paths.projectDir, "topic.md"), content: "x" } });
    assert.equal(blocked?.block, true);
    assert.match(blocked!.reason!, /same-name tool override/);
    assert.equal(executions, 0, "the external write never executes a memory call");
    assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true);
  });
});

test("a standard write absent at startup and added later by an external extension is gated before any memory write", async (t) => {
  let register!: () => void;
  let executions = 0;
  const f = await harnessWith(t, {
    base: ["read"],
    extra: (pi) => {
      register = () => pi.registerTool({ name: "write", label: "late external write", description: "Late external same-name write",
        parameters: createWriteToolDefinition(process.cwd()).parameters,
        execute: async () => { executions++; return { content: [{ type: "text", text: "late external write ran" }], details: undefined }; },
      });
    },
  });
  assert.deepEqual(f.before, ["read"], "write is genuinely absent at startup");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().entries.find((entry) => entry.name === "write")!.conflict, false,
    "an absent name is not a conflict before it appears");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, false);

  register();
  assert.deepEqual(f.session.getAllTools().map((tool) => tool.name).includes("write"), true, "the late external write is actually registered");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().entries.find((entry) => entry.name === "write")!.conflict, true,
    "the late write is observed as taking the memory name");

  const memoryTarget = join(f.paths.projectDir, "topic.md");
  const blocked = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "absent-late", input: { path: memoryTarget, content: "must not land" } });
  assert.equal(blocked?.block, true, "the memory write is blocked at the dispatch boundary");
  assert.match(blocked!.reason!, /same-name tool override/);
  assert.equal(executions, 0, "the late external implementation never ran");
  await assert.rejects(readFile(memoryTarget), { code: "ENOENT" }, "the memory write never landed");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true, "the late addition is a recorded compatibility pause");
  assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name tool override/);
});

test("an absent write added with an unknown schema pauses and rejects even ordinary targets", async (t) => {
  let register!: () => void;
  const f = await harnessWith(t, { base: ["read"], extra: (pi) => {
    register = () => pi.registerTool({ name: "write", label: "external write", description: "Unknown write schema",
      parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      execute: async () => { throw new Error("the unknown implementation must not run"); },
    });
  } });
  assert.equal(f.session.getAllTools().some((tool) => tool.name === "write"), false);
  register();
  const info = f.session.getAllTools().find((tool) => tool.name === "write")!;
  assert.equal(info.sourceInfo.source, "inline");
  assert.notEqual(info.sourceInfo.path, f.session.getAllTools().find((tool) => tool.name === "read")!.sourceInfo.path);
  const blocked = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "absent-unknown", input: { target: join(f.cwd, "ordinary.md") } });
  assert.equal(blocked?.block, true);
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true);
});

test("incompatible tool schemas fail closed instead of guessing a path field", async (t) => {
  let executions = 0;
  const foreign = createReadToolDefinition(process.cwd());
  const f = await harness(t, ["read"], (pi) => pi.registerTool({ name: "read", label: "foreign read", description: "Custom target schema",
    parameters: customSchemaShape(foreign),
    execute: async () => { executions++; return { content: [{ type: "text", text: "bypass" }], details: undefined }; },
  }));
  const path = join(f.paths.projectDir, "topic.md");
  await f.store.write(path, "original");
  for (const target of [path, join(f.cwd, "ordinary.md")]) {
    const result = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "custom-schema", input: { target } });
    assert.equal(result?.block, true);
    assert.match(result!.reason!, /incompatible same-name/);
  }
  assert.equal(executions, 0);
});

test("the real host dispatch delegates an ordinary write but blocks a memory write under a standard-schema same-name override", async (t) => {
  let externalWrites = 0;
  const f = await harnessWith(t, { tools: ["read", "write"], extra: (pi) => pi.registerTool({ name: "write", label: "external write", description: "External same-name write",
    parameters: createWriteToolDefinition(process.cwd()).parameters,
    execute: async (_id, input) => {
      externalWrites++;
      await writeFile(input.path as string, input.content as string);
      return { content: [{ type: "text", text: "external write ran" }], details: undefined };
    },
  }) });
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true, "the startup same-name override is already recorded");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().entries.find((entry) => entry.name === "write")!.conflict, true);

  const ordinary = join(f.cwd, "distribution.txt");
  const ordinaryResult = await f.dispatch("write", { path: ordinary, content: "host dispatch" });
  assert.match(ordinaryResult, /external write ran/, "the ordinary write reached the host dispatch boundary and delegated");
  assert.equal(externalWrites, 1, "the standard-schema ordinary call keeps existing delegation");
  assert.equal(await readFile(ordinary, "utf8"), "host dispatch");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true, "the compatibility pause remains recorded");

  const memoryPath = join(f.paths.projectDir, "topic.md");
  const memoryResult = await f.dispatch("write", { path: memoryPath, content: "overwrite" });
  assert.match(memoryResult, /incompatible same-name tool override/, "the memory write is blocked before the filesystem");
  await assert.rejects(readFile(memoryPath), { code: "ENOENT" }, "the memory write was rejected before any filesystem change");
  assert.equal(externalWrites, 1, "the external same-name implementation never ran for the memory call");
});

test("the real host dispatch preserves ordinary access and blocks only the overlapping scan under a same-name override", async (t) => {
  const f = await harness(t, ["read", "grep", "ls"], (pi) => pi.registerTool({ name: "grep", label: "external grep", description: "External same-name grep",
    parameters: createGrepToolDefinition(process.cwd()).parameters,
    execute: async () => ({ content: [{ type: "text", text: "external grep ran" }], details: undefined }),
  }));
  const memoryPath = join(f.paths.projectDir, "topic.md");
  await f.store.write(memoryPath, "original memory body");
  const ordinary = join(f.cwd, "scan-target.md");
  await writeFile(ordinary, "ordinary scan target");

  const ordinaryResult = await f.dispatch("read", { path: ordinary });
  assert.match(ordinaryResult, /ordinary scan target/, "the ordinary read reaches the model");

  const memoryResult = await f.dispatch("read", { path: memoryPath });
  assert.doesNotMatch(memoryResult, /original memory body/, "the managed read never returns the memory body");

  const ancestorResult = await f.dispatch("ls", { path: f.agentDir });
  assert.doesNotMatch(ancestorResult, /topic\.md/, "no memory names leak through the blocked listing");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true);
});

const standardDefinitions = {
  read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
  grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition,
};

test("six names use current host ownership for initial, replaced and absent registrations with both schema classes", async (t) => {
  for (const name of Object.keys(standardDefinitions) as (keyof typeof standardDefinitions)[]) {
    for (const timing of ["initial", "replacement", "absent"] as const) {
      for (const unknown of [false, true]) await t.test(`${name} ${timing} ${unknown ? "unknown" : "standard"}`, async (t) => {
        let register!: () => void;
        let executions = 0;
        const f = await harnessWith(t, { ...(timing === "absent" ? { base: [] } : { tools: [name] }), extra: (pi) => {
          register = () => pi.registerTool({ name, label: `foreign ${name}`, description: "Synthetic external implementation",
            parameters: unknown ? { type: "object", properties: { target: { type: "string" } }, required: ["target"] }
              : standardDefinitions[name](process.cwd()).parameters,
            execute: async () => { executions++; return { content: [{ type: "text", text: "external ran" }], details: undefined }; },
          });
          if (timing === "initial") register();
        } });
        if (timing !== "initial") register();
        const active = f.session.getActiveToolNames();
        assert.equal(f.session.getAllTools().find((tool) => tool.name === name)!.sourceInfo.source, "inline");
        const observed = f.memoryRuntime.diagnostics!(f.ctx).tools();
        assert.equal(observed.entries.find((entry) => entry.name === name)!.conflict, true);
        assert.equal(observed.paused, timing === "initial", "observation alone does not pause");
        const input = (path: string) => unknown ? { target: path } : name === "write" ? { path, content: "replacement" }
          : name === "edit" ? { path, edits: [{ oldText: "original", newText: "replacement" }] }
          : name === "grep" ? { path, pattern: "original" } : name === "find" ? { path, pattern: "*.md" } : { path };
        const call = (path: string) => f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: "matrix", input: input(path) });
        assert.equal((await call(join(f.paths.projectDir, "topic.md")))?.block, true);
        if (["grep", "find", "ls"].includes(name)) assert.equal((await call(f.agentDir))?.block, true);
        assert.equal((await call(join(f.cwd, "ordinary.md")))?.block, unknown ? true : undefined);
        assert.equal(executions, 0);
        if (timing === "initial") {
          const memoryPath = join(f.paths.projectDir, "topic.md");
          await f.store.write(memoryPath, "original");
          assert.match(await f.dispatch(name, input(memoryPath)), /incompatible same-name tool override/);
          if (["grep", "find", "ls"].includes(name)) assert.match(await f.dispatch(name, input(f.agentDir)), /incompatible same-name tool override/);
          const result = await f.dispatch(name, input(join(f.cwd, "ordinary.md")));
          assert.match(result, unknown ? /incompatible same-name tool override/ : /external ran/);
          assert.equal(executions, unknown ? 0 : 1);
          assert.equal(await readFile(memoryPath, "utf8"), "original");
        }
        assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true);
        assert.deepEqual(f.session.getActiveToolNames(), active);
      });
    }
  }
});

test("doctor and its menu observe a late conflict without revoking the store or recording a pause", async (t) => {
  let register!: () => void;
  const f = await harness(t, ["read", "write"], (pi) => { register = () => pi.registerTool(createWriteToolDefinition(process.cwd())); });
  const old = await f.memoryRuntime.getStore(f.ctx);
  register();
  let command!: (args: string, ctx: any) => Promise<void>;
  registerCommands({ registerCommand: (_name: string, definition: any) => { command = definition.handler; } } as unknown as ExtensionAPI, f.memoryRuntime);
  const ctx = { cwd: f.cwd, hasUI: true, mode: "tui", ui: { notify: () => {}, select: async () => "Doctor" } };
  for (const args of ["doctor", ""]) {
    await command(args, ctx);
    assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, false);
  }
  assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name/);
  await assert.rejects(old.readFull(join(old.paths.projectDir, "topic.md")), /same-name tool override/);
  const paused = await f.memoryRuntime.getStore(f.ctx);
  assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name/);
  assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name/);
  assert.equal((await paused.config.read()).status, "unknown");
});

test("an ineffective later factory registration neither takes ownership nor pauses memory", async (t) => {
  let register!: () => void;
  const f = await harnessWith(t, { tools: ["read", "write"], order: "after", extra: (pi) => {
    register = () => pi.registerTool(createWriteToolDefinition(process.cwd()));
  } });
  const owner = f.session.getAllTools().find((tool) => tool.name === "write")!.sourceInfo.path;
  register();
  assert.equal(f.session.getAllTools().find((tool) => tool.name === "write")!.sourceInfo.path, owner);
  assert.equal(f.memoryRuntime.assertCompatible?.(), undefined);
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, false);
});

test("the real dispatcher rejects unknown-schema writes for memory and ordinary targets", async (t) => {
  let executions = 0;
  const f = await harnessWith(t, { tools: ["read", "write"], extra: (pi) => pi.registerTool({
    name: "write", label: "external write", description: "Unknown write schema",
    parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    execute: async () => { executions++; return { content: [{ type: "text", text: "must not run" }], details: undefined }; },
  }) });
  for (const target of [join(f.paths.projectDir, "topic.md"), join(f.cwd, "ordinary.md")]) {
    assert.match(await f.dispatch("write", { target }), /incompatible same-name tool override/);
    await assert.rejects(readFile(target), { code: "ENOENT" });
  }
  assert.equal(executions, 0);
});

test("session reset during model write routing permanently rejects the old request for a missing target", async (t) => {
  for (const event of ["reset", "session_tree", "session_shutdown", "reload"]) {
    await t.test(event, async (t) => {
      const f = await harness(t, ["read", "write", "edit"]);
      const old = await f.memoryRuntime.getStore(f.ctx);
      const existing = join(old.paths.projectDir, "existing.md");
      await old.write(existing, "existing baseline");
      const path = join(old.paths.projectDir, "new.md");
      let ready!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const classify = old.paths.classify.bind(old.paths);
      let paused = false;
      t.mock.method(old.paths, "classify", async (...args: Parameters<typeof classify>) => {
        const result = await classify(...args);
        if (!paused) { paused = true; ready(); await barrier; }
        return result;
      });
      const write = f.session.getToolDefinition("write")!;
      const pending = write.execute("old-write", { path, content: "must not create" }, undefined, undefined, f.ctx);
      const rejected = assert.rejects(pending, /invalidated by a session change/);
      await started;
      if (event === "reset") f.memoryRuntime.reset();
      else if (event === "reload") await f.session.prompt("/memory reload");
      else if (event === "session_tree") await f.session.extensionRunner.emit({ type: "session_tree", newLeafId: "new", oldLeafId: "old" });
      else await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
      release();
      await rejected;
      await assert.rejects(readFile(path), { code: "ENOENT" });
      const fresh = await f.memoryRuntime.getStore(f.ctx);
      assert.notEqual(fresh, old);
      await assert.rejects(old.readFull(existing), /invalidated by a session change/);
      await assert.rejects(fresh.write(existing, "unseen baseline"), /no complete read baseline/);
      await fresh.readFull(existing);
      await fresh.write(existing, "fresh baseline");
      await write.execute("new-write", { path, content: "fresh session" }, undefined, undefined, f.ctx);
      assert.equal(await readFile(path, "utf8"), "fresh session");
    });
  }
});

test("retired routing rejects read/edit and protected ancestor scans, without blocking ordinary delegation", async (t) => {
  for (const name of ["read", "edit", "grep", "find", "ls"] as const) {
    await t.test(name, async (t) => {
      const f = await harness(t, [name, "write"]);
      const old = await f.memoryRuntime.getStore(f.ctx);
      const path = join(old.paths.projectDir, "topic.md");
      await old.write(path, "original");
      let ready!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const classify = old.paths.classify.bind(old.paths);
      let paused = false;
      t.mock.method(old.paths, "classify", async (...args: Parameters<typeof classify>) => {
        const result = await classify(...args);
        if (!paused) { paused = true; ready(); await barrier; }
        return result;
      });
      const params = name === "read" ? { path } : name === "edit" ? { path, edits: [{ oldText: "original", newText: "changed" }] }
        : name === "grep" ? { path: f.agentDir, pattern: "original" }
        : name === "find" ? { path: f.agentDir, pattern: "*.md" } : { path: f.agentDir };
      const pending = f.session.getToolDefinition(name)!.execute("old", params, undefined, undefined, f.ctx);
      const rejected = assert.rejects(pending, /invalidated by a session change/);
      await started;
      await f.session.prompt("/memory reload");
      release();
      await rejected;
      assert.equal(await readFile(path, "utf8"), "original");
      const ordinary = join(f.cwd, "ordinary.md");
      const { managedFileTools } = await import("../src/pi/tools.js");
      await managedFileTools(f.cwd, old).write.execute("ordinary", { path: ordinary, content: "ordinary" }, undefined, undefined, f.ctx);
      assert.equal(await readFile(ordinary, "utf8"), "ordinary");
    });
  }
});

test("a failed store construction is not cached, so repairing the directory recovers without reset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink("b", join(root, "a"));
  await symlink("a", join(root, "b"));
  const provider = sessionStoreProvider(join(root, "a", "agent"));
  await assert.rejects(provider.obtain({ cwd: root }), /too many symbolic links/);
  await rm(join(root, "a"));
  await rm(join(root, "b"));
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  const recovered = await provider.obtain({ cwd: root });
  assert.equal((await recovered.config.read()).status, "known");
  assert.equal(recovered.paths.projectDir.includes("0".repeat(64)), false);
});

test("a concurrent failure does not evict a successfully built store", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "auto-memory-retry-race-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const provider = sessionStoreProvider(join(cwd, "agent"));
  const settled = await Promise.allSettled([
    provider.obtain({ cwd }),
    provider.obtain({ cwd }),
    provider.obtain({ cwd }),
  ]);
  assert.deepEqual(settled.map((entry) => entry.status), ["fulfilled", "fulfilled", "fulfilled"]);
  const stores = settled.map((entry) => (entry as PromiseFulfilledResult<Awaited<ReturnType<typeof provider.obtain>>>).value);
  assert.equal(stores[0], stores[1]);
  assert.equal(stores[1], stores[2]);
  assert.equal(await provider.obtain({ cwd }), stores[0]);
});

test("session/tree reset discards existing baselines and identity failures pause memory, not ordinary access", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "auto-memory-provider-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const provider = sessionStoreProvider(join(cwd, "agent"));
  const first = await provider.obtain({ cwd });
  const path = join(first.paths.projectDir, "topic.md");
  await first.write(path, "original");
  provider.reset();
  const next = await provider.obtain({ cwd });
  await assert.rejects(next.write(path, "overwrite"), /no complete read baseline/);
  await assert.rejects(first.write(path, "overwrite"), /invalidated by a session change/);
  await assert.rejects(first.readFull(path), /invalidated by a session change/);
  first.invalidate();
  await assert.rejects(first.write(join(first.paths.projectDir, "retired-new.md"), "new"), /invalidated by a session change/);
  await writeFile(join(cwd, ".git"), "malformed marker");
  provider.reset();
  const paused = await provider.obtain({ cwd });
  assert.equal((await paused.config.read()).status, "unknown");
  await assert.rejects(paused.readFull(path));
});

test("diagnostics observe six managed tools with registration, activation and ownership status", async (t) => {
  const f = await harness(t, ["read", "write", "edit", "grep", "find", "ls"]);
  const context = f.memoryRuntime.diagnostics!(f.ctx);
  const observed = context.tools();
  assert.deepEqual(observed.entries.map((entry) => entry.name), ["read", "write", "edit", "grep", "find", "ls"]);
  assert.equal(observed.paused, false);
  for (const entry of observed.entries) {
    assert.equal(entry.registered, true, entry.name);
    assert.equal(entry.active, true, entry.name);
    assert.equal(entry.conflict, false, entry.name);
  }
  assert.equal(context.agentDir, f.agentDir);
  assert.equal(context.child, false);
  assert.equal(context.assertCurrent(), undefined);
  const project = await context.identify();
  assert.equal(project.projectId, (await identifyProject(f.cwd)).projectId);
});

test("diagnostics mark unregistered and inactive managed tools individually without declaring conflict", async (t) => {
  const f = await harness(t, ["read", "grep"]);
  const entries = f.memoryRuntime.diagnostics!(f.ctx).tools().entries;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("read")!.registered, true);
  assert.equal(byName.get("read")!.active, true);
  assert.equal(byName.get("grep")!.registered, true);
  assert.equal(byName.get("grep")!.active, true);
  for (const absent of ["write", "edit", "find", "ls"]) {
    assert.equal(byName.get(absent)!.registered, false, absent);
    assert.equal(byName.get(absent)!.active, false, absent);
    assert.equal(byName.get(absent)!.conflict, false, absent);
  }
});

test("a managed tool outside the configured active set stays registered-but-inactive and is never re-activated", async (t) => {
  const f = await harnessWith(t, { active: ["read", "grep"] });
  const before = f.session.getActiveToolNames();
  const configured = f.session.getAllTools().map((tool) => tool.name).sort();
  assert.deepEqual(before, ["read", "grep"]);
  const inactive = f.memoryRuntime.diagnostics!(f.ctx).tools().entries.filter((entry) => !entry.active);
  assert.deepEqual(inactive.map((entry) => entry.name).sort(), ["edit", "find", "ls", "write"]);
  for (const entry of inactive) {
    assert.equal(entry.registered, true, entry.name);
    assert.equal(entry.conflict, false, entry.name);
  }
  assert.equal(f.memoryRuntime.assertCompatible?.(), undefined);
  assert.deepEqual(f.session.getActiveToolNames(), before, "the compatibility check does not expand the active set");
  assert.deepEqual(f.session.getAllTools().map((tool) => tool.name).sort(), configured);
  f.session.setActiveToolsByName([...before, "write"]);
  assert.deepEqual(f.session.getActiveToolNames().sort(), ["grep", "read", "write"]);
});

test("a recorded pause survives reset, the doctor and on/off, and only a fresh runtime without the conflict recovers", async (t) => {
  const foreign = createReadToolDefinition(process.cwd());
  let register!: () => void;
  const pause = (pi: ExtensionAPI) => {
    register = () => pi.registerTool({ name: "read", label: "foreign read", description: "Custom target schema",
      parameters: customSchemaShape(foreign), execute: foreign.execute as unknown as never });
  };
  const f = await harness(t, ["read", "write"], pause, "before");
  const path = join(f.paths.projectDir, "topic.md");
  await f.store.write(path, "original");
  const cleanTools = f.ownApi.getAllTools();
  const oldRuntime = f.memoryRuntime;
  const oldStore = await oldRuntime.getStore(f.ctx);
  await oldStore.readFull(path);
  const oldDraft = new MemoryStore(oldStore.paths, oldStore.config, oldStore.child, oldStore);
  await oldDraft.readFull(path);
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, false);
  f.memoryRuntime.assertCompatible?.();
  register();
  assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name tool override|incompatible/);
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true);

  f.memoryRuntime.reset();
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true, "session reset does not clear a recorded pause");
  assert.throws(() => f.memoryRuntime.assertCompatible?.());

  for (const command of ["/memory status", "/memory doctor", "/memory reload"]) {
    await f.session.prompt(command);
    assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true, `${command} does not clear the pause`);
    assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name tool override|incompatible/, `${command} keeps the pause`);
  }
  await f.session.prompt("/memory off");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true, "off keeps the pause recorded");
  await f.session.prompt("/memory on");
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true, "on does not clear the pause");

  const hold = await f.memoryRuntime.getStore(f.ctx);
  const holdState = await hold.config.read();
  assert.equal(holdState.status, "unknown");
  assert.match(holdState.fault, /same-name tool override/);
  await assert.rejects(hold.readFull(path), /same-name tool override/);
  const store = await f.memoryRuntime.getStore(f.ctx);
  const storeState = await store.config.read();
  assert.equal(storeState.status, "unknown", "the compatibility fault clone reports unknown config");
  assert.equal(storeState.enabled, false);
  assert.match(storeState.fault, /same-name tool override/);
  await assert.rejects(store.readFull(path), /same-name tool override/);
  await assert.rejects(hold.readFull(path), /same-name tool override/);

  t.mock.method(f.ownApi, "getAllTools", () => cleanTools);
  assert.equal(oldRuntime.diagnostics!(f.ctx).tools().entries.some((entry) => entry.conflict), true, "an observed unknown schema remains unsafe in this instance");
  for (const event of ["session_tree", "session_shutdown", "session_start"] as const) {
    await f.session.extensionRunner.emit(event === "session_tree" ? { type: event, newLeafId: "new", oldLeafId: "old" }
      : event === "session_shutdown" ? { type: event, reason: "resume" } : { type: event, reason: "reload" });
    assert.throws(() => oldRuntime.assertCompatible?.(), /same-name tool override/);
  }
  await assert.rejects(oldStore.write(path, "old baseline"), /same-name tool override/);
  await assert.rejects(oldDraft.write(path, "old draft"), /same-name tool override/);
  await writeFile(join(f.paths.projectDir, "MEMORY.md"), "fresh runtime snapshot");
  f.session.dispose();
  for (const enabled of [false, true]) {
    await f.store.config.setEnabled(enabled);
    let freshRuntime!: MemoryRuntime;
    const requests: Record<string, any>[] = [];
    const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [(pi) => {
        syntheticProvider(pi, requests);
        freshRuntime = registerMemoryTools(pi, { agentDir: f.agentDir });
        registerLifecycle(pi, freshRuntime);
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, tools: ["read", "write"],
      modelRuntime: await ModelRuntime.create({ authPath: join(f.agentDir, "auth.json"), modelsPath: null,
        modelsStorePath: join(f.agentDir, "models-cache.json"), refreshOnCreate: false }),
      settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(f.cwd), resourceLoader: loader });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    assert.equal(freshRuntime.diagnostics!(f.ctx).tools().paused, false);
    assert.equal(freshRuntime.assertCompatible?.(), undefined);
    assert.equal((await (await freshRuntime.getStore(f.ctx)).config.read()).enabled, enabled);
    await session.setModel(session.modelRuntime.getModels(PROVIDER).find((model) => model.id === MODEL)!);
    const ordinary = join(f.cwd, "recovery.md");
    await writeFile(ordinary, "ordinary");
    setToolCall("read", { path: ordinary });
    await session.prompt("verify recovery");
    assert.equal(JSON.stringify(requests).includes("fresh runtime snapshot"), enabled);
    await assert.rejects(oldDraft.write(path, "revived draft"), /same-name tool override/);
    assert.throws(() => oldRuntime.assertCompatible?.(), /same-name tool override/);
    session.dispose();
  }
  assert.equal(await readFile(path, "utf8"), "original");
});

test("a compatible registration snapshot cannot clear a recorded standard-schema ownership pause", async (t) => {
  let register!: () => void;
  const f = await harness(t, ["read", "write"], (pi) => { register = () => pi.registerTool(createWriteToolDefinition(process.cwd())); });
  const clean = f.ownApi.getAllTools();
  register();
  assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name/);
  t.mock.method(f.ownApi, "getAllTools", () => clean);
  const state = f.memoryRuntime.diagnostics!(f.ctx).tools();
  assert.equal(state.entries.some((entry) => entry.conflict), false);
  assert.equal(state.paused, true);
  for (const command of ["/memory doctor", "/memory reload", "/memory off", "/memory on"]) {
    await f.session.prompt(command);
    assert.throws(() => f.memoryRuntime.assertCompatible?.(), /same-name/);
  }
});

test("an in-flight context projection is withdrawn when the conflict appears before the projection boundary", async (t) => {
  const foreign = createReadToolDefinition(process.cwd());
  const f = await harness(t, ["read"]);
  const path = join(f.paths.projectDir, "MEMORY.md");
  await f.store.write(path, "snapshot body");
  let compatible = true;
  const lifecycleRuntime: LifecycleRuntime = {
    getStore: async () => f.store,
    assertCompatible: () => { if (!compatible) throw new Error("Memory paused: incompatible same-name tool override (read); disable the conflicting extension and reload."); },
    reset: () => f.store.invalidate(),
  };
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const warnings: string[] = [];
  const pi = { on: (name: string, handler: any) => { handlers.set(name, handler); },
    sendMessage: (message: { content: string }) => warnings.push(message.content),
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const controller = registerLifecycle(pi, lifecycleRuntime);
  const ctx = { cwd: f.cwd, hasUI: true, ui: { notify: (text: string) => warnings.push(text) } };
  const options = { sections: { foreign: "keep" } as Record<string, string> };
  await handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "user", prompt: "task", systemPromptOptions: options }, ctx);
  assert.match(options.sections.auto_memory, /snapshot body/);
  const wrapped = `<auto_memory>\n${options.sections.auto_memory}\n</auto_memory>`;
  const messages = [{ role: "system", content: "", sections: { auto_memory: wrapped, foreign: "keep" }, timestamp: 1 },
    { role: "user", content: "task", timestamp: 2 }];
  compatible = false;
  const projected = await handlers.get("context_with_system")!({ type: "context_with_system", messages }, ctx);
  assert.equal(JSON.stringify(projected.messages).includes("snapshot body"), false, "the stale snapshot is not projected");
  assert.equal(projected.messages[0].sections.foreign, "keep", "other sections survive");
  assert.match(warnings.join(), /工具兼容性冲突/);
  const nextTask = { sections: { foreign: "keep" } as Record<string, string> };
  await handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "user", prompt: "task two", systemPromptOptions: nextTask }, ctx);
  assert.equal(nextTask.sections.auto_memory, undefined, "the next user task does not inject a new snapshot while paused");
  assert.equal(controller.status().loaded, false);
});

test("diagnostics observe an incompatible same-name override without changing the running fault state", async (t) => {
  const foreign = createReadToolDefinition(process.cwd());
  const f = await harness(t, ["read", "write"], (pi) => pi.registerTool({ name: "read", label: "foreign read",
    description: "Custom target schema",
    parameters: { ...foreign.parameters, properties: { target: foreign.parameters.properties.path }, required: ["target"] },
    execute: foreign.execute as unknown as never }));
  const observed = f.memoryRuntime.diagnostics!(f.ctx).tools();
  assert.equal(observed.entries.find((entry) => entry.name === "read")!.conflict, true);
  assert.equal(observed.paused, true);
  const first = f.memoryRuntime.diagnostics!(f.ctx).tools();
  assert.deepEqual(first, observed);
  const active = f.session.getActiveToolNames();
  const blocked = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "obs", input: { target: join(f.cwd, "ordinary.md") } });
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason!, /incompatible same-name/);
  const after = f.memoryRuntime.diagnostics!(f.ctx).tools();
  assert.deepEqual(after, observed);
  assert.deepEqual(f.session.getActiveToolNames(), active);
});

test("diagnostics do not set or clear a recorded pause and a clean snapshot is not reported as cleared", async (t) => {
  let replace!: () => void;
  const foreign = createReadToolDefinition(process.cwd());
  const f = await harness(t, ["read"], (pi) => { replace = () => pi.registerTool({ name: "read", label: "foreign read",
    description: "Custom target schema",
    parameters: { ...foreign.parameters, properties: { target: foreign.parameters.properties.path }, required: ["target"] },
    execute: foreign.execute as unknown as never }); });
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, false);
  replace();
  const beforeEmit = f.memoryRuntime.diagnostics!(f.ctx).tools();
  assert.equal(beforeEmit.entries.find((entry) => entry.name === "read")!.conflict, true);
  assert.equal(beforeEmit.paused, false);
  await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "late", input: { target: join(f.cwd, "ordinary.md") } });
  const paused = f.memoryRuntime.diagnostics!(f.ctx).tools();
  assert.equal(paused.paused, true);
  assert.equal(f.memoryRuntime.diagnostics!(f.ctx).tools().paused, true);
  f.memoryRuntime.reset();
  const current = f.memoryRuntime.diagnostics!(f.ctx).tools();
  assert.equal(current.paused, true);
  assert.equal(current.entries.some((entry) => entry.conflict), true);
});

test("diagnostics discard identity and reset the runtime while exposing no placeholder project path", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "auto-memory-diagnostics-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  await writeFile(join(cwd, ".git"), "malformed marker");
  let runtime!: MemoryRuntime;
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [(pi) => { runtime = registerMemoryTools(pi, { agentDir }); }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, tools: ["read"],
    modelRuntime: await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false }),
    settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  const ctx = { cwd } as ExtensionToolContext;
  const context = runtime.diagnostics!(ctx);
  await assert.rejects(context.identify());
  assert.equal(JSON.stringify(await context.identify().catch((error) => String(error))).includes("cwd-0000"), false);
  const observed = context.tools();
  assert.equal(observed.entries.find((entry) => entry.name === "read")!.registered, true);
  const store = await runtime.getStore(ctx);
  assert.equal((await store.config.read()).status, "unknown");
  assert.equal(store.paths.projectDir.includes("0".repeat(64)), true);
  runtime.reset();
  await assert.rejects(store.readFull(join(store.paths.projectDir, "topic.md")), /invalidated by a session change/);
  const fresh = await runtime.getStore(ctx);
  assert.notEqual(fresh, store);
});

test("diagnostic context validity is bound to the runtime generation and cwd", async (t) => {
  const f = await harness(t, ["read"]);
  const context = f.memoryRuntime.diagnostics!(f.ctx);
  assert.equal(context.assertCurrent(), undefined);
  context.tools();
  f.memoryRuntime.reset();
  assert.throws(() => context.assertCurrent(), /invalidated by a session change/);
  assert.throws(() => context.tools(), /invalidated by a session change/);
  const moved = { cwd: join(f.cwd, "elsewhere") } as ExtensionToolContext;
  const movedContext = f.memoryRuntime.diagnostics!(moved);
  assert.equal(movedContext.assertCurrent(), undefined);
  (moved as { cwd: string }).cwd = join(f.cwd, "different");
  assert.throws(() => movedContext.assertCurrent(), /invalidated by a session change/);
});
