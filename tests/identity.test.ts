import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { identifyProject, memoryLocation } from "../src/core/project-identity.js";
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return exec("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}
async function init(cwd: string) {
  await mkdir(cwd, { recursive: true });
  await git(cwd, "init", "-q");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial", "--allow-empty");
}

test("Git common-dir shares worktrees/subdirectories and isolates clone, submodule and nested repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-identity-"));
  try {
    const repo = join(root, "repo");
    await init(repo);
    const main = await identifyProject(repo);
    assert.equal(main.kind, "git");
    assert.equal(main.identityPath, await realpath(join(repo, ".git")));
    await mkdir(join(repo, "sub"));
    assert.deepEqual(await identifyProject(join(repo, "sub")), main);
    const worktree = join(root, "worktree");
    await git(repo, "worktree", "add", "-qb", "worktree-test", worktree);
    await mkdir(join(worktree, "sub"));
    assert.deepEqual(await identifyProject(join(worktree, "sub")), main);
    await git(root, "clone", "-q", repo, join(root, "clone"));
    assert.notEqual((await identifyProject(join(root, "clone"))).projectId, main.projectId);
    await init(join(repo, "nested"));
    assert.notEqual((await identifyProject(join(repo, "nested"))).projectId, main.projectId);
    const source = join(root, "module-source");
    await init(source);
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
    const module = await identifyProject(join(repo, "module"));
    assert.notEqual(module.projectId, main.projectId);
    assert.notEqual(module.projectId, (await identifyProject(source)).projectId);
    await symlink(repo, join(root, "alias"));
    assert.deepEqual(await identifyProject(join(root, "alias", "sub")), main);
    const cloneBeforeMove = await identifyProject(join(root, "clone"));
    await rename(join(root, "clone"), join(root, "moved-clone"));
    assert.notEqual((await identifyProject(join(root, "moved-clone"))).projectId, cloneBeforeMove.projectId);
    const location = await memoryLocation(repo, join(root, "agent"));
    assert.equal(location.projectDir, join(root, "agent", "memory", main.projectId));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "custom-agent");
    try { assert.equal((await memoryLocation(repo)).agentDir, join(root, "custom-agent")); }
    finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-Git cwd is canonical, subdirectories separate; bare and abnormal Git fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-nongit-"));
  try {
    const project = await identifyProject(root);
    assert.equal(project.kind, "cwd");
    await mkdir(join(root, "sub"));
    assert.notEqual((await identifyProject(join(root, "sub"))).projectId, project.projectId);
    await symlink(root, join(root, "alias"));
    assert.deepEqual(await identifyProject(join(root, "alias")), project);
    await git(root, "init", "-q", "--bare", join(root, "bare"));
    await assert.rejects(identifyProject(join(root, "bare")), /bare Git repositories are unsupported/);
    await assert.rejects(identifyProject(root, async () => { throw { code: "ENOENT" }; }), /Git identity resolution failed/);
    await assert.rejects(identifyProject(root, async () => { throw { code: 128, stderr: "fatal: permission denied" }; }), /Git identity resolution failed/);
    await mkdir(join(root, "broken"));
    await writeFile(join(root, "broken", ".git"), "not a valid gitfile");
    await assert.rejects(identifyProject(join(root, "broken")), /Git identity resolution failed/);
    await assert.rejects(identifyProject(root, async () => "unexpected"), /unexpected Git/);
    await assert.rejects(identifyProject(root, async (_cwd, args) => args[0] === "--is-bare-repository" ? "false" : ""), /common-dir resolution failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
