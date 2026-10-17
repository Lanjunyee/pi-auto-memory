import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { managedFileTools, standardFileTools } from "../src/pi/tools.js";
import { managedScanTools } from "../src/pi/scans.js";
import { setMemorySection } from "../src/pi/system-section.js";
import { makeStore } from "./helpers/store.js";

test("ordinary file tools match public host schema, results, errors, BOM and CRLF", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-tools-"));
  try {
    const adapted = standardFileTools(root);
    const host = {
      read: createReadToolDefinition(root),
      write: createWriteToolDefinition(root),
      edit: createEditToolDefinition(root),
    };
    for (const name of ["read", "write", "edit"] as const) {
      assert.equal(adapted[name].name, name);
      assert.deepEqual(adapted[name].parameters, host[name].parameters);
      assert.equal(adapted[name].renderCall, host[name].renderCall);
      assert.equal(adapted[name].renderResult, host[name].renderResult);
    }
    const ctx = { cwd: root } as ExtensionToolContext;
    const content = "\uFEFFalpha\r\nbeta\r\n";
    const run = async (tools: typeof host) => {
      const w = await tools.write.execute("w", { path: "ordinary.md", content }, undefined, undefined, ctx);
      const r = await tools.read.execute("r", { path: "ordinary.md", offset: 2, limit: 1 }, undefined, undefined, ctx);
      const e = await tools.edit.execute("e", {
        path: "ordinary.md", edits: [{ oldText: "beta", newText: "gamma" }],
      }, undefined, undefined, ctx);
      const bytes = await readFile(join(root, "ordinary.md"));
      const error = await tools.edit.execute("bad", {
        path: "ordinary.md", edits: [{ oldText: "missing", newText: "x" }],
      }, undefined, undefined, ctx).catch((err: Error) => err.message);
      return { w, r, e, bytes, error };
    };
    assert.deepEqual(await run(adapted), await run(host));
    await writeFile(join(root, "long.txt"), Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n"));
    assert.deepEqual(
      await adapted.read.execute("r", { path: "long.txt" }, undefined, undefined, ctx),
      await host.read.execute("r", { path: "long.txt" }, undefined, undefined, ctx),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed six-tool definitions match the public host schema and required public metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-six-tool-"));
  try {
    const store = await makeStore(join(root, "agent"));
    await store.config.setEnabled(false);
    const provider = async () => store;
    const adapted = { ...managedFileTools(root, provider), ...managedScanTools(root, provider) };
    const host = {
      read: createReadToolDefinition(root),
      write: createWriteToolDefinition(root),
      edit: createEditToolDefinition(root),
      grep: createGrepToolDefinition(root),
      find: createFindToolDefinition(root),
      ls: createLsToolDefinition(root),
    };
    const names = ["read", "write", "edit", "grep", "find", "ls"] as const;
    assert.deepEqual(Object.keys(adapted).sort(), [...names].sort());
    for (const name of names) {
      const tool = adapted[name];
      const source = host[name];
      assert.deepEqual(Object.keys(tool).sort(), Object.keys(source).sort(), name);
      assert.equal(tool.name, name, name);
      assert.equal(tool.label, source.label, name);
      assert.equal(typeof tool.execute, "function", name);
      assert.equal(typeof tool.description, "string", name);
      assert.ok(tool.description.length > 0, name);
      assert.equal(tool.description, source.description, name);
      assert.equal(tool.promptSnippet, source.promptSnippet, name);
      assert.deepEqual(tool.promptGuidelines, source.promptGuidelines, name);
      assert.equal(typeof tool.parameters, "object", name);
      assert.equal(tool.parameters.type, "object", name);
      assert.equal(typeof tool.parameters.properties, "object", name);
      assert.deepEqual(tool.parameters, source.parameters, name);
      assert.deepEqual(tool.constrainedSampling, source.constrainedSampling, name);
      assert.equal(tool.renderShell, source.renderShell, name);
      assert.equal(tool.prepareArguments, source.prepareArguments, name);
      assert.equal(tool.renderCall, source.renderCall, name);
      assert.equal(tool.renderResult, source.renderResult, name);
      assert.equal(tool.outputSchema, source.outputSchema, name);
    }

    const definitions = { ...adapted } as Record<string, ToolDefinition>;
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [(pi) => { for (const name of names) pi.registerTool(definitions[name]); }],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const registered = loaded.extensions[0].tools;
    assert.deepEqual([...registered.keys()].sort(), [...names].sort());
    for (const name of names) assert.equal(registered.get(name)!.definition.name, name, name);
    const ctx = { cwd: root } as ExtensionToolContext;
    const write = await adapted.write.execute("w", { path: "ordinary.md", content: "host contract" }, undefined, undefined, ctx);
    assert.equal(await readFile(join(root, "ordinary.md"), "utf8"), "host contract");
    assert.ok(!JSON.stringify(write.content).includes("Memory"), "an ordinary write does not claim managed memory");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real pi dispatcher composes exactly one named section without replacing foreign sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-section-"));
  try {
    let prompt = "";
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [(pi) => {
        pi.on("before_agent_start", (event) => { setMemorySection(event.systemPromptOptions, "contract snapshot"); });
        pi.on("before_agent_start", (event) => { prompt = event.systemPrompt; });
      }],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false,
    });
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root,
      SessionManager.inMemory(root), new ModelRegistry(runtime));
    const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "test" }, {
      cwd: root, sections: { foreign: "keep me" }, selectedTools: ["read"],
    });
    assert.deepEqual(result.systemPromptOptions.sections, { foreign: "keep me", auto_memory: "contract snapshot" });
    assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
    assert.equal(prompt.split("<auto_memory>").length - 1, 1);
    assert.ok(prompt.includes("<foreign>\nkeep me\n</foreign>"));
    assert.ok(prompt.includes("<auto_memory>\ncontract snapshot\n</auto_memory>"));
    setMemorySection(result.systemPromptOptions);
    assert.deepEqual(result.systemPromptOptions.sections, { foreign: "keep me" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
