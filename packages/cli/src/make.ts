/**
 * `shutro-erp make` (RFC 0036 §2.2): generators whose output meets the module standard on its first
 * `shutro-erp check`.
 *
 * - `make model <module> <name> --fields "title:char! price:decimal author:m2o:res.partner"` writes the model as a
 *   **part** of the module — `src/modules/<module>/parts/<name>.ts`: the Shutro model with its label, access for the
 *   module's user and manager, and its action, menu, list, form, search and import template — and lists it in
 *   `parts.ts`, which the module's manifest merges (`withParts`). Hand-written code is never rewritten: a module
 *   made before parts gets the two lines to add, said once.
 * - `make field <module>.<model> <name:type>` adds a field to a generated model, its list, its form and its import
 *   template, at the `make:` markers; where a marker was removed, it says what to add by hand.
 *
 * - `make transition <module>.<model> <name> --from <state> --to <state>` makes the model a **document**: a state
 *   with its steps, tracked; the status bar and a button on the form, a chatter, the state on the list; a print
 *   template; and a named event when the step is taken. Later transitions add their states, buttons and events.
 *
 * - `make action <module>.<model> <name> --from <state> --to <state> [--group manager]` is a step only some may
 *   take: the transition requires a permission of its own, granted to the module's managers (or `--group`).
 * - `make report <module>.<model> [--by <field>] [--measure <field>]` adds a pivot and a chart of the model.
 * - `make page <module> <name>` writes a page of the module's own (React), with its menu, registered in the
 *   back-office.
 * - `make bridge <a> <b>` writes the module that connects two others, installed when both are.
 *
 * `make model` also writes the model's test (`test/<name>.test.ts`): a user of the module creates one, someone
 * without its role is refused — on a served installation (`testInstallation` of `shutro-erp/testing`).
 *
 * Nothing is overwritten: a part that exists is not replaced — `make model` shows how it differs from what it would
 * write. `--dry-run` shows what would be written.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { APPS, type AppName } from './templates.js';

const USAGE = `Usage: shutro-erp make <model | field | transition | action | report | page | bridge> …

  make model <module> <name> --fields "<field> <field> …" [--label <Label>] [--plural <Labels>] [--dry-run]
      A model of src/modules/<module>/ as a part of its own: the model with its label and access, its action and
      menu, list, form, search and import template — meeting the module standard (shutro-erp check).

  make field <module>.<model> <field> [--dry-run]
      A field added to a model made by make model: on the model, its list, its form and its import template.

  make transition <module>.<model> <name> --from <state> --to <state> [--label <Button>] [--dry-run]
      A step of the model's state (confirm: draft to confirmed). The first makes the model a document: its state,
      the status bar and the button, a chatter, a print template and a named event; the next ones add to them.

  make action <module>.<model> <name> --from <state> --to <state> [--group <manager>] [--label <Button>]
      A step only some may take: a transition with a permission of its own, granted to the module's managers
      (or the group named: --group user).

  make report <module>.<model> [--by <field>] [--measure <field>] [--dry-run]
      A pivot and a chart of the model, grouped by a field (default: its state, a selection, a relation or a date
      by month) and counting records (or summing --measure).

  make page <module> <name> [--label <Title>] [--dry-run]
      A page of your own in the module (React): src/modules/<module>/web/<Name>Page.tsx with its menu, in English
      and Bangla, registered in src/main.tsx.

  make bridge <a> <b> [--dry-run]
      The module that connects two others (yours, or apps of Shutro ERP): src/modules/<a>_<b>/, installed when
      both are. Put there what one adds to the other.

  A field is name:type, with ! when it is required:
      title:char!   notes:text   pages:integer   price:decimal   lent:boolean   due:date   seen:datetime
      kind:selection:new|used|damaged          author:m2o:res.partner
`;

const TYPES = [
  'char',
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'selection',
  'm2o',
];

export interface FieldSpec {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  /** A selection's values, or a many-to-one's model. */
  readonly arg: string | null;
}

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter((w) => w !== '');
const title = (name: string): string =>
  words(name)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()))
    .join(' ');
