import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkDependencies, within } from '../scripts/package-dependencies.mjs';

async function module(root, name, dependencies = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js', dependencies }));
  await writeFile(join(dir, 'index.js'), 'module.exports = {};');
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dependency-boundary-'));
  try {
    const agent = join(root, 'agent');
    const prefix = join(agent, 'npm/node_modules');
    const pkg = join(prefix, '@lanjunyee/pi-auto-memory');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'package.json'), '{"name":"@lanjunyee/pi-auto-memory"}');
    await run({ root, agent, prefix, pkg });
  } finally { await rm(root, { recursive: true, force: true }); }
}
for (const hoisted of [false, true]) test(`accepts isolated ${hoisted ? 'hoisted' : 'private'} dependencies`, () => fixture(async f => {
  const deps = hoisted ? f.prefix : join(f.pkg, 'node_modules');
  for (const name of ['yaml', 'proper-lockfile']) await module(deps, name);
  await checkDependencies(f.pkg, f.agent, hoisted ? f.prefix : undefined);
}));
test('accepts recursive production dependencies and cycles', () => fixture(async f => {
  await module(f.prefix, 'yaml');
  await module(f.prefix, 'proper-lockfile', { retry: '*' });
  await module(join(f.prefix, 'proper-lockfile/node_modules'), 'retry', { 'proper-lockfile': '*' });
  await checkDependencies(f.pkg, f.agent, f.prefix);
}));
for (const kind of ['missing', 'ancestor', 'symlink escape']) {
  test(`rejects ${kind} transitive dependency`, () => fixture(async f => {
    await module(f.prefix, 'yaml');
    await module(f.prefix, 'proper-lockfile', { 'synthetic-transitive': '*' });
    if (kind !== 'missing') {
      const outside = join(f.root, 'node_modules');
      await module(outside, 'synthetic-transitive');
      if (kind === 'symlink escape') await symlink(join(outside, 'synthetic-transitive'), join(f.prefix, 'synthetic-transitive'));
    }
    await assert.rejects(checkDependencies(f.pkg, f.agent, f.prefix));
  }));
}
test('component containment rejects similar prefixes', () => {
  assert.equal(within('/isolated/node_modules', '/isolated/node_modules-other/yaml'), false);
  assert.equal(within('/isolated/node_modules', '/isolated/node_modules/yaml'), true);
});
for (const kind of ['wrong root', 'wrong package', 'similar prefix', 'canonical escape', 'root symlink', 'missing dependency', 'local host', 'prefix host', 'ancestor host']) {
  test(`rejects ${kind}`, () => fixture(async f => {
    for (const name of ['yaml', 'proper-lockfile']) await module(f.prefix, name);
    let pkg = f.pkg, deps = f.prefix;
    if (kind === 'wrong root') deps = join(f.root, 'other');
    if (kind === 'wrong package') { pkg = join(f.root, 'other-package'); await mkdir(pkg); }
    if (kind === 'similar prefix' || kind === 'canonical escape') {
      const outside = kind === 'similar prefix' ? f.prefix + '-other' : join(f.root, 'outside');
      await module(outside, 'yaml');
      await rm(join(f.prefix, 'yaml'), { recursive: true });
      await symlink(join(outside, 'yaml'), join(f.prefix, 'yaml'));
    }
    if (kind === 'root symlink') {
      const outside = join(f.root, 'outside');
      await mkdir(outside);
      await rm(join(f.prefix, 'yaml'), { recursive: true });
      await rm(join(f.prefix, 'proper-lockfile'), { recursive: true });
      const { rename } = await import('node:fs/promises');
      await rename(f.prefix, join(outside, 'node_modules'));
      await symlink(join(outside, 'node_modules'), f.prefix);
    }
    if (kind === 'missing dependency') await rm(join(f.prefix, 'yaml'), { recursive: true });
    if (kind === 'local host') await module(join(pkg, 'node_modules'), '@earendil-works/pi-coding-agent');
    if (kind === 'prefix host') await module(f.prefix, '@earendil-works/pi-coding-agent');
    if (kind === 'ancestor host') await module(join(f.root, 'node_modules'), '@earendil-works/pi-coding-agent');
    if (kind === 'wrong root') await mkdir(deps);
    await assert.rejects(checkDependencies(pkg, f.agent, deps));
  }));
}
