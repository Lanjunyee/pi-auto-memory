import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalProspective, contains, MemoryPaths } from "../src/core/paths.js";
import { atomicReplace } from "../src/core/atomic-file.js";
const projectId = `cwd-${"a".repeat(64)}`;

test("canonical memory boundaries cover relative paths, dot-dot, cross-project and new targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-paths-"));
  try {
    const paths = await MemoryPaths.create(join(root, "agent"), projectId);
    const target = join(paths.projectDir, "nested", "topic.md");
    assert.equal((await paths.classify(target, root)).current, true);
    assert.equal((await paths.classify(`agent/memory/${projectId}/nested/../MEMORY.md`, root)).path, join(paths.projectDir, "MEMORY.md"));
    assert.equal((await paths.classify("agent/memory-like/source.ts", root)).kind, "ordinary");
    assert.equal((await paths.classify("agent/memory/other/topic.md", root)).current, false);
    await assert.rejects(paths.assertCurrent(join(paths.memoryRoot, "other", "topic.md")), /only the current project/);
    assert.equal(contains(paths.memoryRoot, `${paths.memoryRoot}-like`), false);
    await paths.ensurePrivateParent(target);
    assert.equal(await canonicalProspective(target), target);
    await atomicReplace(target, "private", { beforeRename: async () => {
      const { readdir } = await import("node:fs/promises");
      const temp = (await readdir(join(paths.projectDir, "nested"))).find((name) => name.endsWith(".tmp"))!;
      if (process.platform !== "win32") assert.equal((await lstat(join(paths.projectDir, "nested", temp))).mode & 0o777, 0o600);
    } });
    if (process.platform !== "win32") {
      assert.equal((await lstat(target)).mode & 0o777, 0o600);
      for (const dir of [paths.memoryRoot, paths.projectDir, join(paths.projectDir, "nested")]) {
        assert.equal((await lstat(dir)).mode & 0o777, 0o700);
      }
      await chmod(paths.projectDir, 0o755);
      await paths.ensurePrivateParent(target);
      assert.equal((await lstat(paths.projectDir)).mode & 0o777, 0o700);
    }
    await symlink(join(root, "agent"), join(root, "agent-alias"));
    const alias = await MemoryPaths.create(join(root, "agent-alias"), projectId);
    assert.equal(alias.projectDir, paths.projectDir);
    assert.equal((await alias.classify(join(root, "agent-alias", "memory", projectId, "MEMORY.md"), root)).current, true);
    await symlink(paths.projectDir, join(root, "external-alias"));
    assert.equal((await paths.classify(join(root, "external-alias", "topic.md"), root)).current, true);
    assert.equal(await realpath(paths.memoryRoot), paths.memoryRoot);
    const caseRoot = join(paths.agentDir, "MEMORY");
    const caseExists = await lstat(caseRoot).then(() => true, () => false);
    if (caseExists) {
      assert.equal((await paths.classify(join(caseRoot, projectId, "nested", "topic.md"), root)).path, target);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("memory links pointing inside, outside or nowhere are rejected before reading/creating", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-memory-links-"));
  try {
    const paths = await MemoryPaths.create(join(root, "agent"), projectId);
    await paths.ensurePrivateParent(join(paths.projectDir, "MEMORY.md"));
    await writeFile(join(root, "ordinary.txt"), "outside");
    await writeFile(join(paths.projectDir, "real.md"), "inside");
    for (const [name, target] of [["outside", root], ["inside", paths.projectDir], ["dangling", join(root, "missing")]]) {
      await symlink(target, join(paths.projectDir, name));
      await assert.rejects(paths.classify(join(paths.projectDir, name, "new.md"), root), /symbolic links/);
      await assert.rejects(paths.ensurePrivateParent(join(paths.projectDir, name, "new.md")), /symbolic links/);
    }
    await symlink(join(root, "ordinary.txt"), join(paths.projectDir, "file.md"));
    await assert.rejects(paths.classify(join(paths.projectDir, "file.md"), root), /symbolic links/);
    await symlink(join(paths.projectDir, "real.md"), join(paths.projectDir, "internal.md"));
    await symlink(paths.projectDir, join(root, "external-alias"));
    await symlink(join(root, "external-alias"), join(root, "chained-alias"));
    for (const alias of ["external-alias", "chained-alias"]) {
      assert.equal((await paths.classify(join(root, alias, "real.md"), root)).current, true);
      for (const name of ["internal.md", "file.md", "outside/new.md", "inside/new.md", "dangling/new.md"]) {
        await assert.rejects(paths.classify(join(root, alias, name), root), /symbolic links/);
      }
    }
    await symlink(join(paths.projectDir, "outside") + "/../ordinary.txt", join(root, "target-dot-dot"));
    await assert.rejects(paths.classify(join(root, "target-dot-dot"), root), /symbolic links/);
    await assert.rejects(paths.classify(join(paths.projectDir, "real.md", "child"), root), /not a directory/);
    await mkdir(join(root, "other-agent"));
    await symlink(paths.memoryRoot, join(root, "other-agent", "memory"));
    const badRoot = await MemoryPaths.create(join(root, "other-agent"), projectId);
    await assert.rejects(badRoot.classify(join(root, "other-agent", "memory", projectId, "real.md"), root), /symbolic links/);
    assert.equal((await badRoot.classify(join(root, "ordinary.txt"), root)).kind, "ordinary");
    if (await lstat(join(root, "agent", "MEMORY")).then(() => true, () => false)) {
      const caseProject = join(root, "agent", "MEMORY", projectId);
      await assert.rejects(paths.classify(join(caseProject, "file.md"), root), /symbolic links/);
      await assert.rejects(badRoot.classify(join(root, "other-agent", "MEMORY", projectId, "real.md"), root), /symbolic links/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
