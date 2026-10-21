import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runVerification } from './verification-process.mjs';

export const TEST_FILES = [
  'tests/load.test.ts',
  'tests/host-contract.test.ts',
  'tests/registration.test.ts',
  'tests/lifecycle.test.ts',
  'tests/lifecycle-owner.test.ts',
];

const SUPPORT = [
  'tests/helpers/child.ts',
  'tests/helpers/store.ts',
  'tests/fixtures/config-worker.ts',
  'tests/fixtures/lifecycle-provider.ts',
  'tests/fixtures/store-worker.ts',
];

const FAMILY = ['pi-coding-agent', 'pi-agent-core', 'pi-ai'];

const digest = (value) => createHash('sha256').update(value).digest('hex');

function inside(parent, child) {
  const part = relative(parent, child);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

async function packageJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function exitOf(error) {
  return `${error instanceof Error ? error.message : error}${error && typeof error === 'object' && 'stderr' in error ? `\n${error.stderr}` : ''}${error && typeof error === 'object' && 'stdout' in error ? `\n${error.stdout}` : ''}`;
}

export async function runHostRegression({ source, host, hostVersion }) {
  const hostModules = join(host, 'node_modules');
  const hostRoot = join(hostModules, '@earendil-works', 'pi-coding-agent');
  const installed = await packageJson(join(hostRoot, 'package.json'));
  assert.equal(installed.version, hostVersion, 'Installed host must match the requested version');
  const family = {};
  for (const name of FAMILY) {
    const root = join(hostModules, '@earendil-works', name);
    const manifest = await packageJson(join(root, 'package.json'));
    family[name] = { version: manifest.version, root: await realpath(root) };
  }
  assert.equal(family['pi-coding-agent'].version, hostVersion);
  const expected = new Map();
  for (const path of ['src', ...TEST_FILES, ...SUPPORT]) {
    const absolute = join(source, path);
    if (path === 'src') continue;
    expected.set(path, digest(await readFile(absolute)));
  }
  const copy = join(host, '..', 'regression-copy');
  const regressionHome = join(host, '..', 'regression-home');
  const regressionTmp = join(host, '..', 'regression-tmp');
  await mkdir(regressionHome, { recursive: true });
  await mkdir(regressionTmp, { recursive: true });
  for (const path of ['src', 'tests']) {
    await cp(join(source, path), join(copy, path), { recursive: true });
  }
  await cp(join(source, 'package.json'), join(copy, 'package.json'));
  await cp(join(source, 'tsconfig.json'), join(copy, 'tsconfig.json'));
  const nodeModules = join(copy, 'node_modules');
  await mkdir(nodeModules);
  for (const entry of await import('node:fs/promises').then((fs) => fs.readdir(hostModules))) {
    await import('node:fs/promises').then((fs) => fs.symlink(join(hostModules, entry), join(nodeModules, entry), 'junction'));
  }
  const loader = import.meta.resolve('tsx');
  const tsxRoot = await realpath(dirname(new URL(loader).pathname, 'file:'));
  const tsxSource = join(source, 'node_modules');
  assert.equal(inside(tsxSource, tsxRoot) || inside(await realpath(host), tsxRoot), true, 'tsx loader must come from a verified local toolchain');
  for (const [path, sha] of expected) {
    assert.equal(digest(await readFile(join(copy, path))), sha, `Copied test/source file differs: ${path}`);
  }
  const probeSource = `import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const names = ${JSON.stringify(FAMILY)};
const resolved = {};
for (const name of names) {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/' + name));
  let root = dirname(entry);
  while (true) {
    try { await readFile(join(root, 'package.json')); break; } catch {}
    const parent = dirname(root);
    if (parent === root) throw new Error('package root not found: ' + name);
    root = parent;
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await import(import.meta.resolve('@earendil-works/' + name));
  resolved[name] = { version: manifest.version, root: await realpath(root), entry: await realpath(entry) };
}
process.stdout.write(JSON.stringify({ resolved, cwd: process.cwd() }));
`;
  const probe = join(copy, 'resolve-probe.mjs');
  await writeFile(probe, probeSource);
  let resolved;
  try {
    resolved = JSON.parse((await runVerification(process.execPath, [probe], { cwd: copy })).trim());
  } catch (error) {
    throw new Error(`Host regression resolver probe failed: ${exitOf(error)}`);
  }
  for (const name of FAMILY) {
    assert.equal(resolved.resolved[name].version, family[name].version, `Resolver mixed versions for ${name}`);
    assert.equal(resolved.resolved[name].root, family[name].root, `Resolver fell back to a development tree for ${name}`);
    assert.equal(inside(await realpath(host), resolved.resolved[name].root), true, `Resolver escaped the isolated host for ${name}`);
  }
  const run = await runVerification(process.execPath, ['--import', loader, '--test', ...TEST_FILES], { cwd: copy, timeout: 600_000, env: { PATH: process.env.PATH, HOME: join(host, '..', 'regression-home'),
    TMPDIR: join(host, '..', 'regression-tmp'), PI_OFFLINE: '1', GIT_CONFIG_NOSYSTEM: '1' } });
  const summary = { tests: 0, pass: 0, fail: 0 };
  for (const match of run.matchAll(/^ℹ (tests|pass|fail) (\d+)$/gm)) summary[match[1]] = Number(match[2]);
  assert.equal(summary.fail, 0, 'Host regression reported failing tests');
  assert.ok(summary.tests > 0 && summary.pass === summary.tests, 'Host regression must execute every selected test file');
  return {
    result: 'pass', host: hostVersion, files: TEST_FILES.length, summary,
    dependencies: Object.fromEntries(FAMILY.map((name) => [name, family[name].version])),
    copy: await realpath(copy), modelCalls: 0,
  };
}
