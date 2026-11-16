/**
 * `shutro-erp check` (RFC 0034 step 1): a company's own modules measured against the module standard — a clean one
 * passes, a broken one fails with each finding named; Bangla is reported but only fails with --strict.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runCli } from '../src/index.js';

const fixture = (name: string) => join(fileURLToPath(import.meta.url), '..', 'fixtures', name);
const run = async (cwd: string, ...args: string[]) => {
  let out = '';
  const code = await runCli(
    ['check', ...args],
    (t) => {
      out += t;
    },
    { cwd },
  );
  return { code, out };
};

test('a module that meets the standard passes; Bangla is reported, not failing', async () => {
  const { code, out } = await run(fixture('check-pass'));
  expect(out).toContain('1 module(s), 1 model(s)');
  expect(out).toContain('T1 every module ships Bangla for its labels: 1 open (reported)');
  expect(out).toContain('your modules meet the module standard');
  expect(code).toBe(0);
});

test('--strict makes the missing Bangla fail', async () => {
  const { code, out } = await run(fixture('check-pass'), '--strict');
  expect(out).toContain('T1 every module ships Bangla for its labels: 1 FAILING');
  expect(code).toBe(1);
});

test('a module that breaks the standard fails, each finding named', async () => {
  const { code, out } = await run(fixture('check-fail'));
  expect(out).toContain('2 module(s), 2 model(s)');
  expect(out).toContain('library: library.book — no label');
  expect(out).toContain('library: library.book — a list view without a search spec');
  expect(out).toContain('library: library.book — views: list');
  expect(out).not.toContain('clean: clean.note —');
  expect(code).toBe(1);
});

test('a project without modules of its own has nothing to check', async () => {
  const { code, out } = await run(fixture('check-none-here'));
  expect(out).toContain('nothing to check');
  expect(code).toBe(0);
});
