import assert from 'node:assert/strict';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

export function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail(`Host copy forbidden: ${path}`);
}
export async function checkDependencies(packagePath, agentDir, explicitRoot) {
  const packageRoot = await realpath(packagePath);
  let dependencyRoot;
  if (explicitRoot) {
    const agent = await realpath(agentDir);
    const prefixRoot = join(agent, 'npm', 'node_modules');
    dependencyRoot = await realpath(explicitRoot);
    assert.equal(resolve(explicitRoot), join(resolve(agentDir), 'npm', 'node_modules'), 'Explicit dependency root must be agent npm prefix');
    assert.equal(dependencyRoot, prefixRoot, 'Canonical dependency root must remain in agent npm prefix');
    assert.equal(packageRoot, join(dependencyRoot, '@lanjunyee', 'pi-auto-memory'), 'Candidate must belong to this npm prefix');
  } else {
    dependencyRoot = await realpath(join(packageRoot, 'node_modules'));
    assert.ok(within(packageRoot, dependencyRoot), 'Private dependency root escaped package');
  }
  const host = '@earendil-works/pi-coding-agent';
  await absent(join(packageRoot, 'node_modules', host));
  await absent(join(dependencyRoot, host));
  const req = createRequire(join(packageRoot, 'package.json'));
  let resolvedHost;
  try { resolvedHost = req.resolve(host); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  assert.equal(resolvedHost, undefined, 'Resolvable ancestor host copy forbidden');
  const visited = new Set();
  async function visit(owner, dependency) {
    assert.notEqual(dependency, host, 'Host must not be a production dependency');
    const entry = await realpath(owner.resolve(dependency));
    assert.ok(within(dependencyRoot, entry), `Dependency outside isolated root: ${dependency}`);
    let directory = dirname(entry), manifest, manifestPath;
    while (within(dependencyRoot, directory)) {
      const candidate = join(directory, 'package.json');
      try {
        const canonical = await realpath(candidate);
        assert.ok(within(dependencyRoot, canonical), 'Dependency manifest escaped isolated root');
        const data = JSON.parse(await readFile(canonical, 'utf8'));
        if (data.name === dependency) { manifest = data; manifestPath = canonical; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = dirname(directory);
    }
    assert.ok(manifestPath, `Missing owning manifest: ${dependency}`);
    if (visited.has(manifestPath)) return;
    visited.add(manifestPath);
    const child = createRequire(manifestPath);
    for (const name of Object.keys(manifest.dependencies || {})) await visit(child, name);
  }
  for (const dependency of ['yaml', 'proper-lockfile']) await visit(req, dependency);
  return { packageRoot, dependencyRoot };
}