const pascal = (name: string): string =>
  words(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
const camel = (name: string): string => {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
const plural = (label: string): string =>
  /[^aeiou]y$/.test(label)
    ? `${label.slice(0, -1)}ies`
    : /(s|x|ch|sh)$/.test(label)
      ? `${label}es`
      : `${label}s`;
const quote = (text: string): string => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/** Reads `title:char!`, `kind:selection:new|used`, `author:m2o:res.partner`; throws with what is wrong. */
export function parseField(text: string): FieldSpec {
  const [rawName = '', rawType = '', ...rest] = text.split(':');
  const required = rawType.endsWith('!') || (rest.at(-1) ?? '').endsWith('!');
  const type = rawType.replace(/!$/, '');
  const arg = rest.length === 0 ? null : rest.join(':').replace(/!$/, '');
  if (!/^[a-z][A-Za-z0-9]*$/.test(rawName))
    throw new Error(
      `"${text}": a field name starts with a lower-case letter (camelCase), like dueDate.`,
    );
  if (
    ['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'active', 'company'].includes(
      rawName,
    )
  )
    throw new Error(`"${rawName}" is a field every model has already.`);
  if (!TYPES.includes(type)) throw new Error(`"${text}": the type is one of ${TYPES.join(', ')}.`);
  if (
    type === 'selection' &&
    (arg === null || arg.split('|').some((v) => !/^[a-z][a-z0-9_]*$/.test(v)))
  )
    throw new Error(`"${text}": a selection lists its values, like kind:selection:new|used.`);
  if (type === 'm2o' && (arg === null || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(arg)))
    throw new Error(`"${text}": a many-to-one names its model, like author:m2o:res.partner.`);
  if (type !== 'selection' && type !== 'm2o' && arg !== null)
    throw new Error(`"${text}": ${type} takes nothing after it.`);
  return { name: rawName, type, required, arg };
}

/** The field as Shutro declares it. */
function fieldCode(f: FieldSpec): string {
  const options: string[] = [];
  if (f.required) options.push('required: true');
  const label = title(f.name);
  if (f.type === 'selection') {
    const values = (f.arg ?? '').split('|');
    const labels = values.map((v) => title(v));
    // Help on every selection (the standard's M5): say what it is for when you know better.
    const help = `${label}: ${labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`}.`;
    return `f.selection({ ${values.map((v, i) => `${v}: ${quote(labels[i] as string)}`).join(', ')} }, { ${[...options, `help: ${quote(help)}`].join(', ')} })`;
  }
  if (f.type === 'm2o')
    return `f.many2one(${quote(f.arg ?? '')}${options.length === 0 ? '' : `, { ${options.join(', ')} }`})`;
  if (f.type === 'decimal') options.unshift('scale: 2');
  return `f.${f.type}(${options.length === 0 ? '' : `{ ${options.join(', ')} }`})`;
}

interface ModelNames {
  readonly module: string;
  readonly name: string;
  /** `library.book` */
  readonly model: string;
  /** `Book` */
  readonly constant: string;
  readonly label: string;
  readonly plural: string;
}

/** The part file of a model. */
export function partFile(n: ModelNames, fields: readonly FieldSpec[]): string {
  const named = fields.find((f) => f.name === 'name') ?? fields.find((f) => f.type === 'char');
  const searched = fields.filter((f) => f.type === 'char').map((f) => f.name);
  const onList = fields.filter((f) => f.type !== 'text').map((f) => f.name);
  const lines = (items: readonly string[], indent: string) =>
    items.map((i) => `${indent}${i},\n`).join('');
  return `/**
 * ${n.label}: a part of the ${n.module} module, made by \`shutro-erp make model\`. It is yours to change; the lines
 * marked \`make:\` are where \`shutro-erp make field\` adds to it.
 */
import { orm } from 'shutro-erp/orm';
import { action, form, list, search } from 'shutro-erp/views';

const { defineModel, f } = orm;

export const ${n.constant} = defineModel(${quote(n.model)}, {
  label: ${quote(n.label)},
${named === undefined ? '' : `  recName: ${quote(named.name)},\n`}  archivable: true,
  access: {
    '${n.module}.user': ['read', 'write', 'create'],
    '${n.module}.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  order: [${quote(`${named?.name ?? 'id'} asc`)}],
  fields: {
${lines(
  fields.map((f) => `${f.name}: ${fieldCode(f)}`),
  '    ',
)}    // make:fields
  },
});

export const models = [${n.constant}];

export const actions = {
  '${n.module}.action_${n.name}': action(${n.constant}, { label: ${quote(n.plural)}, views: ['list', 'form'] }),
};

export const menus = [
  {
    id: '${n.module}.${n.name}',
    parent: '${n.module}.root',
    label: ${quote(n.plural)},
    action: '${n.module}.action_${n.name}',
  },
];

export const views = {
  '${n.model}.list': list(${n.constant}, {
    columns: [
${lines(onList.map(quote), '      ')}      // make:list
    ],
  }),
  '${n.model}.form': form(${n.constant}, (k) => ({
    // make:header
    sheet: [
      k.group('main', [
${lines(
  fields.map((f) => quote(f.name)),
  '        ',
)}        // make:form
      ]),
    ],
  })),
  // make:views
};

export const searches = {
  '${n.model}': search(${n.constant}, { fields: [${searched.map(quote).join(', ')}] }),
};

export const importTemplates = [
  {
    key: '${n.name}',
    model: '${n.model}',
    label: ${quote(n.plural)},
    columns: [
${lines(
  fields.map((f) => `{ header: ${quote(title(f.name))}, field: ${quote(f.name)} }`),
  '      ',
)}      // make:import
    ],
  },
];

export const documents = [
  // make:documents
];

export const events = [
  // make:events
];

export const permissions = [
  // make:permissions
];

/** Seed data: a sample record, made once and then left to the users (\`shutro-erp seed\`). */
export const data = [
${sample(n, fields)}];
`;
}

/** The model's test: who may do what, on a served installation. Null when a required relation cannot be guessed. */
export function testFile(n: ModelNames, fields: readonly FieldSpec[]): string | null {
  const values = sampleValues(fields);
  if (values === null) return null;
  return `/**
 * ${n.label}: who may do what. A user of the module creates one; someone without its role is refused by the
 * server. Made by \`shutro-erp make model\`; yours to extend. Run with \`npm test\` (it makes a scratch database on
 * the server of DATABASE_URL, or of KOSH_TEST_POSTGRES).
 */
import { type TestInstallation, testInstallation } from 'shutro-erp/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { modules } from '../../../modules.ts';

let erp: TestInstallation;

beforeAll(async () => {
  erp = await testInstallation({
    modules,
    users: { user: ['${n.module}.user'], outsider: ['base.user'] },
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a user of the module creates a ${n.label.toLowerCase()} and finds it', async () => {
  const made = await erp.call('POST', '/api/v1/models/${n.model}', 'user', { ${values.join(', ')} });
  expect(made.status).toBe(201);
  const found = await erp.call('GET', '/api/v1/models/${n.model}', 'user');
  expect(found.status).toBe(200);
});

test('someone without the role is refused by the server', async () => {
  expect((await erp.call('GET', '/api/v1/models/${n.model}', 'outsider')).status).toBe(403);
  const refused = await erp.call('POST', '/api/v1/models/${n.model}', 'outsider', { ${values.join(', ')} });
  expect(refused.status).toBe(403);
});
`;
}

/** Sample values of the fields, as code; null when a required relation cannot be guessed. */
function sampleValues(fields: readonly FieldSpec[]): string[] | null {
  if (fields.some((f) => f.type === 'm2o' && f.required)) return null;
  const values: string[] = [];
  for (const f of fields) {
    if (f.type === 'char')
      values.push(`${f.name}: ${quote(`Sample ${title(f.name).toLowerCase()}`)}`);
    else if (f.type === 'integer') values.push(`${f.name}: 1`);
    else if (f.type === 'decimal') values.push(`${f.name}: '1.00'`);
    else if (f.type === 'selection')
      values.push(`${f.name}: ${quote((f.arg ?? '').split('|')[0] ?? '')}`);
    else if (f.type === 'date' && f.required) values.push(`${f.name}: '2026-01-01'`);
    else if (f.type === 'datetime' && f.required) values.push(`${f.name}: '2026-01-01T00:00:00Z'`);
    else if (f.type === 'text' && f.required) values.push(`${f.name}: 'Sample'`);
  }
  return values;
}

/** A sample record of the model as seed data, or nothing when a required relation cannot be guessed. */
function sample(n: ModelNames, fields: readonly FieldSpec[]): string {
  if (fields.some((f) => f.type === 'm2o' && f.required)) return '';
  const values: string[] = [];
  for (const f of fields) {
    if (f.type === 'char')
      values.push(`${f.name}: ${quote(`Sample ${title(f.name).toLowerCase()}`)}`);
    else if (f.type === 'integer') values.push(`${f.name}: 1`);
    else if (f.type === 'decimal') values.push(`${f.name}: '1.00'`);
    else if (f.type === 'selection')
      values.push(`${f.name}: ${quote((f.arg ?? '').split('|')[0] ?? '')}`);
    else if (f.type === 'date' && f.required) values.push(`${f.name}: '2026-01-01'`);
    else if (f.type === 'datetime' && f.required) values.push(`${f.name}: '2026-01-01T00:00:00Z'`);
    else if (f.type === 'text' && f.required) values.push(`${f.name}: 'Sample'`);
  }
  return `  orm.record(${quote(n.model)}, ${quote(`${n.name}_sample`)}, { ${values.join(', ')} }, { noupdate: true }),\n`;
}

/** `parts.ts`: every part in `parts/`, merged. Generated; rewritten by each `make model`. */
export function partsIndex(names: readonly string[]): string {
  const id = (name: string) => camel(name);
  const spread = (key: string, open: string, close: string) =>
    `  ${key}: ${open}${names.map((p) => `...${id(p)}.${key}`).join(', ')}${close},\n`;
  return `// Made by \`shutro-erp make\`: the parts in ./parts/, merged. Do not edit: run a make command instead.
${names.map((p) => `import * as ${id(p)} from './parts/${p}.ts';`).join('\n')}

export const parts = {
${spread('models', '[', ']')}${spread('actions', '{ ', ' }')}${spread('menus', '[', ']')}${spread('views', '{ ', ' }')}${spread('searches', '{ ', ' }')}${spread('importTemplates', '[', ']')}${spread('documents', '[', ']')}${spread('events', '[', ']')}${spread('permissions', '[', ']')}${spread('data', '[', ']')}};
`;
}

/** The module's index.ts with its parts merged in, or null when its shape is not the scaffold's. */
export function wireParts(index: string): string | null {
  let out = index;
  if (!out.includes("from './parts.ts'")) {
    const imports = [...out.matchAll(/^import .*;$/gm)];
    const last = imports.at(-1);
    const models = /(\n {2}models: \[)([^\]]*)(\],)/.exec(out);
    const manifest = /= defineModule\(\{/.exec(out);
    const end = out.lastIndexOf('});');
    const sdk = /import \{([^}]*)\} from 'shutro-erp\/modules-sdk';/.exec(out);
    if (last === undefined || models === null || manifest === null || end < 0 || sdk === null)
      return null;
    out = `${out.slice(0, end)}}));${out.slice(end + 3)}`;
    out = out.replace('= defineModule({', '= defineModule(withParts(parts, {');
    out = out.replace(
      models[0],
      `${models[1]}${[models[2]?.trim(), '...parts.models'].filter((x) => x !== '' && x !== undefined).join(', ')}${models[3]}`,
    );
    out = out.replace(sdk[0], () => {
      const names = [...(sdk[1] ?? '').split(',').map((x) => x.trim()), 'withParts'].filter(
        (x) => x !== '',
      );
      return `import { ${names.sort().join(', ')} } from 'shutro-erp/modules-sdk';`;
    });
    out = out.replace(last[0], `${last[0]}\nimport { parts } from './parts.ts';`);
  }
  // The parts' permissions and seed data join the Shutro module's, beside its models.
  const models = /\n {2}models: \[[^\]]*\],/.exec(out);
  if (!out.includes('...parts.permissions')) {
    const own = /(\n {2}permissions: \[)([^\]]*)(\],)/.exec(out);
    if (own !== null)
      out = out.replace(
        own[0],
        `${own[1]}${[own[2]?.trim().replace(/,$/, ''), '...parts.permissions'].filter((x) => x !== '' && x !== undefined).join(', ')}${own[3]}`,
      );
    else if (models !== null)
      out = out.replace(models[0], `${models[0]}\n  permissions: [...parts.permissions],`);
  }
  if (!out.includes('...parts.data')) {
    if (out.includes('\n  data,\n'))
      out = out.replace('\n  data,\n', '\n  data: [...data, ...parts.data],\n');
    else if (!/\n {2}data[,:]/.test(out) && models !== null)
      out = out.replace(models[0], `${models[0]}\n  data: [...parts.data],`);
  }
  return out;
}

/** What every part exports, with the marker `make` adds at: parts made before one existed get it appended. */
const PART_EXPORTS: readonly [name: string, marker: string][] = [
  ['documents', 'documents'],
  ['events', 'events'],
  ['permissions', 'permissions'],
  ['data', 'data'],
];

/** Brings the parts up to date and rewrites `parts.ts`; returns the parts' names. */
async function syncParts(
  dir: string,
  dry: boolean,
  extra: readonly string[] = [],
): Promise<string[]> {
  const folder = join(dir, 'parts');
  const names = existsSync(folder)
    ? readdirSync(folder)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => f.slice(0, -3))
    : [];
  for (const name of names) {
    const path = join(folder, `${name}.ts`);
    const text = await readFile(path, 'utf8');
    let next = text;
    for (const [exported, marker] of PART_EXPORTS)
      if (!new RegExp(`^export const ${exported}\\b`, 'm').test(next))
        next = `${next.replace(/\n*$/, '\n')}\nexport const ${exported} = [\n  // make:${marker}\n];\n`;
    if (next !== text && !dry) await writeFile(path, next);
  }
  const all = [...new Set([...names, ...extra])].sort();
  if (!dry && all.length > 0) await writeFile(join(dir, 'parts.ts'), partsIndex(all));
  return all;
}

/** Re-wires index.ts after a command (its parts, their permissions and seed data); says what happened. */
async function rewire(
  dir: string,
  module: string,
  dry: boolean,
  write: (t: string) => void,
): Promise<void> {
  const indexPath = join(dir, 'index.ts');
  if (!existsSync(indexPath)) return;
  const index = await readFile(indexPath, 'utf8');
  const wired = wireParts(index);
  if (wired === null) write(BY_HAND);
  else if (wired !== index) {
    if (!dry) await writeFile(indexPath, wired);
    write(
      `  ${dry ? 'would update' : 'updated'} src/modules/${module}/index.ts (its parts merged in)\n`,
    );
  }
}

/** The lines that differ between two texts: `-` what is there, `+` what would be written. */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence, by lines.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (
      j < b.length &&
      (i === a.length ||
        ((lcs[i] as number[])[j + 1] as number) > ((lcs[i + 1] as number[])[j] as number))
    ) {
      out.push(`+ ${b[j]}`);
      j += 1;
    } else {
      out.push(`- ${a[i]}`);
      i += 1;
    }
  }
  return out;
}

