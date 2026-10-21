import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

for (const script of ['scripts/test-package.mjs', 'scripts/check-snapshot.mjs']) {
  test(`${script} rejects an unsupported host before downloading anything`, async () => {
    for (const args of [['--host-version', '9.9.9'], ['--host-version'], ['--unknown']]) {
      const error = await exec(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 }).catch(error => error);
      assert.ok(error instanceof Error, `${script} ${args.join(' ')} must fail`);
      assert.match(String(error.stderr), /Usage:|Unsupported host version/);
    }
  });
}

test('host regression is opt-in, rejects unknown options early and never edits the working tree lock', async () => {
  const error = await exec(process.execPath, ['scripts/test-package.mjs', '--host-regression', '--unknown'], { encoding: 'utf8', timeout: 10000 }).catch(error => error);
  assert.ok(error instanceof Error);
  assert.match(String(error.stderr), /Usage:/);
  const text = await import('node:fs/promises').then(fs => fs.readFile('scripts/test-package.mjs', 'utf8'));
  assert.match(text, /--host-regression/);
  assert.match(text, /runHostRegression/);
  const regression = await import('node:fs/promises').then(fs => fs.readFile('scripts/host-regression.mjs', 'utf8'));
  for (const phrase of ['load.test.ts', 'host-contract.test.ts', 'registration.test.ts', 'lifecycle.test.ts', 'lifecycle-owner.test.ts',
    'Resolver mixed versions', 'Resolver fell back to a development tree', 'Copied test/source file differs', 'pi-agent-core', 'pi-ai']) {
    assert.ok(regression.includes(phrase), phrase);
  }
  assert.doesNotMatch(regression, /npm install|package-lock\.json|package\.json.*write/);
});
