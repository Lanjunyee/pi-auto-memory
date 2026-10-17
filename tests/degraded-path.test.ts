import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { classifyLexical, lexicalMemoryRoot } from "../src/pi/degraded-path.js";

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map((block) => (typeof block.text === "string" ? block.text : "")).join("");

test("lexical route distinguishes memory, ancestor and ordinary paths", () => {
  const agentDir = resolve("/tmp/agent-probe");
  const root = lexicalMemoryRoot(agentDir);
  assert.equal(root, join(agentDir, "memory"));
  assert.equal(classifyLexical(root, join(root, "project", "topic.md")), "memory");
  assert.equal(classifyLexical(root, root), "memory");
  assert.equal(classifyLexical(root, agentDir), "ancestor");
  assert.equal(classifyLexical(root, "/tmp"), "ancestor");
  assert.equal(classifyLexical(root, resolve("/elsewhere/code.ts")), "ordinary");
});

test("lexical route does not treat shared prefixes as memory paths", () => {
  const root = lexicalMemoryRoot(resolve("/tmp/agent-probe"));
  for (const path of ["/tmp/agent-probe/memory-backup/x.md", "/tmp/agent-probe/memory2/x.md", "/tmp/agent-probe/memoryx"]) {
    assert.equal(classifyLexical(root, path), "ordinary", path);
  }
});

test("lexical route keeps other projects inside the memory root", () => {
  const root = lexicalMemoryRoot(resolve("/tmp/agent-probe"));
  assert.equal(classifyLexical(root, join(root, "git-".concat("a".repeat(64)), "MEMORY.md")), "memory");
  assert.equal(classifyLexical(root, join(root, "cwd-".concat("b".repeat(64)))), "memory");
});

test("all six managed tools degrade ordinary paths and keep memory paths closed", async () => {
  const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { managedFileTools } = await import("../src/pi/tools.js");
  const { managedScanTools } = await import("../src/pi/scans.js");
  const root = await mkdtemp(join(tmpdir(), "auto-memory-degraded-"));
  try {
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(project);
    await mkdir(agentDir);
    await writeFile(join(project, "ordinary.md"), "ordinary body");
    await writeFile(join(project, "code.ts"), "const marker = 1;\n");
    const failing = async () => { throw new Error("Memory paused: user directory is unavailable."); };
    const tools = { ...managedFileTools(project, failing, { agentDir }), ...managedScanTools(project, failing, { agentDir }) };
    const ctx = { cwd: project } as any;
    const memoryFile = join(agentDir, "memory", "git-".concat("a".repeat(64)), "topic.md");

    const read = await tools.read.execute("r", { path: "ordinary.md" }, undefined, undefined, ctx);
    assert.deepEqual(read.content.map((block: any) => block.text), ["ordinary body"]);
    await tools.write.execute("w", { path: "created.md", content: "created" }, undefined, undefined, ctx);
    assert.equal(await readFile(join(project, "created.md"), "utf8"), "created");
    await tools.edit.execute("e", { path: "ordinary.md", edits: [{ oldText: "body", newText: "edited" }] }, undefined, undefined, ctx);
    assert.equal(await readFile(join(project, "ordinary.md"), "utf8"), "ordinary edited");
    assert.match(textOf(await tools.grep.execute("g", { pattern: "marker" }, undefined, undefined, ctx)), /code\.ts:1/);
    assert.match(textOf(await tools.find.execute("f", { pattern: "*.ts" }, undefined, undefined, ctx)), /code\.ts/);
    assert.match(textOf(await tools.ls.execute("l", {}, undefined, undefined, ctx)), /ordinary\.md/);

    for (const call of [
      () => tools.read.execute("r", { path: memoryFile }, undefined, undefined, ctx),
      () => tools.write.execute("w", { path: memoryFile, content: "leak" }, undefined, undefined, ctx),
      () => tools.edit.execute("e", { path: memoryFile, edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, ctx),
      () => tools.grep.execute("g", { pattern: "x", path: join(agentDir, "memory") }, undefined, undefined, ctx),
      () => tools.ls.execute("l", { path: join(agentDir, "memory") }, undefined, undefined, ctx),
      () => tools.find.execute("f", { pattern: "*", path: join(agentDir, "memory") }, undefined, undefined, ctx),
      () => tools.grep.execute("g", { pattern: "x", path: root }, undefined, undefined, ctx),
      () => tools.ls.execute("l", { path: root }, undefined, undefined, ctx),
      () => tools.find.execute("f", { pattern: "*", path: root }, undefined, undefined, ctx),
    ]) {
      const outcome = await call().then((value) => ({ text: value.content.map((block: any) => block.text).join(" ") }), (error: Error) => ({ error: error.message }));
      if ("text" in outcome) {
        assert.doesNotMatch(outcome.text, /leak|MEMORY\.md/, "memory body must not leak");
      } else {
        assert.match(outcome.error, /Memory/, "ancestor scans report the memory fault");
      }
    }
    assert.equal(await readFile(memoryFile, "utf8").catch(() => "absent"), "absent");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a repaired directory restores managed behaviour within the same session", async () => {
  const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { managedFileTools } = await import("../src/pi/tools.js");
  const { sessionStoreProvider } = await import("../src/pi/registration.js");
  const root = await mkdtemp(join(tmpdir(), "auto-memory-recover-"));
  try {
    await symlink("b", join(root, "a"));
    await symlink("a", join(root, "b"));
    const provider = sessionStoreProvider(join(root, "a", "agent"));
    const tools = managedFileTools(root, (ctx) => provider.obtain(ctx), { agentDir: join(root, "a", "agent") });
    const ctx = { cwd: root } as any;
    await writeFile(join(root, "code.md"), "ordinary");
    const degraded = await tools.read.execute("r", { path: "code.md" }, undefined, undefined, ctx);
    assert.equal(textOf(degraded), "ordinary");
    await rm(join(root, "a"));
    await rm(join(root, "b"));
    await mkdir(join(root, "a"));
    await mkdir(join(root, "b"));
    const memoryDir = join(root, "a", "agent", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(root, "plain.md"), "still ordinary");
    const recovered = await tools.read.execute("r", { path: "plain.md" }, undefined, undefined, ctx);
    assert.equal(textOf(recovered), "still ordinary");
  } finally { await rm(root, { recursive: true, force: true }); }
});