/**
 * The module's index.ts depending on Messaging and Reporting, its user group holding their roles — what a document
 * needs for its chatter and its print template. Null when its shape is not the scaffold's.
 */
export function wireDocument(index: string, module: string): string | null {
  if (index.includes("'shutro-erp/messaging'") && index.includes("'shutro-erp/reporting'"))
    return index;
  const imports = [...index.matchAll(/^import .*;$/gm)];
  const last = imports.at(-1);
  const shutroDepends = /\n {2}depends: \[baseShutro\],/.exec(index);
  const depends = /\n {2}depends: \[base\],/.exec(index);
  const group = new RegExp(`(code: '${module}\\.user',[^}]*implies: \\[)([^\\]]*)(\\])`).exec(
    index,
  );
  if (last === undefined || shutroDepends === null || depends === null || group === null)
    return null;
  const roles = [
    ...(group[2] ?? '').split(',').map((x) => x.trim()),
    "'messaging.user'",
    "'reporting.user'",
  ];
  return index
    .replace(shutroDepends[0], '\n  depends: [baseShutro, messagingShutro, reportingShutro],')
    .replace(depends[0], '\n  depends: [base, messaging, reporting],')
    .replace(
      group[0],
      `${group[1]}${[...new Set(roles.filter((x) => x !== ''))].join(', ')}${group[3]}`,
    )
    .replace(
      last[0],
      `${last[0]}\nimport { messaging, messagingShutro } from 'shutro-erp/messaging';\nimport { reporting, reportingShutro } from 'shutro-erp/reporting';`,
    );
}

