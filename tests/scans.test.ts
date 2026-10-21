import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionToolContext, AgentToolResult } from "@earendil-works/pi-coding-agent";

const hostAgent = await mkdtemp(join(tmpdir(), "auto-memory-scan-host-"));
const priorAgent = process.env.PI_CODING_AGENT_DIR;
const priorOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = hostAgent;
process.env.PI_OFFLINE = "1";
const { createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition } = await import("@earendil-works/pi-coding-agent");
const { managedScanTools } = await import("../src/pi/scans.js");
const { makeStore, testProjectId } = await import("./helpers/store.js");
const { MemoryStore } = await import("../src/core/store.js");
const { escapeScanGlob } = await import("../src/pi/scan-policy.js");
const { existingBinary } = await import("../src/pi/scan-binary.js");
after(async () => {
  if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgent;
  if (priorOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = priorOffline;
  await rm(hostAgent, { recursive: true, force: true });
});

function locate(name: "rg" | "fd"): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const candidate of name === "fd" ? ["fd", "fdfind"] : ["rg"]) {
      const path = join(dir, candidate);
      if (spawnSync(path, ["--version"], { stdio: "ignore" }).status === 0) return path;
    }
  }
}
const rg = locate("rg");
const fd = locate("fd");
const hasBinaries = !!rg && !!fd;
const text = (result: AgentToolResult<unknown>) => result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
const ctx = (cwd: string) => ({ cwd }) as ExtensionToolContext;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-scans-"));
  const agent = join(root, "代理 [é] {a,b} ? * ! \\ agent");
  const store = await makeStore(agent);
  const other = join(store.paths.memoryRoot, `cwd-${"c".repeat(64)}`);
  const ordinary = join(root, "ordinary");
  await mkdir(store.paths.projectDir, { recursive: true });
  await mkdir(other);
  await mkdir(ordinary);
  await writeFile(join(store.paths.projectDir, "current.md"), "before\r\nneedle current\r\nafter\r\n");
  await writeFile(join(other, "forbidden.md"), "needle FORBIDDEN\n");
  await writeFile(join(ordinary, "ordinary.txt"), "before\r\nneedle ordinary\r\nafter\r\n");
  return { root, agent, store, other, ordinary, tools: managedScanTools(root, store) };
}

