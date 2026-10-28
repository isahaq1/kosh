import { expect, test } from 'vitest';
import { PACKAGE, runCli } from '../src/index.js';

test('@kosh/cli prints usage', async () => {
  expect(PACKAGE.name).toBe('@kosh/cli');
  const out: string[] = [];
  expect(await runCli(['--help'], (t) => out.push(t))).toBe(0);
  expect(out.join('')).toContain('Usage: shutro-erp');
  expect(await runCli([], () => {})).toBe(2);
});