const DOCUMENT_BY_HAND = (
  module: string,
) => `  in index.ts, by hand (its shape is not the one module create makes): a document's chatter and print template
  need Messaging and Reporting, and its users their roles —
      import { messaging, messagingShutro } from 'shutro-erp/messaging';
      import { reporting, reportingShutro } from 'shutro-erp/reporting';
      … orm.defineModule({ …, depends: [<yours>, messagingShutro, reportingShutro] })
      … the group ${module}.user: implies: [<yours>, 'messaging.user', 'reporting.user']
      … defineModule({ …, depends: [<yours>, messaging, reporting] })
`;

const BY_HAND = `  in index.ts, by hand (its shape is not the one module create makes):
      import { withParts } from 'shutro-erp/modules-sdk';
      import { parts } from './parts.ts';
      … orm.defineModule({ …, models: [<yours>, ...parts.models] })
      … defineModule(withParts(parts, { <your manifest> }))
`;

async function makeModel(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      fields: { type: 'string' },
      label: { type: 'string' },
      plural: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [module, name] = positionals;
  if (module === undefined || name === undefined || values.fields === undefined) {
    write(USAGE);
    return 2;
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    write(
      `"${name}" cannot be a model name: lower-case letters, digits and _, like book or loan_line.\n`,
    );
    return 2;
  }
  const dir = join(cwd, 'src', 'modules', module);
  const indexPath = join(dir, 'index.ts');
  if (!existsSync(indexPath)) {
    write(
      `There is no src/modules/${module}/index.ts: make the module first (shutro-erp module create ${module}).\n`,
    );
    return 1;
  }
  let fields: FieldSpec[];
  try {
    fields = values.fields
      .split(/\s+/)
      .filter((x) => x !== '')
      .map(parseField);
    if (fields.length === 0) throw new Error('--fields names at least one field.');
    const twice = fields.find((f, i) => fields.findIndex((g) => g.name === f.name) !== i);
    if (twice !== undefined) throw new Error(`The field ${twice.name} is named twice.`);
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const partPath = join(dir, 'parts', `${name}.ts`);
  const label = values.label ?? title(name);
  const names: ModelNames = {
    module,
    name,
    model: `${module.replaceAll('-', '_')}.${name}`,
    constant: pascal(name),
    label,
    plural: values.plural ?? plural(label),
  };
  if (existsSync(partPath)) {
    // Never replaced: what differs is shown, for the person to take what they want.
    const diff = lineDiff(await readFile(partPath, 'utf8'), partFile(names, fields));
    write(
      `src/modules/${module}/parts/${name}.ts exists already and was left as it is. Add to it with shutro-erp make field ${module}.${name} <field>.\n`,
    );
    if (diff.length === 0) write('It is what make model would write.\n');
    else
      write(
        `What make model would write differs in ${diff.length} line(s) (- there, + would be written):\n${diff.slice(0, 80).join('\n')}\n${diff.length > 80 ? `… and ${diff.length - 80} more\n` : ''}`,
      );
    return 1;
  }
  const index = await readFile(indexPath, 'utf8');
  const dry = values['dry-run'] === true;
  const said = dry ? 'would write' : 'wrote  ';
  if (!dry) {
    await mkdir(join(dir, 'parts'), { recursive: true });
    await writeFile(partPath, partFile(names, fields));
  }
  const all = await syncParts(dir, dry, [name]);
  const test = testFile(names, fields);
  const testPath = join(dir, 'test', `${name}.test.ts`);
  if (test !== null && !existsSync(testPath)) {
    if (!dry) {
      await mkdir(join(dir, 'test'), { recursive: true });
      await writeFile(testPath, test);
    }
    write(
      `  ${said} src/modules/${module}/test/${name}.test.ts (a user creates one; someone without the role is refused)\n`,
    );
  }
  write(
    `  ${said} src/modules/${module}/parts/${name}.ts (${names.model}: ${fields.length} fields, list, form, search, import template)\n`,
  );
  write(
    `  ${said} src/modules/${module}/parts.ts (${all.length} part${all.length === 1 ? '' : 's'})\n`,
  );
  await rewire(dir, module, dry, write);
  if (!index.includes(`'${module}.root'`))
    write(
      `  its menu hangs under '${module}.root', which index.ts does not have: give the menu in the part its parent.\n`,
    );
  if (!index.includes(`'${module}.user'`) || !index.includes(`'${module}.manager'`))
    write(
      `  its access names the groups ${module}.user and ${module}.manager, which index.ts does not have: name yours in the part.\n`,
    );
  if (!dry) write('\nNext: shutro-erp check, then shutro-erp migrate (it plans the new table).\n');
  return 0;
}

/** Adds `line` before the `make:<marker>` line, at its indentation; null when the marker is gone. */
function atMarker(text: string, marker: string, line: string): string | null {
  const found = new RegExp(`^([ \\t]*)// make:${marker}[ \\t]*$`, 'm').exec(text);
  if (found === null) return null;
  return `${text.slice(0, found.index)}${found[1]}${line}\n${text.slice(found.index)}`;
}

async function makeField(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { 'dry-run': { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
  const [target, spec] = positionals;
  const dot = target?.lastIndexOf('.') ?? -1;
  if (target === undefined || spec === undefined || dot <= 0) {
    write(USAGE);
    return 2;
  }
  const module = target.slice(0, dot);
  const name = target.slice(dot + 1);
  const rel = `src/modules/${module}/parts/${name}.ts`;
  const path = join(cwd, 'src', 'modules', module, 'parts', `${name}.ts`);
  if (!existsSync(path)) {
    write(`There is no ${rel}: make field adds to models made by shutro-erp make model.\n`);
    return 1;
  }
  let field: FieldSpec;
  try {
    field = parseField(spec);
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let text = await readFile(path, 'utf8');
  if (new RegExp(`^\\s*${field.name}: f\\.`, 'm').test(text)) {
    write(`${target} has a field ${field.name} already.\n`);
    return 1;
  }
  const additions: [marker: string, line: string, what: string][] = [
    ['fields', `${field.name}: ${fieldCode(field)},`, 'the model’s fields'],
    ...(field.type === 'text'
      ? []
      : ([['list', `${quote(field.name)},`, 'the list’s columns']] as [string, string, string][])),
    ['form', `${quote(field.name)},`, 'the form’s group'],
    [
      'import',
      `{ header: ${quote(title(field.name))}, field: ${quote(field.name)} },`,
      'the import template’s columns',
    ],
  ];
  const byHand: string[] = [];
  for (const [marker, line, what] of additions) {
    const next = atMarker(text, marker, line);
    if (next === null) byHand.push(`      ${what}: ${line}`);
    else text = next;
  }
  const dry = values['dry-run'] === true;
  if (byHand.length === additions.length) {
    write(`${rel} has no make: markers left. Add by hand:\n${byHand.join('\n')}\n`);
    return 1;
  }
  if (!dry) await writeFile(path, text);
  write(
    `  ${dry ? 'would update' : 'updated'} ${rel} (${field.name}: ${field.type}${field.required ? ', required' : ''})\n`,
  );
  if (byHand.length > 0) write(`  a marker is gone there; add by hand:\n${byHand.join('\n')}\n`);
  if (!dry) write('\nNext: shutro-erp check, then shutro-erp migrate (it plans the new column).\n');
  return 0;
}

/** The fields a part declares, by name with their kind (`char`, `many2one`, …), read from its `fields: {` block. */
function declaredFields(text: string): { name: string; kind: string }[] {
  const start = text.indexOf('  fields: {');
  const end = text.indexOf('// make:fields');
  if (start < 0 || end < start) return [];
  return [
    ...text.slice(start, end).matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*): f\.([A-Za-z0-9]+)\(/gm),
  ].map((m) => ({ name: m[1] as string, kind: m[2] as string }));
}

async function makeTransition(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
  restricted = false,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      label: { type: 'string' },
      group: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [target, name] = positionals;
  const dot = target?.lastIndexOf('.') ?? -1;
  // An action is a transition with a permission of its own, for a group of the module (its managers by default).
  const group = restricted ? (values.group ?? 'manager') : values.group;
  if (
    target === undefined ||
    name === undefined ||
    dot <= 0 ||
    values.from === undefined ||
    values.to === undefined ||
    (group !== undefined && !/^[a-z][a-z0-9_]*$/.test(group))
  ) {
    write(USAGE);
    return 2;
  }
  const state = /^[a-z][a-z0-9_]*$/;
  if (!/^[a-z]+$/.test(name)) {
    write(`"${name}" cannot be a transition's name: one lower-case word, like confirm.\n`);
    return 2;
  }
  if (!state.test(values.from) || !state.test(values.to) || values.from === values.to) {
    write(
      '--from and --to are two different states: lower-case letters, digits and _, like draft and confirmed.\n',
    );
    return 2;
  }
  const module = target.slice(0, dot);
  const model = target.slice(dot + 1);
  const rel = `src/modules/${module}/parts/${model}.ts`;
  const path = join(cwd, 'src', 'modules', module, 'parts', `${model}.ts`);
  if (!existsSync(path)) {
    write(`There is no ${rel}: make transition adds to models made by shutro-erp make model.\n`);
    return 1;
  }
  let text = await readFile(path, 'utf8');
  const id = /defineModel\('([^']+)'/.exec(text)?.[1] ?? `${module}.${model}`;
  const label = /\n {2}label: '([^']+)'/.exec(text)?.[1] ?? title(model);
  const topic = `${id}.${values.to}`;
  const button = values.label ?? title(name);
  const permission = `${id.replace(/\.[^.]+$/, '')}.${model}_${name}`;
  const transition = `${name}: emitting(${quote(topic)}, { from: [${quote(values.from)}], to: ${quote(values.to)}${group === undefined ? '' : `, requires: ${quote(permission)}`} }),`;
  const event = `{ topic: ${quote(topic)}, model: ${quote(id)}, label: ${quote(`${label} ${title(values.to).toLowerCase()}`)} },`;
  const byHand: string[] = [];
  const add = (marker: string, line: string, what: string) => {
    const next = atMarker(text, marker, line);
    if (next === null)
      byHand.push(`      ${what}: ${line.split('\n')[0]}${line.includes('\n') ? ' …' : ''}`);
    else text = next;
  };
  const first = !/^ {4}state: f\.state\(/m.test(text);
  if (first) {
    const fields = declaredFields(text);
    const printed = fields.filter(
      (f) => !['text', 'many2one', 'one2many', 'many2many'].includes(f.kind),
    );
    const named = /\n {2}recName: '([^']+)'/.exec(text)?.[1];
    add(
      'fields',
      [
        'state: f.state({',
        '      states: {',
        `        ${values.from}: ${quote(title(values.from))},`,
        `        ${values.to}: ${quote(title(values.to))},`,
        '        // make:states',
        '      },',
        `      initial: ${quote(values.from)},`,
        `      help: ${quote(`${title(values.from)} until it is ${title(values.to).toLowerCase()}.`)},`,
        '      transitions: {',
        `        ${transition}`,
        '        // make:transitions',
        '      },',
        '    }),',
      ].join('\n'),
      'the model’s fields',
    );
    // Tracked, as the standard asks of a document's state.
    if (text.includes('\n  access: {') && !text.includes('\n  tracking: ['))
      text = text.replace('\n  access: {', "\n  tracking: ['state'],\n  access: {");
    else if (!text.includes('\n  tracking: ['))
      byHand.push("      the model: tracking: ['state'],");
    add('list', "{ field: 'state', widget: 'badge' },", 'the list’s columns');
    add(
      'header',
      [
        'header: {',
        "      statusbar: 'state',",
        '      buttons: [',
        `        k.button(${quote(name)}, { primary: true, label: ${quote(button)} }),`,
        '        // make:buttons',
        '      ],',
        '    },',
        '    chatter: true,',
      ].join('\n'),
      'the form',
    );
    add(
      'documents',
      [
        '{',
        `    key: ${quote(model)},`,
        `    name: ${quote(label)},`,
        `    model: ${quote(id)},`,
        '    layout: {',
        "      paper: 'A4',",
        `      header: ${quote(label)},`,
        "      footer: 'Page {{page}} of {{pages}}',",
        '      blocks: [',
        `        { kind: 'heading', id: 'title', text: ${quote(named === undefined ? label : `${label} {{${named}}}`)}, level: 1 },`,
        '        {',
        "          kind: 'fields',",
        "          id: 'details',",
        '          items: [',
        ...printed.map(
          (f) => `            { label: ${quote(title(f.name))}, bind: ${quote(f.name)} },`,
        ),
        "            { label: 'Status', bind: 'state' },",
        '          ],',
        '        },',
        '      ],',
        '    },',
        '  },',
      ].join('\n'),
      'the print template (documents)',
    );
    if (!/import \{[^}]*\bemitting\b[^}]*\} from 'shutro-erp';/.test(text))
      text = text.replace(
        "import { orm } from 'shutro-erp/orm';",
        "import { emitting } from 'shutro-erp';\nimport { orm } from 'shutro-erp/orm';",
      );
  } else {
    if (new RegExp(`^ {8}${name}: `, 'm').test(text)) {
      write(`${target} has a transition ${name} already.\n`);
      return 1;
    }
    for (const s of [values.from, values.to])
      if (!new RegExp(`^ {8}${s}: '`, 'm').test(text))
        add('states', `${s}: ${quote(title(s))},`, 'the state’s states');
    add('transitions', transition, 'the state’s transitions');
    add('buttons', `k.button(${quote(name)}, { label: ${quote(button)} }),`, 'the form’s buttons');
  }
  if (!text.includes(`topic: ${quote(topic)}`)) add('events', event, 'the events');
  if (group !== undefined) {
    if (!/^export const permissions\b/m.test(text))
      text = `${text.replace(/\n*$/, '\n')}\nexport const permissions = [\n  // make:permissions\n];\n`;
    add(
      'permissions',
      `orm.definePermission({ code: ${quote(permission)}, label: ${quote(`${button} ${label.toLowerCase()}`)}, groups: [${quote(`${module}.${group}`)}] }),`,
      'the permissions',
    );
  }
  const dry = values['dry-run'] === true;
  if (!dry) await writeFile(path, text);
  write(
    `  ${dry ? 'would update' : 'updated'} ${rel} (${name}: ${values.from} to ${values.to}${group === undefined ? '' : `, for ${module}.${group} by the permission ${permission}`}${first ? '; now a document: state, status bar, chatter, print template, event' : ''})\n`,
  );
  await syncParts(join(cwd, 'src', 'modules', module), dry);
  await rewire(join(cwd, 'src', 'modules', module), module, dry, write);
  if (byHand.length > 0) write(`  a marker is gone there; add by hand:\n${byHand.join('\n')}\n`);
  if (first) {
    // A document's users discuss it and print it: the module depends on Messaging and Reporting, and its users
    // hold their roles — as the shipped apps do.
    const indexPath = join(cwd, 'src', 'modules', module, 'index.ts');
    const index = existsSync(indexPath) ? await readFile(indexPath, 'utf8') : '';
    const wired = wireDocument(index, module);
    if (wired === null) write(DOCUMENT_BY_HAND(module));
    else if (wired !== index) {
      if (!dry) await writeFile(indexPath, wired);
      write(
        `  ${dry ? 'would update' : 'updated'} src/modules/${module}/index.ts (depends on Messaging and Reporting; ${module}.user holds their roles)\n`,
      );
    }
  }
  if (!dry) write('\nNext: shutro-erp check, then shutro-erp migrate (it plans the new column).\n');
  return 0;
}

