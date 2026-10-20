import assert from 'node:assert/strict';
import { runVerification } from './verification-process.mjs';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pack, policy, readArchive, prepareSnapshot } from './distribution.mjs';

const source = resolve('.');
const HOST_VERSIONS = ['1.2.0', '1.3.0'];
const args = process.argv.slice(2);
let hostVersion = '1.2.0';
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--host-version' || index + 1 >= args.length) throw new Error('Usage: node scripts/test-package.mjs [--host-version 1.2.0|1.3.0]');
  hostVersion = args[index + 1];
  index += 1;
}
if (!HOST_VERSIONS.includes(hostVersion)) throw new Error(`Unsupported host version: ${hostVersion}; expected ${HOST_VERSIONS.join(' or ')}`);
const root = await mkdtemp(join(tmpdir(), 'auto-memory-package-'));
console.log(`Isolated verification directory: ${root}`);
try {
const home = join(root, 'home');
await mkdir(home);
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root, PI_OFFLINE: '1',
  npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(home, 'empty-npmrc'),
  npm_config_globalconfig: join(home, 'empty-global-npmrc'),
  npm_config_registry: 'https://registry.npmjs.org/', npm_config_audit: 'false', npm_config_fund: 'false',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'empty-gitconfig') };
await writeFile(env.npm_config_userconfig, '');
await writeFile(env.npm_config_globalconfig, '');
await writeFile(env.GIT_CONFIG_GLOBAL, '');
function run(command, args, cwd, extra = {}) {
  return runVerification(command, args, { cwd, env: { ...env, ...extra } });
}
const host = join(root, 'host');
await mkdir(host);
await writeFile(join(host, 'package.json'), '{"private":true,"type":"module"}');
await run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', `@earendil-works/pi-coding-agent@${hostVersion}`], host);
const hostManifest = JSON.parse(await readFile(join(host, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
assert.equal(hostManifest.version, hostVersion, 'Installed host version must match the requested version');
const cli = join(host, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const probe = join(host, 'probe.mjs');
await cp(join(source, 'scripts/package-probe.mjs'), probe);
await cp(join(source, 'scripts/package-dependencies.mjs'), join(host, 'package-dependencies.mjs'));
const artifact = await pack(source, join(root, 'artifacts'));
const p = await policy(source);
const files = readArchive(await readFile(artifact.archive), p.runtime);
const unpacked = join(root, 'unpacked');
await mkdir(unpacked);
for (const [name, bytes] of files) {
  await mkdir(dirname(join(unpacked, name)), { recursive: true });
  await writeFile(join(unpacked, name), bytes, { flag: 'wx' });
}
await run('npm', ['install', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts'], unpacked);
await assert.rejects(realpath(join(unpacked, 'node_modules/@earendil-works/pi-coding-agent')));
async function fixture(label) {
  const cwd = join(root, label, 'project');
  const agentDir = join(root, label, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir);
  return { cwd, agentDir, extra: { PI_CODING_AGENT_DIR: agentDir } };
}
function pi(f, args) { return run(process.execPath, [cli, ...args], f.cwd, f.extra); }
async function check(f, expectation = 'ok') {
  const output = await run(process.execPath, [probe, f.cwd, f.agentDir, expectation, ...(f.dependencyRoot ? [f.dependencyRoot] : [])], f.cwd, { ...f.extra, PI_PROBE_HOST_ROOT: host });
  console.log(output.trim());
}
const local = await fixture('local');
await pi(local, ['install', unpacked]);
const installedSources = JSON.parse(await readFile(join(local.agentDir, 'settings.json'), 'utf8')).packages;
assert.ok(installedSources.some(source => typeof source === 'string' && resolve(local.agentDir, source) === unpacked),
  'Installed local source must resolve from the settings directory to the unpacked package');
await check(local);
await rename(join(unpacked, 'src/core/store.ts'), join(root, 'store.ts.saved'));
await check(local, 'broken');
await rename(join(root, 'store.ts.saved'), join(unpacked, 'src/core/store.ts'));
await rename(join(unpacked, 'node_modules'), join(root, 'dependencies.saved'));
await check(local, 'broken');
await rename(join(root, 'dependencies.saved'), join(unpacked, 'node_modules'));
await pi(local, ['remove', unpacked]);
await check(local, 'removed');

const hoisted = await fixture('npm-layout');
const prefix = join(hoisted.agentDir, 'npm');
await mkdir(prefix);
await writeFile(join(prefix, 'package.json'), '{"private":true}');
await run('npm', ['install', '--prefix', prefix, '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', artifact.archive], hoisted.cwd);
hoisted.dependencyRoot = join(prefix, 'node_modules');
const candidate = join(hoisted.dependencyRoot, '@lanjunyee/pi-auto-memory');
for (const [name, bytes] of files) {
  assert.deepEqual(await readFile(join(candidate, name)), bytes, `Installed candidate differs: ${name}`);
}
await pi(hoisted, ['install', candidate]);
await check(hoisted);
await pi(hoisted, ['remove', candidate]);
await check(hoisted, 'removed');

const gitSource = join(root, 'git-source');
await prepareSnapshot(source, gitSource);
await run('git', ['init', '-b', 'main'], gitSource);
await run('git', ['add', '--', ...p.source], gitSource);
await run('git', ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic package installation fixture'], gitSource);
const git = await fixture('git');
git.extra = { ...git.extra, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${gitSource}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://localhost/synthetic/pi-auto-memory' };
const gitSpec = 'git:localhost/synthetic/pi-auto-memory';
await pi(git, ['install', gitSpec]);
await check(git);
await pi(git, ['remove', gitSpec]);
await check(git, 'removed');
console.log(JSON.stringify({ result: 'pass', host: hostManifest.version, requestedHost: hostVersion, artifactSha256: artifact.sha256,
  cases: ['tarball production-only load', 'local package install/remove', 'missing source rejected', 'missing dependencies rejected', 'candidate tarball npm hoisted layout install/remove with byte comparison', 'Git package install dependencies/remove'],
  modelCalls: 0, cleanup: 'temporary resources removed on exit' }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
