/**
 * The list of what a rule may read is the truth (RFC 0039 §4): every name the engine sets is on it, and every
 * name on it is set by the engine — read from `compute.ts` itself, so a variable added there without its line
 * here fails.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PAYROLL_VARIABLES, VARIABLE_FAMILIES, VARIABLES_HELP } from '../src/variables.js';

const source = readFileSync(new URL('../src/compute.ts', import.meta.url), 'utf8');
const listed = PAYROLL_VARIABLES.flatMap((g) => g.variables.map((v) => v.name)).sort();

test('every name the engine sets is listed, and nothing else', () => {
  const set = [...new Set([...source.matchAll(/\bset\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]))];
  expect(set.sort()).toEqual(listed);
});

test('every family the engine sets by code is listed', () => {
  const prefixes = [
    ...new Set([...source.matchAll(/\bset\(\s*`([A-Z]+_)\$\{/g)].map((m) => `${m[1]}<CODE>`)),
  ];
  const families = VARIABLE_FAMILIES.map((f) => f.name);
  for (const prefix of prefixes) expect(families).toContain(prefix);
  expect(prefixes.length).toBeGreaterThanOrEqual(6);
});

test('no name twice; the sentence for the form names them all', () => {
  expect(new Set(listed).size).toBe(listed.length);
  for (const name of listed) expect(VARIABLES_HELP).toContain(name);
  expect(VARIABLES_HELP).toContain('SHIFT_<CODE>');
});