async function recordingBinary(agent: string, name: "rg" | "fd", binary?: string, hang = false): Promise<string> {
  await mkdir(join(agent, "bin"), { recursive: true });
  const log = join(hostAgent, `${name}-${randomUUID()}-argv.jsonl`);
  const script = join(agent, "bin", name);
  await writeFile(script, `#!${process.execPath}\n` +
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\n` +
    (hang ? "setInterval(()=>{},1000);\n" : binary ?
      `const child=require('node:child_process').spawn(${JSON.stringify(binary)},process.argv.slice(2),{stdio:'inherit'});process.on('SIGTERM',()=>child.kill());child.on('exit',(code)=>process.exit(code??0));\n` :
      "process.exit(0);\n"));
  await chmod(script, 0o700);
  return log;
}

async function argv(log: string): Promise<string[][]> {
  return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("scans preserve public names, schemas, renderers and provider context; ordinary output delegates unchanged", { skip: !hasBinaries }, async () => {
  const f = await fixture();
  try {
    let provided: ExtensionToolContext | undefined;
    const tools = managedScanTools(f.root, async (context) => { provided = context; return f.store; });
    const host = { grep: createGrepToolDefinition(f.root), find: createFindToolDefinition(f.root), ls: createLsToolDefinition(f.root) };
    for (const name of ["grep", "find", "ls"] as const) {
      assert.equal(tools[name].name, name);
      assert.deepEqual(tools[name].parameters, host[name].parameters);
      assert.equal(tools[name].renderCall, host[name].renderCall);
      assert.equal(tools[name].renderResult, host[name].renderResult);
      assert.equal(tools[name].prepareArguments, host[name].prepareArguments);
    }
    await f.store.config.setEnabled(false);
    const context = ctx(f.ordinary);
    for (const params of [{ pattern: "needle" }, { pattern: "NEEDLE", ignoreCase: true, context: 1, limit: 1 }, { pattern: "absent", glob: "*.txt" }]) {
      assert.deepEqual(await tools.grep.execute("g", params, undefined, undefined, context), await host.grep.execute("g", params, undefined, undefined, context));
    }
    assert.deepEqual(await tools.find.execute("f", { pattern: "*.txt", limit: 1 }, undefined, undefined, context), await host.find.execute("f", { pattern: "*.txt", limit: 1 }, undefined, undefined, context));
    assert.deepEqual(await tools.ls.execute("l", {}, undefined, undefined, context), await host.ls.execute("l", {}, undefined, undefined, context));
    assert.equal(provided, context);
    const params = { path: join(f.ordinary, "missing"), pattern: "x" };
    assert.equal(await tools.grep.execute("g", params, undefined, undefined, context).catch((e: Error) => e.message), await host.grep.execute("g", params, undefined, undefined, context).catch((e: Error) => e.message));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("ancestor/default-cwd scans prune cross-project before rg/fd; escaped Unicode glob-special names cannot bypass", { skip: !hasBinaries }, async () => {
  const f = await fixture();
  try {
    const rgLog = await recordingBinary(f.agent, "rg", rg);
    const fdLog = await recordingBinary(f.agent, "fd", fd);
    const context = ctx(f.root);
    const grep = await f.tools.grep.execute("g", { pattern: "needle", glob: "**/*", context: 1 }, undefined, undefined, context);
    assert.match(text(grep), /needle ordinary/);
    assert.match(text(grep), /needle current/);
    assert.doesNotMatch(text(grep), /FORBIDDEN|forbidden\.md/);
    const find = await f.tools.find.execute("f", { pattern: "*" }, undefined, undefined, context);
    assert.match(text(find), /ordinary\.txt/);
    assert.match(text(find), /current\.md/);
    assert.doesNotMatch(text(find), /forbidden\.md|cwd-c{64}/);
    const gArgs = (await argv(rgLog))[0];
    const fArgs = (await argv(fdLog))[0];
    assert.ok(gArgs.includes(`!**${escapeScanGlob(f.other)}`));
    assert.ok(gArgs.indexOf(`!**${escapeScanGlob(f.other)}`) > gArgs.indexOf("**/*"));
    assert.ok(fArgs.includes("--exclude"));
    assert.ok(fArgs.some((arg) => arg.endsWith(`/memory/${basename(f.other)}`)));
    await f.store.config.setEnabled(false);
    const protectedOutput = await f.tools.grep.execute("g", { pattern: "needle ordinary", context: 1, limit: 1 }, undefined, undefined, context);
    const ordinaryOutput = await createGrepToolDefinition(f.root).execute("g", { pattern: "needle ordinary", context: 1, limit: 1 }, undefined, undefined, context);
    assert.deepEqual(protectedOutput, ordinaryOutput);
    await writeFile(join(f.ordinary, "long.txt"), "needle " + "é".repeat(30000));
    const protectedLong = await f.tools.grep.execute("g", { pattern: "needle", glob: "**/long.txt" }, undefined, undefined, context);
    const hostLong = await createGrepToolDefinition(f.root).execute("g", { pattern: "needle", glob: "**/long.txt" }, undefined, undefined, context);
    assert.deepEqual(protectedLong, hostLong);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rg user --follow configuration cannot traverse ordinary aliases into forbidden memory", { skip: !hasBinaries }, async () => {
  const f = await fixture();
  const previous = process.env.RIPGREP_CONFIG_PATH;
  try {
    const config = join(hostAgent, `rg-config-${randomUUID()}`);
    await writeFile(config, "--follow\n");
    process.env.RIPGREP_CONFIG_PATH = config;
    await symlink(f.store.paths.memoryRoot, join(f.ordinary, "leak"));
    await f.store.config.setEnabled(false);
    const log = await recordingBinary(f.agent, "rg", rg);
    const result = await f.tools.grep.execute("follow", { pattern: "needle" }, undefined, undefined, ctx(f.root));
    assert.match(text(result), /ordinary/);
    assert.doesNotMatch(text(result), /current|FORBIDDEN|leak/);
    assert.ok((await argv(log))[0].includes("--no-follow"));
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previous;
    await rm(f.root, { recursive: true, force: true });
  }
});

test("direct current, alias, cross-project, off, unknown and child access gates", { skip: !hasBinaries }, async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, "alias");
    await symlink(f.store.paths.projectDir, alias);
    const context = ctx(f.root);
    for (const path of [f.store.paths.projectDir, alias, `@${alias}`]) {
      assert.match(text(await f.tools.grep.execute("g", { pattern: "needle", path }, undefined, undefined, context)), /current/);
      assert.match(text(await f.tools.find.execute("f", { pattern: "*.md", path }, undefined, undefined, context)), /current\.md/);
      assert.equal(text(await f.tools.ls.execute("l", { path }, undefined, undefined, context)), "current.md");
    }
    for (const mode of ["cross", "off", "unknown", "child"]) {
      let tools = f.tools;
      let path = f.store.paths.projectDir;
      if (mode === "cross") path = f.other;
      if (mode === "off") await f.store.config.setEnabled(false);
      if (mode === "unknown") await writeFile(f.store.config.path, "broken");
      if (mode === "child") {
        await rm(f.store.config.path);
        tools = managedScanTools(f.root, new MemoryStore(f.store.paths, f.store.config, true));
      }
      await assert.rejects(tools.grep.execute("g", { pattern: "needle", path }, undefined, undefined, context), /Memory /);
      await assert.rejects(tools.find.execute("f", { pattern: "*", path }, undefined, undefined, context), /Memory /);
      await assert.rejects(tools.ls.execute("l", { path }, undefined, undefined, context), /Memory /);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("memory root and ancestors retain ordinary results, while off/unknown/child exclude all memory before scanning", { skip: !hasBinaries }, async () => {
  const f = await fixture();
  try {
    const rgLog = await recordingBinary(f.agent, "rg", rg);
    const fdLog = await recordingBinary(f.agent, "fd", fd);
    assert.equal(text(await f.tools.ls.execute("l", { path: f.store.paths.memoryRoot }, undefined, undefined, ctx(f.root))), `${testProjectId}/`);
    assert.match(text(await f.tools.grep.execute("g", { path: f.store.paths.memoryRoot, pattern: "needle" }, undefined, undefined, ctx(f.root))), /current/);
    assert.doesNotMatch(text(await f.tools.find.execute("f", { path: f.store.paths.memoryRoot, pattern: "*" }, undefined, undefined, ctx(f.root))), /forbidden/);
    for (const mode of ["off", "unknown", "child"]) {
      let tools = f.tools;
      if (mode === "off") await f.store.config.setEnabled(false);
      if (mode === "unknown") await writeFile(f.store.config.path, "corrupt");
      if (mode === "child") tools = managedScanTools(f.root, new MemoryStore(f.store.paths, f.store.config, true));
      assert.match(text(await tools.grep.execute("g", { pattern: "needle" }, undefined, undefined, ctx(f.root))), /ordinary/);
      assert.doesNotMatch(text(await tools.grep.execute("g", { pattern: "needle" }, undefined, undefined, ctx(f.root))), /current|FORBIDDEN/);
      assert.doesNotMatch(text(await tools.find.execute("f", { pattern: "*.md" }, undefined, undefined, ctx(f.root))), /current|forbidden/);
      assert.ok((await argv(rgLog)).at(-1)!.includes(`!**${escapeScanGlob(f.store.paths.memoryRoot)}`));
      assert.ok((await argv(fdLog)).at(-1)!.some((arg) => arg.endsWith("/memory")));
      assert.doesNotMatch(text(await tools.ls.execute("l", { path: f.agent }, undefined, undefined, ctx(f.root))), /memory\//);
      assert.equal(text(await tools.grep.execute("g", { pattern: "needle" }, undefined, undefined, ctx(f.store.paths.memoryRoot))), "No matches found");
      assert.equal(text(await tools.find.execute("f", { pattern: "*" }, undefined, undefined, ctx(f.store.paths.memoryRoot))), "No files found matching pattern");
      assert.equal(text(await tools.ls.execute("l", {}, undefined, undefined, ctx(f.store.paths.memoryRoot))), "(empty directory)");
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("project-disable prunes memory like a global off, and a disable before results return discards them", { skip: !hasBinaries }, async (t) => {
  const f = await fixture();
  try {
    const context = ctx(f.root);
    assert.match(text(await f.tools.grep.execute("g", { pattern: "needle", path: f.store.paths.projectDir }, undefined, undefined, context)), /current/);
    await f.store.config.setProjectDisabled(f.store.paths.projectId, true);
    await assert.rejects(f.tools.grep.execute("g", { pattern: "needle", path: f.store.paths.projectDir }, undefined, undefined, context), /Memory is off/);
    const ancestor = text(await f.tools.grep.execute("g", { pattern: "needle" }, undefined, undefined, context));
    assert.match(ancestor, /ordinary/);
    assert.doesNotMatch(ancestor, /current|FORBIDDEN/);
    assert.equal(text(await f.tools.ls.execute("l", { path: f.store.paths.memoryRoot }, undefined, undefined, context)), "(empty directory)");
    await f.store.config.setProjectDisabled(f.store.paths.projectId, false);
    const read = f.store.config.read.bind(f.store.config);
    let calls = 0;
    t.mock.method(f.store.config, "read", async () => {
      calls++;
      const state = await read();
      if (calls >= 2 && state.status === "known") {
        return { ...state, data: { ...state.data, version: 2 as const, disabledProjects: [f.store.paths.projectId] }, enabled: state.enabled };
      }
      return state;
    });
    const midScan = await f.tools.grep.execute("g", { pattern: "needle", path: f.store.paths.projectDir }, undefined, undefined, context).then(() => "resolved", (error: Error) => error.message);
    assert.match(String(midScan), /Memory scan invalidated by a settings change/);
    assert.equal(calls >= 2, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("ls excludes forbidden names before child stat; memory symlinks are refused and never followed", { skip: !hasBinaries }, async () => {
  const f = await fixture();
  const originalStat = fsPromises.stat;
  try {
    const secretLink = join(f.store.paths.projectDir, "link.md");
    const dirLink = join(f.store.paths.projectDir, "linked-dir");
    await symlink(join(f.other, "forbidden.md"), secretLink);
    await symlink(f.other, dirLink);
    const statCalls: string[] = [];
    fsPromises.stat = (async (...args: Parameters<typeof originalStat>) => {
      statCalls.push(String(args[0]));
      return originalStat(...args);
    }) as typeof originalStat;
    syncBuiltinESMExports();
    assert.equal(text(await f.tools.ls.execute("l", { path: f.store.paths.memoryRoot }, undefined, undefined, ctx(f.root))), `${testProjectId}/`);
    assert.equal(statCalls.some((path) => path === f.other), false);
    statCalls.length = 0;
    assert.equal(text(await f.tools.ls.execute("l", { path: f.store.paths.projectDir }, undefined, undefined, ctx(f.root))), "current.md");
    assert.equal(statCalls.includes(secretLink), false);
    assert.equal(statCalls.includes(dirLink), false);
    const fdLog = await recordingBinary(f.agent, "fd", fd);
    const found = await f.tools.find.execute("f", { pattern: "*" }, undefined, undefined, ctx(f.root));
    assert.doesNotMatch(text(found), /link\.md|linked-dir|forbidden/);
    assert.ok((await argv(fdLog))[0].some((arg) => arg.endsWith("/link.md")));
    for (const path of [secretLink, dirLink]) {
      await assert.rejects(f.tools.grep.execute("g", { path, pattern: "needle" }, undefined, undefined, ctx(f.root)), /symbolic links/);
      await assert.rejects(f.tools.find.execute("f", { path, pattern: "*" }, undefined, undefined, ctx(f.root)), /symbolic links/);
      await assert.rejects(f.tools.ls.execute("l", { path }, undefined, undefined, ctx(f.root)), /symbolic links/);
    }
  } finally {
    fsPromises.stat = originalStat;
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("overlapping scans retain host ignore rules, path-containing find patterns, and direct-current formatting", { skip: !hasBinaries }, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, ".git"));
    await writeFile(join(f.root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(f.ordinary, "ignored.txt"), "needle ignored");
    await mkdir(join(f.ordinary, "src"));
    await writeFile(join(f.ordinary, "src", "one.spec.ts"), "needle source");
    const context = ctx(f.root);
    const found = await f.tools.find.execute("f", { pattern: "ordinary/src/**/*.spec.ts" }, undefined, undefined, context);
    assert.deepEqual(found, await createFindToolDefinition(f.root).execute("f", { pattern: "ordinary/src/**/*.spec.ts" }, undefined, undefined, context));
    assert.equal(text(found), "ordinary/src/one.spec.ts");
    assert.doesNotMatch(text(await f.tools.grep.execute("g", { pattern: "needle" }, undefined, undefined, context)), /needle ignored/);
    assert.doesNotMatch(text(await f.tools.find.execute("f", { pattern: "*.txt" }, undefined, undefined, context)), /ignored\.txt/);
    const currentContext = ctx(f.store.paths.projectDir);
    for (const params of [{ pattern: "needle", context: 1 }, { pattern: "NEEDLE", ignoreCase: true, limit: 1 }]) {
      assert.deepEqual(await f.tools.grep.execute("g", params, undefined, undefined, currentContext), await createGrepToolDefinition(f.root).execute("g", params, undefined, undefined, currentContext));
    }
    assert.deepEqual(await f.tools.find.execute("f", { pattern: "*.md", limit: 1 }, undefined, undefined, currentContext), await createFindToolDefinition(f.root).execute("f", { pattern: "*.md", limit: 1 }, undefined, undefined, currentContext));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("binary discovery prefers agentDir/bin, honors PATH order and fd/fdfind fallback, and rejects missing or non-executable files without running them", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-scan-binary-"));
  try {
    const agent = join(root, "agent");
    const bin = join(agent, "bin");
    const firstDir = join(root, "path-first");
    const secondDir = join(root, "path-second");
    const emptyDir = join(root, "empty");
    for (const dir of [bin, firstDir, secondDir, emptyDir]) await mkdir(dir, { recursive: true });
    const searchPath = [firstDir, secondDir, emptyDir].join(delimiter);
    const executable = async (dir: string, name: string, body: string) => {
      const path = join(dir, name);
      await writeFile(path, body, { mode: 0o700 });
      return path;
    };
    const warns = () => { throw new Error("discovered binary must not be executed during discovery"); };

    const agentRg = await executable(bin, "rg", `#!${process.execPath}\n${warns.toString()}\n`);
    const pathRg = await executable(firstDir, "rg", `#!${process.execPath}\n${warns.toString()}\n`);
    const laterRg = await executable(secondDir, "rg", `#!${process.execPath}\n${warns.toString()}\n`);
    assert.equal(await existingBinary("rg", agent, undefined, searchPath), agentRg);
    await rm(agentRg);
    assert.equal(await existingBinary("rg", agent, undefined, searchPath), pathRg);
    await rm(pathRg);
    await chmod(laterRg, 0o600);
    await assert.rejects(existingBinary("rg", agent, undefined, searchPath), /existing rg.*no download/);
    await rm(laterRg);
    await assert.rejects(existingBinary("rg", agent, undefined, searchPath), /existing rg.*no download/);
    await writeFile(join(secondDir, "rg"), "");
    await chmod(join(secondDir, "rg"), 0o700);
    assert.equal(await existingBinary("rg", agent, undefined, searchPath), join(secondDir, "rg"));

    const pathFd = await executable(firstDir, "fd", `#!${process.execPath}\n${warns.toString()}\n`);
    const fallbackFdfind = await executable(secondDir, "fdfind", `#!${process.execPath}\n${warns.toString()}\n`);
    assert.equal(await existingBinary("fd", agent, undefined, searchPath), pathFd);
    await rm(pathFd);
    assert.equal(await existingBinary("fd", agent, undefined, searchPath), fallbackFdfind);
    await rm(fallbackFdfind);
    await assert.rejects(existingBinary("fd", agent, undefined, searchPath), /existing fd\/fdfind.*no download/);

    const agentFdfind = await executable(bin, "fdfind", `#!${process.execPath}\n${warns.toString()}\n`);
    assert.equal(await existingBinary("fd", agent, undefined, searchPath), agentFdfind);
    await chmod(agentFdfind, 0o600);
    await assert.rejects(existingBinary("fd", agent, undefined, searchPath), /existing fd\/fdfind.*no download/);
    await mkdir(join(secondDir, "fd"));
    await assert.rejects(existingBinary("fd", agent, undefined, searchPath), /existing fd\/fdfind.*no download/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("binary discovery honors abort signals and never falls back to the ambient PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-scan-binary-abort-"));
  const priorPath = process.env.PATH;
  try {
    const agent = join(root, "agent");
    const bin = join(agent, "bin");
    const offline = join(root, "offline");
    await mkdir(bin, { recursive: true });
    await mkdir(offline);
    process.env.PATH = offline;
    await assert.rejects(existingBinary("rg", agent), /existing rg.*no download/);
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(existingBinary("rg", agent, preAborted.signal), /Operation aborted/);
    const discovered = join(bin, "rg");
    await writeFile(discovered, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(existingBinary("rg", agent, aborted.signal), /Operation aborted/);
    assert.equal(await existingBinary("rg", agent), discovered);
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("protected find streaming retains host byte truncation, result-limit details and directory suffixes", async () => {
  const f = await fixture();
  const hostBinary = join(hostAgent, "bin", "fd");
  try {
    const canonicalRoot = await realpath(f.root);
    const paths = Array.from({ length: 600 }, (_, i) => join(canonicalRoot, "ordinary", `${i}-${"é".repeat(100)}`) + (i % 2 === 0 ? "/" : ""));
    const body = `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(paths.join("\n") + "\n")});\n`;
    await mkdir(join(f.agent, "bin"), { recursive: true });
    await mkdir(join(hostAgent, "bin"), { recursive: true });
    await writeFile(join(f.agent, "bin", "fd"), body, { mode: 0o700 });
    await writeFile(hostBinary, body, { mode: 0o700 });
    for (const limit of [600, 1000]) {
      const result = await f.tools.find.execute("f", { pattern: "*", limit }, undefined, undefined, ctx(canonicalRoot));
      const standard = await createFindToolDefinition(f.root).execute("f", { pattern: "*", limit }, undefined, undefined, ctx(canonicalRoot));
      assert.deepEqual(result, standard);
      assert.equal(result.details?.truncation?.truncated, true);
      assert.equal(result.details?.resultLimitReached, limit === 600 ? 600 : undefined);
      assert.match(text(result), /ordinary\/0-.*\//);
    }
  } finally {
    await rm(hostBinary, { force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test("protected binary absence is a safe explicit failure without download; fdfind PATH fallback works", async () => {
  const f = await fixture();
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = "";
    await assert.rejects(f.tools.grep.execute("g", { pattern: "needle" }, undefined, undefined, ctx(f.root)), /existing rg.*no download/);
    await assert.rejects(f.tools.find.execute("f", { pattern: "*" }, undefined, undefined, ctx(f.root)), /existing fd\/fdfind.*no download/);
    await assert.rejects(access(join(f.agent, "bin")), { code: "ENOENT" });
    const fallback = join(f.root, "fallback-bin");
    await mkdir(fallback);
    await writeFile(join(fallback, "fdfind"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(await realpath(join(f.ordinary, "ordinary.txt")) + "\n")});\n`);
    await chmod(join(fallback, "fdfind"), 0o700);
    process.env.PATH = fallback;
    assert.equal(text(await f.tools.find.execute("f", { pattern: "*" }, undefined, undefined, ctx(f.root))), "ordinary/ordinary.txt");
    assert.deepEqual(await readdir(fallback), ["fdfind"]);
  } finally {
    process.env.PATH = priorPath;
    await rm(f.root, { recursive: true, force: true });
  }
});

test("protected streaming grep/find cancellation kills the backend; pre-aborted calls do not spawn", async () => {
  const f = await fixture();
  try {
    for (const name of ["grep", "find"] as const) {
      const log = await recordingBinary(f.agent, name === "grep" ? "rg" : "fd", undefined, true);
      const controller = new AbortController();
      const params = name === "grep" ? { pattern: "needle" } : { pattern: "*" };
      const promise = f.tools[name].execute("cancel", params, controller.signal, undefined, ctx(f.root));
      let settled = false;
      let failure: unknown;
      const observed = promise.then(() => { settled = true; }, (error: unknown) => { settled = true; failure = error; });
      try {
        const deadline = performance.now() + 10_000;
        let started = false;
        while (performance.now() < deadline) {
          if (settled) throw failure ?? new Error(`${name} completed before cancellation`);
          const records = await argv(log).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error instanceof SyntaxError) return [];
            throw error;
          });
          if (records.length === 1) { started = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(started, `${name} backend did not record its invocation within 10 seconds`);
        controller.abort();
        await assert.rejects(promise, /Operation aborted/);
        const aborted = new AbortController(); aborted.abort();
        await assert.rejects(f.tools[name].execute("pre-abort", params, aborted.signal, undefined, ctx(f.root)), /Operation aborted/);
        assert.equal((await argv(log)).length, 1);
      } finally {
        controller.abort();
        await observed;
      }
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
