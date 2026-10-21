import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('CI is an exact read-only eight-cell host-matrix validation workflow', async () => {
  const text = await readFile('.github/workflows/check.yml', 'utf8');
  const workflow = parse(text);
  assert.deepEqual(Object.keys(workflow).sort(), ['jobs', 'name', 'on', 'permissions']);
  assert.equal(workflow.name, 'Checks');
  assert.deepEqual(workflow.on, { push: null, pull_request: null, workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['check']);
  const job = workflow.jobs.check;
  assert.deepEqual(Object.keys(job).sort(), ['runs-on', 'steps', 'strategy', 'timeout-minutes']);
  assert.equal(job['runs-on'], '${{ matrix.os }}');
  assert.equal(job['timeout-minutes'], 45);
  assert.deepEqual(job.strategy, { 'fail-fast': false, matrix: {
    os: ['ubuntu-24.04', 'macos-15'], node: ['22.19.0', '26.9.0'], pi: ['1.2.0', '1.3.0'],
  } });
  const tools = `set -euo pipefail
if [[ "$RUNNER_OS" == Linux ]]; then
  sudo apt-get update
  sudo apt-get install -y git ripgrep fd-find
else
  command -v git
  command -v rg >/dev/null || brew install ripgrep
  command -v fd >/dev/null || brew install fd
fi
git --version
rg --version
if command -v fd >/dev/null; then fd --version; else fdfind --version; fi
`;
  assert.deepEqual(job.steps, [
    { name: 'Checkout', uses: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683', with: { 'persist-credentials': false } },
    { name: 'Node', uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', with: { 'node-version': '${{ matrix.node }}' } },
    { name: 'Required scan tools', shell: 'bash', run: tools },
    { name: 'Install locked dependencies', run: 'npm ci --ignore-scripts' },
    { name: 'Full checks', run: 'npm run check' },
    { name: 'Candidate package', run: 'npm run test:package -- --host-version "${{ matrix.pi }}" ${{ matrix.pi == \'1.3.0\' && matrix.node == \'22.19.0\' && \'--host-regression --tui\' || \'\' }}' },
    { name: 'Public snapshot closure', run: 'node scripts/check-snapshot.mjs --host-version "${{ matrix.pi }}"' },
  ]);
  assert.doesNotMatch(text, /secrets\.|pull_request_target|continue-on-error|npm publish|git push|upload-artifact/);
});
