import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { checkDependencies } from './package-dependencies.mjs';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const [cwd, agentDir, expected = 'ok', dependencyRoot] = process.argv.slice(2);
const settingsManager = SettingsManager.create(cwd, agentDir);
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
const loaded = loader.getExtensions();
if (expected === 'broken') {
  assert.ok(loaded.errors.length > 0 || loaded.extensions.length === 0, 'Missing production file/dependency must fail loading');
  console.log(JSON.stringify({ negative: 'load rejected', errors: loaded.errors.length }));
} else if (expected === 'removed') {
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 0);
  const remembered = join(agentDir, 'memory', 'cwd-' + createHash('sha256').update(await realpath(cwd)).digest('hex'), 'package-test.md');
  assert.match(await readFile(remembered, 'utf8'), /synthetic package memory/);
  console.log(JSON.stringify({ uninstall: 'reference removed, memory retained' }));
} else {
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.commands.has('memory'), true);
  const packageRoot = join(extension.resolvedPath, '..', '..');
  await checkDependencies(packageRoot, agentDir, dependencyRoot);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'models-cache.json'), refreshOnCreate: false });
  let calls = 0;
  runtime.streamSimple = () => { calls++; throw new Error('Model calls forbidden'); };
  const { session } = await createAgentSession({ cwd, agentDir, tools: ['read', 'write', 'edit'],
    settingsManager, modelRuntime: runtime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
  try {
    await session.bindExtensions({});
    await session.prompt('/memory status');
    const call = (name, params) => session.getToolDefinition(name).execute('package-test', params, undefined, undefined, { cwd });
    await call('write', { path: join(cwd, 'ordinary.txt'), content: 'ordinary file' });
    assert.match(JSON.stringify((await call('read', { path: join(cwd, 'ordinary.txt') })).content), /ordinary file/);
    await call('edit', { path: join(cwd, 'ordinary.txt'), edits: [{ oldText: 'ordinary', newText: 'changed' }] });
    const projectId = 'cwd-' + createHash('sha256').update(await realpath(cwd)).digest('hex');
    const path = join(agentDir, 'memory', projectId, 'package-test.md');
    await session.prompt('/memory on');
    await call('write', { path, content: '---\ntype: feedback\n---\nsynthetic package memory' });
    const before = await readFile(path);
    await session.prompt('/memory off');
    await assert.rejects(call('write', { path, content: 'must not save' }), /Memory is off/);
    await assert.rejects(call('read', { path }), /Memory is off/);
    assert.deepEqual(await readFile(path), before);
    await call('write', { path: join(cwd, 'off-ordinary.txt'), content: 'allowed' });
    assert.equal(calls, 0);
    console.log(JSON.stringify({ loaded: 1, command: 'memory', tools: 'ordinary read/write/edit, memory write/off', modelCalls: calls, packageRoot }));
  } finally { session.dispose(); }
}
