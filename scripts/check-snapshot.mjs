import assert from 'node:assert/strict';
import { runVerification } from './verification-process.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareSnapshot, inspectSnapshot } from './distribution.mjs';

const HOST_VERSIONS = ['1.2.0', '1.3.0'];
const args = process.argv.slice(2);
let hostVersion;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--host-version' || index + 1 >= args.length) throw new Error('Usage: node scripts/check-snapshot.mjs [--host-version 1.2.0|1.3.0]');
  hostVersion = args[index + 1];
  index += 1;
}
if (hostVersion !== undefined && !HOST_VERSIONS.includes(hostVersion)) throw new Error(`Unsupported host version: ${hostVersion}; expected ${HOST_VERSIONS.join(' or ')}`);
const root = await mkdtemp(join(tmpdir(), 'auto-memory-public-check-'));
try {
  const source = resolve('.');
  const output = join(root, 'public');
  const fingerprint = await prepareSnapshot(source, output);
  const home = join(root, 'home');
  await mkdir(home);
  const userconfig = join(home, 'user.npmrc'), globalconfig = join(home, 'global.npmrc');
  await writeFile(userconfig, '');
  await writeFile(globalconfig, '');
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root,
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_cache: join(root, 'cache'), npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_audit: 'false', npm_config_fund: 'false', PI_OFFLINE: '1' };
  for (const command of [['ci', '--ignore-scripts'], ['run', 'check'], ['run', 'test:package', ...(hostVersion ? ['--', '--host-version', hostVersion] : [])]]) {
    console.log(`Public snapshot: npm ${command.join(' ')}`);
    console.log(await runVerification('npm', command, { cwd: output, env, timeout: 900000 }));
  }
  await rm(join(output, 'node_modules'), { recursive: true, force: true });
  assert.deepEqual(await inspectSnapshot(output, source), fingerprint);
  console.log(JSON.stringify({ publicSnapshot: 'pass', hostVersion: hostVersion ?? '1.2.0', node: process.version, platform: process.platform, ...fingerprint }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
