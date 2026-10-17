import assert from 'node:assert/strict';
import { runVerification } from './verification-process.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareSnapshot, inspectSnapshot } from './distribution.mjs';

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
  for (const args of [['ci', '--ignore-scripts'], ['run', 'check'], ['run', 'test:package']]) {
    console.log(`Public snapshot: npm ${args.join(' ')}`);
    console.log(await runVerification('npm', args, { cwd: output, env, timeout: 900000 }));
  }
  await rm(join(output, 'node_modules'), { recursive: true, force: true });
  assert.deepEqual(await inspectSnapshot(output, source), fingerprint);
  console.log(JSON.stringify({ publicSnapshot: 'pass', node: process.version, platform: process.platform, ...fingerprint }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
