import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runCli } from '../src/index.js';

let dir: string;
const out = () => join(dir, 'src/api/kosh.gen.ts');
const cli = async (...argv: string[]) => {
  const lines: string[] = [];
  const code = await runCli(argv, (t) => lines.push(t), { cwd: dir });
  return { code, text: lines.join('') };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kosh-cli-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('generate client from a module file, then --check', async () => {
  const fixture = join(import.meta.dirname, 'fixtures/app.ts');
  const written = await cli('generate', 'client', '--modules', fixture);
  expect(written).toEqual({ code: 0, text: `Wrote ${out()}.\n` });
  const code = await readFile(out(), 'utf8');
  expect(code).toContain('export interface ResUsers {');
  expect(code).not.toContain('auth.credential');

  expect((await cli('generate', 'client', '--modules', fixture, '--check')).code).toBe(0);
  await writeFile(out(), `${code}// edited\n`);
  const stale = await cli('generate', 'client', '--modules', fixture, '--check');
  expect(stale.code).toBe(1);
  expect(stale.text).toContain('out of date');
});

test('generate client from an OpenAPI file', async () => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Kosh API', version: '0.1.0' },
    paths: { '/api/v1/models/x.thing': { get: { operationId: 'listXThing' } } },
    components: {
      schemas: {
        XThing: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      },
    },
  };
  await writeFile(join(dir, 'openapi.json'), JSON.stringify(document));
  const result = await cli('generate', 'client', '--from', 'openapi.json', '--out', 'thing.ts');
  expect(result.code).toBe(0);
  expect(await readFile(join(dir, 'thing.ts'), 'utf8')).toContain(
    '"x.thing": {\n    record: XThing;',
  );
});

test('usage errors', async () => {
  expect((await cli('generate', 'client')).code).toBe(2);
  expect((await cli('generate', 'client', '--modules', 'x', '--from', 'y')).code).toBe(2);
  const missing = await cli('generate', 'client', '--modules', './missing.ts');
  expect(missing.code).toBe(1);
  expect(missing.text).toMatch(/^kosh generate client: /);
});