async function makeReport(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      by: { type: 'string' },
      measure: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [target] = positionals;
  const dot = target?.lastIndexOf('.') ?? -1;
  if (target === undefined || dot <= 0) {
    write(USAGE);
    return 2;
  }
  const module = target.slice(0, dot);
  const model = target.slice(dot + 1);
  const dir = join(cwd, 'src', 'modules', module);
  const rel = `src/modules/${module}/parts/${model}.ts`;
  const path = join(dir, 'parts', `${model}.ts`);
  if (!existsSync(path)) {
    write(`There is no ${rel}: make report adds to models made by shutro-erp make model.\n`);
    return 1;
  }
  let text = await readFile(path, 'utf8');
  const id = /defineModel\('([^']+)'/.exec(text)?.[1] ?? `${module}.${model}`;
  const constant = /export const ([A-Za-z0-9_]+) = defineModel/.exec(text)?.[1];
  if (constant === undefined) {
    write(`${rel} declares no model with defineModel.\n`);
    return 1;
  }
  if (text.includes(`'${id}.pivot'`)) {
    write(`${target} has a pivot already.\n`);
    return 1;
  }
  const fields = declaredFields(text);
  const kindOf = (name: string) => fields.find((f) => f.name === name)?.kind;
  const grouped = (name: string) =>
    ['date', 'datetime'].includes(kindOf(name) ?? '') ? `${name}:month` : name;
  const by =
    values.by ??
    fields.find((f) => f.kind === 'state')?.name ??
    fields.find((f) => f.kind === 'selection')?.name ??
    fields.find((f) => f.kind === 'many2one')?.name ??
    fields.find((f) => f.kind === 'date' || f.kind === 'datetime')?.name;
  if (by === undefined || kindOf(by) === undefined) {
    write(
      by === undefined
        ? `${target} has no state, selection, relation or date to group by: add one, or name a field with --by.\n`
        : `${target} has no field ${by}.\n`,
    );
    return 1;
  }
  if (
    values.measure !== undefined &&
    !['integer', 'decimal'].includes(kindOf(values.measure) ?? '')
  ) {
    write(
      `--measure names a number of ${target} (an integer or a decimal), which ${values.measure} is not.\n`,
    );
    return 1;
  }
  const measure =
    values.measure === undefined ? '{ count: true }' : `{ sum: ${quote(values.measure)} }`;
  const byHand: string[] = [];
  const views = [
    `'${id}.pivot': pivot(${constant}, { rows: [${quote(grouped(by))}], measures: [${measure}] }),`,
    `'${id}.graph': graph(${constant}, { groupBy: [${quote(grouped(by))}], measure: ${measure} }),`,
  ].join('\n  ');
  const withViews = atMarker(text, 'views', views);
  if (withViews === null) byHand.push(`      the views: ${views.split('\n')[0]} …`);
  else text = withViews;
  if (text.includes("views: ['list', 'form'] })"))
    text = text.replace(
      "views: ['list', 'form'] })",
      "views: ['list', 'form', 'pivot', 'graph'] })",
    );
  else byHand.push("      the action's views: 'pivot', 'graph'");
  const imported = /import \{([^}]*)\} from 'shutro-erp\/views';/.exec(text);
  if (imported !== null)
    text = text.replace(
      imported[0],
      `import { ${[
        ...new Set([...(imported[1] ?? '').split(',').map((x) => x.trim()), 'graph', 'pivot']),
      ]
        .filter((x) => x !== '')
        .sort()
        .join(', ')} } from 'shutro-erp/views';`,
    );
  else byHand.push("      the import: graph and pivot from 'shutro-erp/views'");
  const dry = values['dry-run'] === true;
  if (!dry) await writeFile(path, text);
  write(
    `  ${dry ? 'would update' : 'updated'} ${rel} (a pivot and a chart by ${by}, ${values.measure === undefined ? 'counting records' : `summing ${values.measure}`})\n`,
  );
  if (byHand.length > 0) write(`  add by hand:\n${byHand.join('\n')}\n`);
  // Pivots and charts are Reporting's.
  const indexPath = join(dir, 'index.ts');
  const index = existsSync(indexPath) ? await readFile(indexPath, 'utf8') : '';
  const wired = wireDocument(index, module);
  if (wired === null) write(DOCUMENT_BY_HAND(module));
  else if (wired !== index) {
    if (!dry) await writeFile(indexPath, wired);
    write(
      `  ${dry ? 'would update' : 'updated'} src/modules/${module}/index.ts (depends on Messaging and Reporting; ${module}.user holds their roles)\n`,
    );
  }
  if (!dry) write('\nNext: shutro-erp check.\n');
  return 0;
}

