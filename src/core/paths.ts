import { chmod, lstat, mkdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function canonicalProspective(path: string, protectedRoots: readonly string[] = []): Promise<string> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  let pending = absolute.slice(current.length).split(sep).filter(Boolean);
  let links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const candidate = join(current, part);
    let info;
    try { info = await lstat(candidate); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      current = candidate;
      continue;
    }
    if (info.isSymbolicLink()) {
      let protectedLink = protectedRoots.some((root) => contains(root, candidate));
      for (const root of protectedRoots) {
        if (protectedLink || dirname(root) !== current) continue;
        try {
          const rootInfo = await lstat(root);
          protectedLink = rootInfo.dev === info.dev && rootInfo.ino === info.ino;
        } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      }
      if (protectedLink) throw new Error("Memory path rejected: symbolic links in the memory tree are unsupported.");
      if (++links > 40) throw new Error("Path alias resolution failed: too many symbolic links.");
      const target = await readlink(candidate);
      if (isAbsolute(target)) current = parse(target).root;
      pending = [...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(sep).filter(Boolean), ...pending];
    } else {
      if (pending.length && !info.isDirectory()) {
        if (protectedRoots.some((root) => contains(root, candidate))) throw new Error("Memory path rejected: parent is not a directory.");
        return resolve(candidate, ...pending);
      }
      current = await realpath(candidate);
    }
  }
  return current;
}

async function rejectLinks(root: string, path: string): Promise<void> {
  if (!contains(root, path)) return;
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) current = join(current, parts[i - 1]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Memory path rejected: symbolic links in the memory tree are unsupported.");
      if (i < parts.length && !info.isDirectory()) throw new Error("Memory path rejected: parent is not a directory.");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}

export class MemoryPaths {
  readonly memoryRoot: string;
  readonly projectDir: string;
  private constructor(readonly agentDir: string, readonly lexicalRoot: string, projectId: string) {
    this.memoryRoot = join(agentDir, "memory");
    this.projectDir = join(this.memoryRoot, projectId);
  }

  static async create(agentDir: string, projectId: string): Promise<MemoryPaths> {
    if (!/^(git|cwd)-[a-f0-9]{64}$/.test(projectId)) throw new Error("Invalid memory project identity.");
    return new MemoryPaths(await canonicalProspective(agentDir), join(resolve(agentDir), "memory"), projectId);
  }

  async classify(requested: string, cwd: string): Promise<{ kind: "ordinary" | "memory"; path: string; current: boolean }> {
    const absolute = resolve(cwd, requested);
    await rejectLinks(this.lexicalRoot, absolute);
    await rejectLinks(this.memoryRoot, absolute);
    const canonical = await canonicalProspective(absolute, [this.lexicalRoot, this.memoryRoot]);
    const managed = contains(this.memoryRoot, canonical) || contains(this.lexicalRoot, absolute);
    if (managed) await rejectLinks(this.memoryRoot, canonical);
    return { kind: managed ? "memory" : "ordinary", path: canonical, current: managed && contains(this.projectDir, canonical) };
  }

  async assertCurrent(path: string): Promise<string> {
    const result = await this.classify(path, this.agentDir);
    if (result.kind !== "memory" || !result.current) throw new Error("Memory path rejected: only the current project is supported.");
    return result.path;
  }

  async ensurePrivateParent(path: string): Promise<void> {
    const target = await this.assertCurrent(path);
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    const dirs = [this.memoryRoot];
    const parts = relative(this.memoryRoot, dirname(target)).split(sep).filter(Boolean);
    for (const part of parts) dirs.push(join(dirs[dirs.length - 1], part));
    for (const dir of dirs) {
      await rejectLinks(this.memoryRoot, dir);
      await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      await rejectLinks(this.memoryRoot, dir);
      if (!(await lstat(dir)).isDirectory()) throw new Error("Memory parent is not a directory.");
      if (process.platform !== "win32") await chmod(dir, 0o700);
    }
    await this.assertCurrent(target);
  }
}
