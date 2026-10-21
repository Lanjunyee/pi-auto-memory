import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkDependencies } from './package-dependencies.mjs';

const [cwd, agentDir, expected = 'ok', dependencyRoot] = process.argv.slice(2);
const hostRoot = process.env.PI_PROBE_HOST_ROOT;
if (!hostRoot) throw new Error('PI_PROBE_HOST_ROOT is required');
const hostEntry = join(hostRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
const host = await import(pathToFileURL(hostEntry).href);
const installedHost = JSON.parse(await readFile(join(hostRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
const settingsManager = host.SettingsManager.create(cwd, agentDir);
const loader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager,
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
const loaded = loader.getExtensions();
if (expected === 'broken') {
  assert.ok(loaded.errors.length > 0 || loaded.extensions.length === 0, 'Missing production file/dependency must fail loading');
  console.log(JSON.stringify({ negative: 'load rejected', errors: loaded.errors.length, host: installedHost.version }));
} else if (expected === 'removed') {
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 0);
  const remembered = join(agentDir, 'memory', 'cwd-' + createHash('sha256').update(await realpath(cwd)).digest('hex'), 'package-test.md');
  assert.match(await readFile(remembered, 'utf8'), /synthetic package memory/);
  console.log(JSON.stringify({ uninstall: 'reference removed, memory retained', host: installedHost.version }));
} else {
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.commands.has('memory'), true);
  const packageRoot = join(extension.resolvedPath, '..', '..');
  await checkDependencies(packageRoot, agentDir, dependencyRoot);
  const runtime = await host.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'models-cache.json'), refreshOnCreate: false });
  let calls = 0;
  runtime.streamSimple = () => { calls++; throw new Error('Model calls forbidden'); };
  const { session } = await host.createAgentSession({ cwd, agentDir, tools: ['read', 'write', 'edit'],
    settingsManager, modelRuntime: runtime, resourceLoader: loader, sessionManager: host.SessionManager.inMemory(cwd) });
  try {
    await session.bindExtensions({});
    await session.prompt('/memory status');
    const call = (name, params) => session.getToolDefinition(name).execute('package-test', params, undefined, undefined, { cwd });
    await call('write', { path: join(cwd, 'ordinary.txt'), content: 'ordinary file' });
    assert.match(JSON.stringify((await call('read', { path: join(cwd, 'ordinary.txt') })).content), /ordinary file/);
    await call('edit', { path: join(cwd, 'ordinary.txt'), edits: [{ oldText: 'ordinary', newText: 'changed' }] });
    const projectId = 'cwd-' + createHash('sha256').update(await realpath(cwd)).digest('hex');
    const memoryDir = join(agentDir, 'memory', projectId);
    const path = join(memoryDir, 'package-test.md');
    await session.prompt('/memory on');
    await call('write', { path, content: '---\ntype: feedback\n---\nsynthetic package memory' });
    const before = await readFile(path);
    await session.prompt('/memory off');
    await assert.rejects(call('write', { path, content: 'must not save' }), /Memory is off/);
    await assert.rejects(call('read', { path }), /Memory is off/);
    assert.deepEqual(await readFile(path), before);
    await call('write', { path: join(cwd, 'off-ordinary.txt'), content: 'allowed' });
    assert.equal(calls, 0);

    await session.prompt('/memory on');
    const probeIndex = join(memoryDir, 'MEMORY.md');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(probeIndex, '# Memory\n\n- [probe](package-test.md): initial probe snapshot\n- [broken](missing-topic.md): broken entry\n- [probe again](package-test.md): duplicate entry\n');
    const check = await commandText(session, '/memory check package-test.md');
    assert.match(check, /记忆关联检查/);
    assert.match(check, /缺失：missing-topic\.md/);
    assert.match(check, /重复：package-test\.md/);
    assert.match(check, /主题：package-test\.md；存在/);
    const review = await commandText(session, '/memory review package-test.md');
    assert.match(review, /记忆审阅需要交互式查看与动作选择/);
    assert.equal(await readFile(path, 'utf8').then((text) => text.includes('synthetic package memory')), true);
    const reviewBody = await readFile(path, 'utf8');
    const notifications = [];
    const reviewUi = {
      select: async (title, options) => title.startsWith('记忆审阅：选择一个主题') ? 'package-test.md' : '保留',
      editor: async (title, prefill) => { reviewUi.shown = { title, prefill }; return prefill; },
      confirm: async () => false,
      input: async () => undefined,
      notify: (text) => notifications.push(text),
      setStatus: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      setWorkingVisible: () => {},
      setWorkingMessage: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => '',
      addAutocompleteProvider: () => {},
      get theme() { return {}; },
    };
    await session.bindExtensions({ uiContext: reviewUi, mode: 'tui' });
    session.extensionRunner.setUIContext?.(reviewUi, 'tui');
    await session.prompt('/memory review package-test.md');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(reviewUi.shown, 'interactive review must display the selected topic');
    assert.match(reviewUi.shown.prefill, /synthetic package memory/);
    const reviewText = notifications.join('\n');
    assert.match(reviewText, /记忆审阅/);
    assert.match(reviewText, /修改时间/);
    assert.match(reviewText, /已保留该主题/);
    assert.equal(await readFile(path, 'utf8'), reviewBody, 'cancelling review must not change the topic');
    for (const boundaryIndex of ['line\n'.repeat(200) + '[probe](package-test.md)', 'x'.repeat(25 * 1024) + ' [probe](package-test.md)']) {
      await writeFile(probeIndex, boundaryIndex);
      notifications.length = 0;
      await session.prompt('/memory check package-test.md');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(notifications.join('\n'), /加载范围外|加载范围之外/);
      assert.match(notifications.join('\n'), /磁盘/);
      notifications.length = 0;
      await session.prompt('/memory review package-test.md');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(notifications.join('\n'), /加载范围外/);
      assert.equal(await readFile(probeIndex, 'utf8'), boundaryIndex);
      assert.equal(await readFile(path, 'utf8'), reviewBody);
    }
    await writeFile(probeIndex, '# Memory\n\n- [probe](package-test.md): initial probe snapshot\n');
    await session.bindExtensions({ uiContext: null, mode: 'print' });
    assert.equal(calls, 0);
    const statusBeforeProject = await commandText(session, '/memory status');
    assert.match(statusBeforeProject, /全局开关/);
    assert.match(statusBeforeProject, /项目设置/);
    await session.prompt('/memory project off');
    await assert.rejects(call('read', { path }), /Memory is off/);
    await assert.rejects(call('write', { path, content: 'must not save while disabled' }), /Memory is off/);
    await call('write', { path: join(cwd, 'disabled-ordinary.txt'), content: 'still allowed' });
    assert.match(JSON.stringify((await call('read', { path: join(cwd, 'disabled-ordinary.txt') })).content), /still allowed/);
    await session.prompt('/memory project inherit');
    assert.match(JSON.stringify((await call('read', { path })).content), /synthetic package memory/);
    await session.prompt('/memory off');
    await session.prompt('/memory project inherit');
    await assert.rejects(call('read', { path }), /Memory is off/);
    await session.prompt('/memory on');
    assert.equal(await readFile(path, 'utf8').then((text) => text.includes('synthetic package memory')), true);
    const runner = session.extensionRunner;
    const options = () => ({ cwd, sections: { foreign: 'keep' }, selectedTools: ['read', 'write', 'edit'] });
    const first = await runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'probe projection' }, options());
    assert.match(first.systemPromptOptions.sections.auto_memory ?? '', /initial probe snapshot/);
    const projected = await runner.emitContext([{ role: 'system', content: '', sections: {}, timestamp: 1 },
      { role: 'user', content: 'probe projection', timestamp: 2 }]);
    assert.match(JSON.stringify(projected), /initial probe snapshot/);
    await writeFile(probeIndex, '# Memory\n\n- [probe](package-test.md): refreshed probe snapshot\n');
    const same = await runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'probe same snapshot' }, options());
    assert.match(same.systemPromptOptions.sections.auto_memory ?? '', /initial probe snapshot/);
    await runner.emit({ type: 'session_start', reason: 'reload' });
    const refreshed = await runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'probe refreshed snapshot' }, options());
    assert.match(refreshed.systemPromptOptions.sections.auto_memory ?? '', /refreshed probe snapshot/);
    await session.prompt('/memory off');
    const conflicting = await host.createAgentSession({ cwd, agentDir, tools: ['read', 'write', 'edit'], modelRuntime: runtime,
      resourceLoader: loader, settingsManager, sessionManager: host.SessionManager.inMemory(cwd),
      customTools: [{ ...session.getToolDefinition('write'), name: 'write',
        execute: async () => ({ content: [{ type: 'text', text: 'override' }] }) }] });
    try {
      await conflicting.session.bindExtensions({});
      const paused = await conflicting.session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'probe conflict' }, options());
      assert.equal(paused.systemPromptOptions.sections.auto_memory, undefined);
      const status = await commandText(conflicting.session, '/memory status');
      assert.match(status, /工具兼容冲突|兼容暂停/i);
    } finally { conflicting.session.dispose(); }
    console.log(JSON.stringify({ loaded: 1, command: 'memory', tools: 'ordinary read/write/edit, memory write/off',
      projection: 'initial snapshot projected', snapshotReuse: 'same snapshot on later task', reload: 'fresh snapshot only',
      conflict: 'projection withdrawn', modelCalls: calls, syntheticRequests: 0, packageRoot, host: installedHost.version }));
  } finally { session.dispose(); }
}

async function commandText(session, command) {
  const seen = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_end' && event.message?.role === 'custom') seen.push(String(event.message.content));
  });
  await session.prompt(command);
  unsubscribe();
  return seen.join('\n');
}

function emitProbeText(stream, model, text) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const block = { type: 'text', text };
  const partial = { role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider,
    model: model.id, usage, stopReason: 'pending', timestamp: Date.now() };
  stream.push({ type: 'start', partial: { ...partial, content: [] } });
  stream.push({ type: 'text_start', contentIndex: 0, partial });
  partial.content = [block];
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial });
  const final = { ...partial, stopReason: 'stop' };
  stream.push({ type: 'done', reason: 'stop', message: final });
  stream.end(final);
}

function probeModel() {
  return { id: 'probe-model', name: 'probe-model', api: 'probe', provider: 'probe', baseUrl: 'probe://local',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000, maxTokens: 4096, thinkingLevelMap: { off: 'off' } };
}
