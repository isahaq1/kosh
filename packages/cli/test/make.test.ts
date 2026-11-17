/**
 * `shutro-erp make` (RFC 0036 §2.2): a module made by `module create`, a model and a field made by `make`, then the
 * real `shutro-erp check` on them — they meet the module standard on the first run. Also: field specs that are
 * wrong are refused with what is wrong, a part is never overwritten, `--dry-run` writes nothing, and a module whose
 * index.ts is not the scaffold's is told the two lines to add.
 *
 * The generated files import `shutro-erp/…`, the published package; here they are pointed at the workspace
 * packages it is built from, so they load as they would in an installation.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runCli } from '../src/index.js';
import { lineDiff, parseField, wireParts } from '../src/make.js';

/** `@kosh/views` is not a dependency of the CLI here: its source, by URL. */
const VIEWS = pathToFileURL(
  join(fileURLToPath(import.meta.url), '..', '..', '..', 'views', 'src', 'index.ts'),
).href;
const project = join(fileURLToPath(import.meta.url), '..', '.tmp-make');
const run = async (...args: string[]) => {
  let out = '';
  const code = await runCli(
    args,
    (t) => {
      out += t;
    },
    { cwd: project },
  );
  return { code, out };
};
const part = (name: string) => join(project, 'src', 'modules', 'library', 'parts', `${name}.ts`);

/** Points the generated files at the workspace packages `shutro-erp` is built from. */
async function inWorkspace(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await inWorkspace(path);
    else if (entry.name.endsWith('.ts'))
      await writeFile(
        path,
        (await readFile(path, 'utf8'))
          .replaceAll("'shutro-erp/orm'", "'@kosh/server/orm'")
          .replaceAll("'shutro-erp/modules-sdk'", "'@kosh/modules-sdk'")
          .replaceAll("'shutro-erp/views'", `'${VIEWS}'`)
          .replaceAll("'shutro-erp/messaging'", "'@kosh/messaging'")
          .replaceAll("'shutro-erp/reporting'", "'@kosh/reporting'")
          .replaceAll("'shutro-erp'", "'@kosh/server'"),
      );
  }
}

beforeAll(async () => {
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, 'src'), { recursive: true });
});
afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

test('field specs: read, and refused with what is wrong', () => {
  expect(parseField('title:char!')).toEqual({
    name: 'title',
    type: 'char',
    required: true,
    arg: null,
  });
  expect(parseField('kind:selection:new|used')).toMatchObject({
    type: 'selection',
    arg: 'new|used',
  });
  expect(parseField('author:m2o:res.partner!')).toMatchObject({
    type: 'm2o',
    arg: 'res.partner',
    required: true,
  });
  expect(() => parseField('Title:char')).toThrow('starts with a lower-case letter');
  expect(() => parseField('title:string')).toThrow('the type is one of');
  expect(() => parseField('kind:selection')).toThrow('lists its values');
  expect(() => parseField('author:m2o:partner')).toThrow('names its model');
  expect(() => parseField('active:boolean')).toThrow('every model has already');
});

