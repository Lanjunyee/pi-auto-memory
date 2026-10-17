import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

const sourceRoot = resolve(process.argv[2] ?? ".");
const hostVersion = execFileSync("pi", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const cli = process.env.PI_CLI ?? realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());

const root = await mkdtemp(join(tmpdir(), "auto-memory-isolated-"));
const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });

try {
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const cache = join(root, "npm-cache");
  await Promise.all([mkdir(project), mkdir(agentDir), mkdir(home), mkdir(cache)]);
  execFileSync("git", ["init", "-q"], { cwd: project });

  const emptyConfig = join(home, "empty-npmrc");
  const emptyGlobal = join(home, "empty-global-npmrc");
  const emptyGit = join(home, "empty-gitconfig");
  await Promise.all([writeFile(emptyConfig, ""), writeFile(emptyGlobal, ""), writeFile(emptyGit, "")]);

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: root,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    npm_config_cache: cache,
    npm_config_userconfig: emptyConfig,
    npm_config_globalconfig: emptyGlobal,
    npm_config_audit: "false",
    npm_config_fund: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGit,
  };
  const run = (command, args, cwd = project) =>
    execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  run("node", [cli, "install", sourceRoot]);
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.packages.length, 1, "install must record exactly one package source");
  step("install", { packages: settings.packages });

  const probe = join(sourceRoot, ".verify-probe.ts");
  await writeFile(probe, `
    import assert from "node:assert/strict";
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";
    const [cwd, agentDir, out] = process.argv.slice(2);
    const loader = new DefaultResourceLoader({ cwd, agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, [], "installed extension must load without errors");
    assert.equal(loaded.extensions.length, 1, "exactly one extension must be discovered");
    const commands = loaded.extensions.map((extension) => [...extension.commands.keys()]).flat();
    assert.deepEqual(commands, ["memory"], "the memory command must be registered");
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
    let modelCalls = 0;
    runtime.streamSimple = () => { modelCalls += 1; throw new Error("Model calls are forbidden in this verification"); };
    const { session } = await createAgentSession({ cwd, agentDir, tools: ["read", "write", "edit"],
      settingsManager: SettingsManager.inMemory(), modelRuntime: runtime, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd) });
    try {
      await session.bindExtensions({});
      const ctx = { cwd };
      const identity = await import("./src/core/project-identity.ts");
      const project = await identity.identifyProject(cwd);
      const topic = join(agentDir, "memory", project.projectId, "topic.md");
      const write = await session.getToolDefinition("write").execute("w", { path: topic, content: "synthetic isolated memory" }, undefined, undefined, ctx);
      assert.equal(write.isError, false, "managed write must succeed");
      assert.match(write.content.map((block) => block.text ?? "").join(" "), /Saved successfully/, "managed write must report a memory save");
      assert.match(await readFile(topic, "utf8"), /synthetic isolated memory/);
      const read = await session.getToolDefinition("read").execute("r", { path: topic }, undefined, undefined, ctx);
      assert.match(read.content.map((block) => block.text ?? "").join(" "), /synthetic isolated memory/);
      const ordinary = join(cwd, "ordinary.txt");
      await writeFile(ordinary, "ordinary file");
      const ordinaryRead = await session.getToolDefinition("read").execute("r", { path: "ordinary.txt" }, undefined, undefined, ctx);
      assert.equal(ordinaryRead.content[0].text, "ordinary file");
      await writeFile(out, JSON.stringify({ errors: 0, extensions: 1, commands, managedWrite: "saved",
        managedRead: "returned", ordinaryRead: "delegated", modelCalls }));
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  `);
  try {
    execFileSync("node", ["--import", "tsx", probe, project, agentDir, join(root, "probe.json")],
      { cwd: sourceRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } finally { await rm(probe, { force: true }); }
  step("capabilities", JSON.parse(await readFile(join(root, "probe.json"), "utf8")));


  run("node", [cli, "remove", sourceRoot]);
  const removed = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.equal((removed.packages ?? []).length, 0, "remove must drop the package source");
  step("remove", { packages: 0 });

  console.log(JSON.stringify({ result: "pass", hostVersion, steps,
    scope: "installation, registration, managed write/read and ordinary delegation on the real host loader; zero model calls, no credential access, no publish. Command output is not asserted here." }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