/** A page of the module's own. */
function pageFile(module: string, name: string, label: string): string {
  const component = `${pascal(name)}Page`;
  return `/**
 * ${label}: a page of the ${module} module, made by \`shutro-erp make page\`. It is yours: the page asks the
 * server through \`api\` and shows what it answers (no business rules here — the server decides).
 */
import type { PageProps } from 'shutro-erp/ui';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/** The page's words, in English and Bangla (namespace \`${module}\`, under \`pages.${name}\`). */
export const messages = {
  en: { title: ${quote(label)}, intro: 'This page is yours: show here what the lists and forms do not.' },
  bn: { title: ${quote(label)}, intro: 'এই পাতাটি আপনার: তালিকা ও ফর্মে যা নেই তা এখানে দেখান।' },
};

export function ${component}(_props: PageProps): ReactElement {
  const { t } = useTranslation(${quote(module)});
  return (
    <div className="mx-auto grid max-w-4xl gap-2 p-4">
      <h1 className="text-xl font-semibold">{t(${quote(`pages.${name}.title`)})}</h1>
      <p className="text-sm text-muted-foreground">{t(${quote(`pages.${name}.intro`)})}</p>
    </div>
  );
}
`;
}

/** `web/index.ts`: the module's pages registered, and their words. Generated; rewritten by each `make page`. */
function webIndex(module: string, pages: readonly string[]): string {
  const id = camel(module);
  return `// Made by \`shutro-erp make\`: the pages in this folder, registered. Do not edit: run make page instead.
import type { Registry } from 'shutro-erp/ui';
${pages.map((p) => `import { ${pascal(p)}Page, messages as ${camel(p)}Messages } from './${pascal(p)}Page.tsx';`).join('\n')}

/** Registers the module's pages in the back-office (src/main.tsx). */
export function register${pascal(module)}Web(registry: Registry): Registry {
${pages.map((p) => `  registry.registerPage(${quote(`${module}.${pascal(p)}`)}, ${pascal(p)}Page);`).join('\n')}
  return registry;
}

/** The pages' words, by language. */
export const ${id}Messages = {
  en: { pages: { ${pages.map((p) => `${camel(p)}: ${camel(p)}Messages.en`).join(', ')} } },
  bn: { pages: { ${pages.map((p) => `${camel(p)}: ${camel(p)}Messages.bn`).join(', ')} } },
};
`;
}