test('a module, a model and a field made by the commands meet the module standard', {
  retry: 0,
  timeout: 120_000,
}, async () => {
  expect((await run('module', 'create', 'library')).code).toBe(0);

  // Nothing is written by a dry run.
  const dry = await run(
    'make',
    'model',
    'library',
    'book',
    '--fields',
    'title:char! isbn:char',
    '--dry-run',
  );
  expect(dry.code).toBe(0);
  expect(dry.out).toContain('would write src/modules/library/parts/book.ts');
  expect(existsSync(part('book'))).toBe(false);

  const made = await run(
    'make',
    'model',
    'library',
    'book',
    '--fields',
    'title:char! isbn:char pages:integer price:decimal kind:selection:new|used|damaged author:m2o:res.partner notes:text',
  );
  expect(made.out, made.out).toContain('wrote   src/modules/library/parts/book.ts');
  expect(made.out).toContain('updated src/modules/library/index.ts (its parts merged in)');
  expect(made.code).toBe(0);
  const index = await readFile(join(project, 'src', 'modules', 'library', 'index.ts'), 'utf8');
  expect(index).toContain("import { parts } from './parts.ts';");
  expect(index).toContain('models: [Item, ...parts.models],');
  expect(index).toContain('= defineModule(withParts(parts, {');

  // A second model: both are listed; a part that exists is never overwritten.
  expect(
    (
      await run(
        'make',
        'model',
        'library',
        'loan',
        '--fields',
        'reference:char! due:date lent:boolean',
      )
    ).code,
  ).toBe(0);
  // A part that exists is left as it is, and what would be written is shown beside it.
  const before = await readFile(part('book'), 'utf8');
  const again = await run('make', 'model', 'library', 'book', '--fields', 'title:char');
  expect(again.code).toBe(1);
  expect(again.out).toContain('exists already and was left as it is');
  expect(again.out).toContain('-     isbn: f.char(),');
  expect(await readFile(part('book'), 'utf8')).toBe(before);
  const parts = await readFile(join(project, 'src', 'modules', 'library', 'parts.ts'), 'utf8');
  expect(parts).toContain("import * as book from './parts/book.ts';");
  expect(parts).toContain('models: [...book.models, ...loan.models],');

  // A field: on the model, the list, the form and the import template.
  const field = await run('make', 'field', 'library.book', 'publishedOn:date!');
  expect(field.code, field.out).toBe(0);
  const book = await readFile(part('book'), 'utf8');
  expect(book).toContain('publishedOn: f.date({ required: true }),');
  expect(book).toContain("{ header: 'Published on', field: 'publishedOn' },");
  expect(book.match(/'publishedOn',/g)).toHaveLength(2); // the list and the form
  expect((await run('make', 'field', 'library.book', 'publishedOn:date')).out).toContain(
    'has a field publishedOn already',
  );
  expect((await run('make', 'field', 'library.nothing', 'x:char')).code).toBe(1);

  // A transition makes the loan a document: its state, the status bar, a chatter, a print template, an event.
  const step = await run(
    'make',
    'transition',
    'library.loan',
    'confirm',
    '--from',
    'draft',
    '--to',
    'confirmed',
  );
  expect(step.code, step.out).toBe(0);
  expect(step.out).toContain('now a document');
  const more = await run(
    'make',
    'transition',
    'library.loan',
    'close',
    '--from',
    'confirmed',
    '--to',
    'returned',
    '--label',
    'Mark returned',
  );
  expect(more.code, more.out).toBe(0);
  const loan = await readFile(part('loan'), 'utf8');
  expect(loan).toContain(
    "confirm: emitting('library.loan.confirmed', { from: ['draft'], to: 'confirmed' }),",
  );
  expect(loan).toContain(
    "close: emitting('library.loan.returned', { from: ['confirmed'], to: 'returned' }),",
  );
  expect(loan).toContain("returned: 'Returned',");
  expect(loan).toContain("k.button('close', { label: 'Mark returned' }),");
  expect(loan).toContain("tracking: ['state'],");
  expect(loan).toContain('chatter: true,');
  expect(loan.match(/topic: 'library\.loan\./g)).toHaveLength(2);
  expect(
    (await run('make', 'transition', 'library.loan', 'confirm', '--from', 'a', '--to', 'b')).out,
  ).toContain('has a transition confirm already');
  expect(
    (await run('make', 'transition', 'library.loan', 'Do-It', '--from', 'a', '--to', 'b')).code,
  ).toBe(2);

  // An action: a step for the managers, by a permission of its own. A report: a pivot and a chart.
  const action = await run(
    'make',
    'action',
    'library.loan',
    'settle',
    '--from',
    'returned',
    '--to',
    'settled',
  );
  expect(action.code, action.out).toBe(0);
  expect(action.out).toContain('for library.manager by the permission library.loan_settle');
  const report = await run('make', 'report', 'library.loan');
  expect(report.code, report.out).toBe(0);
  expect(report.out).toContain('a pivot and a chart by state, counting records');
  expect((await run('make', 'report', 'library.loan')).out).toContain('has a pivot already');
  expect((await run('make', 'report', 'library.book', '--measure', 'title')).out).toContain(
    'names a number',
  );
  expect(
    (await run('make', 'report', 'library.book', '--by', 'kind', '--measure', 'price')).code,
  ).toBe(0);
  const settled = await readFile(part('loan'), 'utf8');
  expect(settled).toContain("requires: 'library.loan_settle' }),");
  expect(settled).toContain(
    "orm.definePermission({ code: 'library.loan_settle', label: 'Settle loan', groups: ['library.manager'] }),",
  );
  expect(settled).toContain(
    "'library.loan.pivot': pivot(Loan, { rows: ['state'], measures: [{ count: true }] }),",
  );
  expect(settled).toContain("views: ['list', 'form', 'pivot', 'graph'] })");
  expect(settled).toContain(
    "import { action, form, graph, list, pivot, search } from 'shutro-erp/views';",
  );
  expect(await readFile(part('book'), 'utf8')).toContain(
    "'library.book.graph': graph(Book, { groupBy: ['kind'], measure: { sum: 'price' } }),",
  );
  // The parts' permissions and sample records join the module's.
  const wiredIndex = await readFile(join(project, 'src', 'modules', 'library', 'index.ts'), 'utf8');
  expect(wiredIndex).toContain('permissions: [...parts.permissions],');
  expect(wiredIndex).toContain('data: [...data, ...parts.data],');
  expect(settled).toContain(
    "orm.record('library.loan', 'loan_sample', { reference: 'Sample reference' }, { noupdate: true }),",
  );

  // The real check, on what was generated.
  await inWorkspace(join(project, 'src'));
  const check = await run('check', '--all');
  expect(check.out, check.out).toContain('1 module(s), 3 model(s)');
  expect(check.out).toContain('your modules meet the module standard');
  expect(check.code).toBe(0);
});

test('the diff names the lines that differ', () => {
  expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual(['- b', '+ B', '+ d']);
  expect(lineDiff('same', 'same')).toEqual([]);
});

test('a module whose index.ts is not the scaffold’s is told what to add, and still gets its part', async () => {
  expect(wireParts('export const x = somethingElse({});\n')).toBeNull();
  const dir = join(project, 'src', 'modules', 'handmade');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.ts'), 'export const handmade = {};\n');
  const made = await run('make', 'model', 'handmade', 'note', '--fields', 'title:char!');
  expect(made.code).toBe(0);
  expect(made.out).toContain('in index.ts, by hand');
  expect(made.out).toContain("its menu hangs under 'handmade.root'");
  expect(existsSync(join(dir, 'parts', 'note.ts'))).toBe(true);
  await rm(dir, { recursive: true, force: true });
});
