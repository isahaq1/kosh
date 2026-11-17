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

  // The model's test: a user creates one, someone without the role is refused, on a served installation.
  const loanTest = await readFile(
    join(project, 'src', 'modules', 'library', 'test', 'loan.test.ts'),
    'utf8',
  );
  expect(loanTest).toContain(
    "import { type TestInstallation, testInstallation } from 'shutro-erp/testing';",
  );
  expect(loanTest).toContain("users: { user: ['library.user'], outsider: ['base.user'] },");
  expect(loanTest).toContain(
    "erp.call('POST', '/api/v1/models/library.loan', 'user', { reference: 'Sample reference' })",
  );
  expect(loanTest).toContain('.status).toBe(403);');

  // A page of the module's own: the component, its words in both languages, its action and menu, and main.tsx.
  await writeFile(
    join(project, 'src', 'main.tsx'),
    [
      "import { createDefaultRegistry, createKoshApi, KoshApp } from 'shutro-erp/ui';",
      "import { settingsMessages, registerSettingsWeb } from 'shutro-erp/settings/web';",
      '',
      'const registry = createDefaultRegistry();',
      'registerSettingsWeb(registry);',
      '',
      'render(<KoshApp api={createKoshApi()} registry={registry} messages={{ settings: settingsMessages }} />);',
      '',
    ].join('\n'),
  );
  const page = await run('make', 'page', 'library', 'shelf_map', '--label', 'Shelf map');
  expect(page.code, page.out).toBe(0);
  expect(page.out).toContain('updated src/main.tsx');
  const pageSource = await readFile(
    join(project, 'src', 'modules', 'library', 'web', 'ShelfMapPage.tsx'),
    'utf8',
  );
  expect(pageSource).toContain('export function ShelfMapPage(');
  expect(pageSource).toContain("useTranslation('library')");
  // It runs: loaded with React and the translations stubbed, the component renders its title and intro.
  const stubbed = join(project, 'ShelfMapPage.stub.tsx');
  await writeFile(
    stubbed,
    [
      '/** @jsxRuntime classic */',
      '/** @jsx h */',
      'const h = (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children });',
      "const useTranslation = (ns: string) => ({ t: (key: string) => ns + ':' + key });",
      'type PageProps = object;',
      'type ReactElement = unknown;',
      pageSource.replace(/^import .*;$/gm, ''),
    ].join('\n'),
  );
  const loaded = (await import(pathToFileURL(stubbed).href)) as {
    ShelfMapPage(props: object): { children: { type: string; children: string[] }[] };
    messages: { en: { title: string }; bn: { title: string } };
  };
  const rendered = loaded.ShelfMapPage({});
  expect(rendered.children.map((c) => [c.type, c.children[0]])).toEqual([
    ['h1', 'library:pages.shelf_map.title'],
    ['p', 'library:pages.shelf_map.intro'],
  ]);
  expect(loaded.messages.en.title).toBe('Shelf map');
  await rm(stubbed);
  const web = await readFile(join(project, 'src', 'modules', 'library', 'web', 'index.ts'), 'utf8');
  expect(web).toContain("registry.registerPage('library.ShelfMap', ShelfMapPage);");
  expect(web).toContain('export const libraryMessages = {');
  const main = await readFile(join(project, 'src', 'main.tsx'), 'utf8');
  expect(main).toContain(
    "import { libraryMessages, registerLibraryWeb } from './modules/library/web/index.ts';",
  );
  expect(main).toContain('registerSettingsWeb(registry);\nregisterLibraryWeb(registry);');
  expect(main).toContain('messages={{ library: libraryMessages, settings: settingsMessages }}');
  expect((await run('make', 'page', 'library', 'shelf_map')).out).toContain('exists already');
  expect(await readFile(part('page_shelf_map'), 'utf8')).toContain(
    "'library.action_page_shelf_map': { type: 'client' as const, page: 'library.ShelfMap', label: 'Shelf map' },",
  );
  await rm(join(project, 'src', 'main.tsx'));

  // A bridge: the module between two others, with an app of Shutro ERP or a module of yours.
  expect((await run('make', 'bridge', 'library', 'nothing_like_it')).out).toContain(
    'is neither a module of yours',
  );
  const withApp = await run('make', 'bridge', 'library', 'accounting', '--dry-run');
  expect(withApp.out).toContain('would write src/modules/library_accounting/index.ts');
  expect((await run('module', 'create', 'shelf')).code).toBe(0);
  const bridge = await run('make', 'bridge', 'library', 'shelf');
  expect(bridge.code, bridge.out).toBe(0);
  const bridged = await readFile(
    join(project, 'src', 'modules', 'library_shelf', 'index.ts'),
    'utf8',
  );
  expect(bridged).toContain("import { library, libraryShutro } from '../library/index.ts';");
  expect(bridged).toContain('bridge: [library, shelf],');
  expect((await run('make', 'bridge', 'library', 'shelf')).code).toBe(1);

  // The real check, on what was generated.
  await inWorkspace(join(project, 'src'));
  const check = await run('check', '--all');
  expect(check.out, check.out).toContain('3 module(s), 4 model(s)');
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