/** The part of a page: its action and its menu. */
function pagePart(module: string, name: string, label: string): string {
  return `/** ${label}: the action and menu of a page of the ${module} module (web/${pascal(name)}Page.tsx). */
export const models = [];

export const actions = {
  '${module}.action_page_${name}': { type: 'client' as const, page: ${quote(`${module}.${pascal(name)}`)}, label: ${quote(label)} },
};

export const menus = [
  {
    id: '${module}.page_${name}',
    parent: '${module}.root',
    label: ${quote(label)},
    action: '${module}.action_page_${name}',
  },
];

export const views = {};

export const searches = {};

export const importTemplates = [];
`;
}

/** src/main.tsx with the module's web contribution registered, or null when its shape is not the starter's. */
export function wireWeb(main: string, module: string): string | null {
  const fn = `register${pascal(module)}Web`;
  if (main.includes(fn)) return main;
  const imports = [...main.matchAll(/^import .*;$/gm)];
  const last = imports.at(-1);
  const calls = [...main.matchAll(/^register[A-Za-z0-9]+Web\(registry\);$/gm)];
  const lastCall = calls.at(-1);
  const anchor = lastCall?.[0] ?? /^const registry = .*;$/m.exec(main)?.[0];
  if (last === undefined || anchor === undefined || !main.includes('messages={{ ')) return null;
  return main
    .replace('messages={{ ', `messages={{ ${camel(module)}: ${camel(module)}Messages, `)
    .replace(anchor, `${anchor}\n${fn}(registry);`)
    .replace(
      last[0],
      `${last[0]}\nimport { ${camel(module)}Messages, ${fn} } from './modules/${module}/web/index.ts';`,
    );
}

