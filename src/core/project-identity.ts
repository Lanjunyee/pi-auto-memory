import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
export type GitCommand = (cwd: string, args: string[]) => Promise<string>;
export interface ProjectIdentity {
  kind: "git" | "cwd";
  identityPath: string;
  projectId: string;
}

const runGit: GitCommand = async (cwd, args) => {
  const env = { ...process.env, LC_ALL: "C" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  const { stdout } = await exec("git", ["-C", cwd, "rev-parse", ...args], {
    env, timeout: 5000, maxBuffer: 64 * 1024,
  });
  return stdout.trim();
};

async function hasGitMarker(cwd: string): Promise<boolean> {
  let current = cwd;
  while (true) {
    try { await lstat(join(current, ".git")); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function identifyProject(cwd: string, git: GitCommand = runGit): Promise<ProjectIdentity> {
  const canonicalCwd = await realpath(cwd);
  let kind: ProjectIdentity["kind"] = "git";
  let identityPath: string;
  let bare: string;
  try { bare = await git(canonicalCwd, ["--is-bare-repository"]); }
  catch (err) {
    const failure = err as { code?: unknown; stderr?: unknown };
    const nonRepo = failure.code === 128 && typeof failure.stderr === "string"
      && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(failure.stderr.trim());
    if (!nonRepo || await hasGitMarker(canonicalCwd)) {
      throw new Error("Memory paused: Git identity resolution failed; repair the repository or Git configuration.");
    }
    kind = "cwd";
    bare = "false";
  }
  if (bare === "true") throw new Error("Memory paused: bare Git repositories are unsupported.");
  if (bare !== "false") throw new Error("Memory paused: unexpected Git identity response.");
  if (kind === "git") {
    try {
      const commonDir = await git(canonicalCwd, ["--path-format=absolute", "--git-common-dir"]);
      if (!commonDir) throw new Error("Missing common-dir");
      identityPath = await realpath(resolve(canonicalCwd, commonDir));
    } catch { throw new Error("Memory paused: Git common-dir resolution failed."); }
  } else identityPath = canonicalCwd;
  const digest = createHash("sha256").update(identityPath).digest("hex");
  return { kind, identityPath, projectId: `${kind}-${digest}` };
}

export async function memoryLocation(cwd: string, agentDir = getAgentDir()) {
  const project = await identifyProject(cwd);
  return {
    project,
    agentDir: resolve(agentDir),
    memoryRoot: join(resolve(agentDir), "memory"),
    projectDir: join(resolve(agentDir), "memory", project.projectId),
    configPath: join(resolve(agentDir), "auto-memory.json"),
  };
}
