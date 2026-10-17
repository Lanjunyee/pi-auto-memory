import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, rm, writeFile, readFile, realpath, symlink, mkdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import { pack, readArchive, prepareSnapshot, inspectSnapshot, regularFile, sha256, safePath } from '../scripts/distribution.mjs';

for (const path of ['../secret', '/etc/passwd', 'src/../secret', 'C:/secret', 'src\\file', './index', 'src//file', 'a\nfile']) {
  test(`unsafe distribution path rejected: ${JSON.stringify(path)}`, () => assert.throws(() => safePath(path)));
}
test('real npm archive matches exact runtime allowlist and rejects malformed entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-memory-pack-test-'));
  try {
    const result = await pack(resolve('.'), join(root, 'pack'));
    const bytes = await readFile(result.archive);
    const policy = JSON.parse(await readFile('distribution-files.json', 'utf8'));
    assert.equal(result.sha256, sha256(bytes));
    const files = readArchive(bytes, policy.runtime);
    assert.ok(files.has('src/index.ts'));
    assert.throws(() => readArchive(bytes, [...policy.runtime, 'missing.ts']));
    assert.throws(() => readArchive(bytes, policy.runtime.filter(x => x !== 'src/index.ts')));
    function mutate(fn) {
      const tar = Buffer.from(gunzipSync(bytes));
      fn(tar);
      tar.fill(32, 148, 156);
      const sum = tar.subarray(0, 512).reduce((a, b) => a + b, 0);
      tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
      return gzipSync(tar);
    }
    for (const name of ['package/../private', '/private', 'package/.pi/auth.json', 'package/openspec/internal.md', 'package/unapproved']) {
      assert.throws(() => readArchive(mutate(t => { t.fill(0, 0, 100); t.write(name, 0); }), policy.runtime));
    }
    for (const type of ['1', '2', '5', 'x', 'g']) assert.throws(() => readArchive(mutate(t => { t[156] = type.charCodeAt(0); }), policy.runtime));
    assert.throws(() => readArchive(gzipSync(gunzipSync(bytes).subarray(0, 600)), policy.runtime));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('source snapshot is complete, byte-identical, history-free, and rejects additions or links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-memory-snapshot-test-'));
  const output = join(root, 'public');
  try {
    const result = await prepareSnapshot(resolve('.'), output);
    assert.ok(result.files['tests/load.test.ts']);
    assert.ok(!Object.keys(result.files).some(x => /^(\.git|\.pi|openspec)\//.test(x)));
    assert.deepEqual(Object.keys(result.files).filter(x => x.startsWith('docs/')).sort(), ['docs/isolated-install-verification.md', 'docs/release-trial.md']);
    assert.deepEqual(await inspectSnapshot(output, resolve('.')), result);
    await writeFile(join(output, 'unapproved'), 'private');
    await assert.rejects(inspectSnapshot(output, resolve('.')));
    await unlink(join(output, 'unapproved'));
    await unlink(join(output, 'src/index.ts'));
    await assert.rejects(inspectSnapshot(output, resolve('.')));
    await symlink(resolve('src/index.ts'), join(output, 'src/index.ts'));
    await assert.rejects(inspectSnapshot(output, resolve('.')));
    await assert.rejects(prepareSnapshot(resolve('.'), output));
    for (const name of ['nested-public', '..public']) {
      await assert.rejects(prepareSnapshot(output, join(output, name)), /outside source root/);
      await assert.rejects(access(join(output, name)), { code: 'ENOENT' });
    }
    const linked = join(root, 'link');
    await symlink(resolve('src'), linked);
    await assert.rejects(regularFile(root, 'link/index.ts'));
    await mkdir(join(root, 'directory'));
    await assert.rejects(regularFile(root, 'directory'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('pack isolates npm user/global configuration and injected Node/provider environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-memory-pack-isolation-'));
  const keys = ['PATH', 'HOME', 'NODE_OPTIONS', 'NODE_PATH', 'PACK_TEST_PROVIDER_TOKEN', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    let realNpm;
    for (const directory of previous.PATH.split(delimiter)) {
      const candidate = join(directory, 'npm');
      if (await access(candidate, constants.X_OK).then(() => true, () => false)) { realNpm = await realpath(candidate); break; }
    }
    assert.ok(realNpm, 'npm executable required');
    const bin = join(root, 'bin');
    const userHome = join(root, 'caller-home');
    await mkdir(bin);
    await mkdir(userHome);
    const marker = join(root, 'injected-node-options-ran');
    const preload = join(root, 'sentinel.cjs');
    const captured = join(root, 'captured.json');
    await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'inherited');`);
    const userconfig = join(userHome, '.npmrc');
    const globalconfig = join(root, 'caller-global.npmrc');
    await writeFile(userconfig, '# SYNTHETIC caller configuration\n');
    await writeFile(globalconfig, '# SYNTHETIC global configuration\n');
    const wrapper = join(bin, 'npm');
    await writeFile(wrapper, `#!${process.execPath}\n` +
      `const fs=require('node:fs'); const e=process.env;\n` +
      `fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({home:e.HOME, nodeOptions:e.NODE_OPTIONS, nodePath:e.NODE_PATH, provider:e.PACK_TEST_PROVIDER_TOKEN, userconfig:e.npm_config_userconfig, globalconfig:e.npm_config_globalconfig, cache:e.npm_config_cache, userText:fs.readFileSync(e.npm_config_userconfig,'utf8'), globalText:fs.readFileSync(e.npm_config_globalconfig,'utf8')}));\n` +
      `const r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(realNpm)},...process.argv.slice(2)],{env:e,stdio:'inherit'}); if(r.error)throw r.error;process.exit(r.status??1);\n`);
    await chmod(wrapper, 0o700);
    Object.assign(process.env, { PATH: bin + delimiter + previous.PATH, HOME: userHome,
      NODE_OPTIONS: `--require=${preload}`, NODE_PATH: join(root, 'caller-node-modules'),
      PACK_TEST_PROVIDER_TOKEN: 'SYNTHETIC_NOT_A_TOKEN', npm_config_userconfig: userconfig,
      npm_config_globalconfig: globalconfig, npm_config_cache: join(root, 'caller-cache') });
    await pack(resolve('.'), join(root, 'pack'));
    const seen = JSON.parse(await readFile(captured, 'utf8'));
    assert.notEqual(seen.home, userHome);
    assert.notEqual(seen.userconfig, userconfig);
    assert.notEqual(seen.globalconfig, globalconfig);
    assert.notEqual(seen.cache, process.env.npm_config_cache);
    assert.equal(seen.userText, '');
    assert.equal(seen.globalText, '');
    for (const key of ['nodeOptions', 'nodePath', 'provider']) assert.equal(seen[key], undefined);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await assert.rejects(access(seen.home), { code: 'ENOENT' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
