/** New projects depend on the shutro-erp release the CLI runs from, not on the framework's API version. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KOSH_VERSION } from '@kosh/server';
import { expect, test } from 'vitest';
import { releaseVersion } from '../src/index.js';

test('inside the shutro-erp package: its version', () => {
  const root = mkdtempSync(join(tmpdir(), 'kosh-release-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'shutro-erp', version: '9.8.7' }),
  );
  mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
  expect(releaseVersion(join(root, 'dist', 'cli'))).toBe('9.8.7');
});

test('in the workspace (no shutro-erp around): the framework version', () => {
  const root = mkdtempSync(join(tmpdir(), 'kosh-release-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@kosh/cli', version: '0.1.0' }),
  );
  expect(releaseVersion(root)).toBe(KOSH_VERSION);
});
