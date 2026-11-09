import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const readWorkflow = (path) => readFile(path, 'utf8');

test('lockfile generators use the pinned resolution-only update command', async () => {
  for (const workflow of [
    '.github/workflows/refresh-lockfile.yml',
    '.github/workflows/docker.yml',
  ]) {
    const contents = await readWorkflow(workflow);
    const commands = contents
      .split('\n')
      .filter((line) => line.includes('pnpm install') && line.includes('--no-frozen-lockfile'));

    assert.ok(commands.length > 0, `${workflow} must contain a lockfile generation command`);
    for (const command of commands) {
      assert.match(command, /--resolution-only/);
      assert.match(command, /--ignore-scripts/);
      assert.doesNotMatch(command, /--lockfile-only/);
    }
  }
});

test('PR consumers reject stale lockfiles with pinned frozen installs', async () => {
  const [workflow, action] = await Promise.all([
    readWorkflow('.github/workflows/pr-trusted.yml'),
    readWorkflow('.github/actions/setup-ci-dependencies/action.yml'),
  ]);

  assert.match(workflow, /name: Validate generated lockfile\n\s+run: pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(action, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(`${workflow}\n${action}`, /--no-frozen-lockfile|resolution-only/);
});

test('lockfile refresh targets the fork PR base', async () => {
  const workflow = await readWorkflow('.github/workflows/refresh-lockfile.yml');
  assert.match(workflow, /- zay\/main/);
  assert.match(workflow, /--base zay\/main/);
  assert.match(workflow, /refresh-lockfile-zay-main/);
});