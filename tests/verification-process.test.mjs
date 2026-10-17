import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runVerification } from '../scripts/verification-process.mjs';

for (const mode of ['success', 'failure', 'timeout']) test(`verification ${mode} terminates descendants before caller cleanup`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'verification-process-'));
  let pid;
  try {
    const marker = join(root, 'pid');
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
    const code = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});` +
      `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);${mode === 'timeout' ? 'setInterval(()=>{},1000);' : `process.exit(${mode === 'success' ? 0 : 7});`}}},10);`;
    const execution = runVerification(process.execPath, ['-e', code], { cwd: root, env: { PATH: process.env.PATH }, timeout: 1500 });
    if (mode === 'success') await execution;
    else await assert.rejects(execution, mode === 'timeout' ? /timed out/ : /failed \(7\)/);
    pid = Number(await readFile(marker, 'utf8'));
    let running = true;
    for (let i = 0; i < 100; i++) {
      try {
        const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        running = !!stat && !stat.startsWith('Z');
      } catch { running = false; }
      if (!running) break;
      await delay(20);
    }
    assert.equal(running, false, 'Descendant must not remain running');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
test('timeout kills TERM-resistant descendants through an npm-like wrapper and nested groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verification-nested-'));
  let pid;
  try {
    const marker = join(root, 'pid');
    const helper = new URL('../scripts/verification-process.mjs', import.meta.url).href;
    const leaf = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
    const owner = `import { runVerification } from ${JSON.stringify(helper)};await runVerification(process.execPath,['-e',${JSON.stringify(leaf)}],{env:{PATH:process.env.PATH},timeout:30000});`;
    const wrapper = `process.on('SIGTERM',()=>process.exit(0));require('node:child_process').spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(owner)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
    await assert.rejects(runVerification(process.execPath, ['-e', wrapper], { env: { PATH: process.env.PATH }, timeout: 2500 }), /timed out/);
    pid = Number(await readFile(marker, 'utf8'));
    let status;
    try { status = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { status = ''; }
    assert.ok(!status || status.startsWith('Z'), 'Nested detached descendant must not remain running');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
for (const live of [false, true]) test(`darwin PID EPERM preserves cleanup failure only for a live process: ${live}`, { skip: process.platform !== 'darwin' }, async () => {
  const helper = new URL('../scripts/verification-process.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { runVerification } from ${JSON.stringify(helper)};
    const kill = process.kill.bind(process);
    let injected = false;
    process.kill = (pid, signal) => {
      if (pid > 0 && signal === 'SIGKILL' && !injected) {
        injected = true;
        if (!${live}) {
          kill(pid, signal);
          for (let attempt = 0; ; attempt++) {
            let state;
            try { state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { state = ''; }
            if (!state || state.startsWith('Z')) break;
            assert.ok(attempt < 100, 'Killed fixture must stop before injecting EPERM');
          }
        }
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return kill(pid, signal);
    };
    const owner = "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setTimeout(()=>process.exit(7),200);";
    await assert.rejects(runVerification(process.execPath, ['-e', owner], { env: {}, timeout: 5000 }), ${live ? '/kill EPERM/' : '/failed \\(7\\)/'});
    assert.equal(injected, true);
  `;
  await runVerification(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH }, timeout: 10000 });
});
test('verification uses only supplied environment and observes spawn failure', async () => {
  const result = await runVerification(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env: { VERIFICATION_SYNTHETIC: 'only-this' } });
  const environment = JSON.parse(result);
  if (process.platform === 'darwin') delete environment.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(environment, { VERIFICATION_SYNTHETIC: 'only-this' });
  await assert.rejects(runVerification('/nonexistent-verification-executable', [], { env: {} }), /ENOENT/);
});
