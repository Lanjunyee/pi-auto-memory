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