async function makePage(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { label: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
  const [module, name] = positionals;
  if (module === undefined || name === undefined) {
    write(USAGE);
    return 2;
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    write(`"${name}" cannot be a page's name: lower-case letters, digits and _, like shelf_map.\n`);
    return 2;
  }
  const dir = join(cwd, 'src', 'modules', module);
  if (!existsSync(join(dir, 'index.ts'))) {
    write(
      `There is no src/modules/${module}/index.ts: make the module first (shutro-erp module create ${module}).\n`,
    );
    return 1;
  }
  const pagePath = join(dir, 'web', `${pascal(name)}Page.tsx`);
  if (existsSync(pagePath)) {
    write(
      `src/modules/${module}/web/${pascal(name)}Page.tsx exists already and was left as it is.\n`,
    );
    return 1;
  }
  const label = values.label ?? title(name);
  const dry = values['dry-run'] === true;
  const said = dry ? 'would write' : 'wrote  ';
  const pages = [
    ...new Set([
      ...(existsSync(join(dir, 'web'))
        ? readdirSync(join(dir, 'web'))
            .filter((f) => f.endsWith('Page.tsx'))
            .map((f) => f.slice(0, -'Page.tsx'.length))
        : []),
      pascal(name),
    ]),
  ].sort();
  if (!dry) {
    await mkdir(join(dir, 'web'), { recursive: true });
    await mkdir(join(dir, 'parts'), { recursive: true });
    await writeFile(pagePath, pageFile(module, name, label));
    await writeFile(join(dir, 'web', 'index.ts'), webIndex(module, pages));
    await writeFile(join(dir, 'parts', `page_${name}.ts`), pagePart(module, name, label));
  }
  write(`  ${said} src/modules/${module}/web/${pascal(name)}Page.tsx\n`);
  write(
    `  ${said} src/modules/${module}/web/index.ts (${pages.length} page${pages.length === 1 ? '' : 's'})\n`,
  );
  write(`  ${said} src/modules/${module}/parts/page_${name}.ts (its action and menu)\n`);
  await syncParts(dir, dry, [`page_${name}`]);
  await rewire(dir, module, dry, write);
  const mainPath = join(cwd, 'src', 'main.tsx');
  const main = existsSync(mainPath) ? await readFile(mainPath, 'utf8') : null;
  const wired = main === null ? null : wireWeb(main, module);
  if (wired === null)
    write(
      `  in src/main.tsx, by hand:\n      import { ${camel(module)}Messages, register${pascal(module)}Web } from './modules/${module}/web/index.ts';\n      register${pascal(module)}Web(registry);\n      … messages={{ ${camel(module)}: ${camel(module)}Messages, … }}\n`,
    );
  else if (wired !== main) {
    if (!dry) await writeFile(mainPath, wired);
    write(`  ${dry ? 'would update' : 'updated'} src/main.tsx (the module's pages registered)\n`);
  }
  if (!dry) write("\nNext: npm run web, and open the page from the module's menu.\n");
  return 0;
}

/** How a module is imported by a bridge: one of yours, or an app of Shutro ERP. Null when it is neither. */
function moduleImport(
  cwd: string,
  name: string,
): { line: string; module: string; shutro: string } | null {
  if (existsSync(join(cwd, 'src', 'modules', name, 'index.ts')))
    return {
      line: `import { ${camel(name)}, ${camel(name)}Shutro } from '../${name}/index.ts';`,
      module: camel(name),
      shutro: `${camel(name)}Shutro`,
    };
  const app = (APPS as Readonly<Record<string, (typeof APPS)[AppName]>>)[name];
  if (app === undefined) return null;
  return {
    line: `import { ${app.server}, ${app.server}Shutro } from 'shutro-erp/${name}';`,
    module: app.server,
    shutro: `${app.server}Shutro`,
  };
}

async function makeBridge(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { 'dry-run': { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
  const [a, b] = positionals;
  if (a === undefined || b === undefined || a === b) {
    write(USAGE);
    return 2;
  }
  const first = moduleImport(cwd, a);
  const second = moduleImport(cwd, b);
  for (const [name, found] of [
    [a, first],
    [b, second],
  ] as const)
    if (found === null) {
      write(
        `"${name}" is neither a module of yours (src/modules/${name}/) nor an app of Shutro ERP.\n`,
      );
      return 1;
    }
  if (first === null || second === null) return 1;
  const name = `${a}_${b}`.replaceAll('-', '_');
  const dir = join(cwd, 'src', 'modules', name);
  if (existsSync(dir)) {
    write(`src/modules/${name} exists already.\n`);
    return 1;
  }
  const id = camel(name);
  const label = `${title(a)} with ${title(b)}`;
  const index = `/**
 * ${label}: the bridge between ${a} and ${b}, made by \`shutro-erp make bridge\`. Put here what one adds to the
 * other — an extension of a model (orm.extendModel), a field, a button, a stat tile. It is proposed when both are
 * installed, and neither depends on the other.
 */
import { defineModule } from 'shutro-erp/modules-sdk';
import { orm } from 'shutro-erp/orm';
${[first.line, second.line].sort().join('\n')}

export const ${id}Shutro = orm.defineModule({
  name: '${name}',
  version: '0.1.0',
  depends: [${first.shutro}, ${second.shutro}],
  groups: [
    orm.defineGroup({ code: '${name}.user', label: '${label}', implies: ['base.user'] }),
  ],
  models: [],
  extensions: [],
});

export const ${id} = defineModule({
  shutro: ${id}Shutro,
  kosh: '^0.1.0',
  depends: [${first.module}, ${second.module}],
  bridge: [${first.module}, ${second.module}],
  accessLevels: {
    user: { label: '${label}', groups: ['${name}.user'] },
  },
});
`;
  const dry = values['dry-run'] === true;
  if (!dry) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.ts'), index);
  }
  write(
    `  ${dry ? 'would write' : 'wrote  '} src/modules/${name}/index.ts (the bridge of ${a} and ${b})\n`,
  );
  const listPath = join(cwd, 'src', 'modules.ts');
  if (existsSync(listPath)) {
    const text = await readFile(listPath, 'utf8');
    const listed = /export const modules = \[([^\]]*)\];/.exec(text);
    const imports = [...text.matchAll(/^import .*;$/gm)];
    const last = imports.at(-1);
    if (listed !== null && last !== undefined) {
      if (!dry)
        await writeFile(
          listPath,
          text
            .replace(
              listed[0],
              `export const modules = [${(listed[1] ?? '').trim().replace(/,$/, '')}, ${id}];`,
            )
            .replace(last[0], `${last[0]}\nimport { ${id} } from './modules/${name}/index.ts';`),
        );
      write(`  ${dry ? 'would update' : 'updated'} src/modules.ts (${id} added)\n`);
    } else write(`  add ${id} to the modules list in src/modules.ts\n`);
  }
  if (!dry) write(`\nNext: shutro-erp apps install ${name}\n`);
  return 0;
}

export async function runMake(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const [what, ...rest] = argv;
  try {
    if (what === 'model') return await makeModel(rest, write, cwd);
    if (what === 'field') return await makeField(rest, write, cwd);
    if (what === 'transition') return await makeTransition(rest, write, cwd);
    if (what === 'action') return await makeTransition(rest, write, cwd, true);
    if (what === 'report') return await makeReport(rest, write, cwd);
    if (what === 'page') return await makePage(rest, write, cwd);
    if (what === 'bridge') return await makeBridge(rest, write, cwd);
  } catch (error) {
    // An option the command does not have.
    write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  write(USAGE);
  return what === '--help' || what === 'help' ? 0 : 2;
}
