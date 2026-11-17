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
 * Nothing is overwritten: a part that exists is refused. `--dry-run` shows what would be written.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `Usage: shutro-erp make <model | field | transition> …

  make model <module> <name> --fields "<field> <field> …" [--label <Label>] [--plural <Labels>] [--dry-run]
      A model of src/modules/<module>/ as a part of its own: the model with its label and access, its action and
      menu, list, form, search and import template — meeting the module standard (shutro-erp check).

  make field <module>.<model> <field> [--dry-run]
      A field added to a model made by make model: on the model, its list, its form and its import template.

  make transition <module>.<model> <name> --from <state> --to <state> [--label <Button>] [--dry-run]
      A step of the model's state (confirm: draft to confirmed). The first makes the model a document: its state,
      the status bar and the button, a chatter, a print template and a named event; the next ones add to them.

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
`;
}

/** `parts.ts`: every part in `parts/`, merged. Generated; rewritten by each `make model`. */
export function partsIndex(names: readonly string[]): string {
  const id = (name: string) => camel(name);
  const spread = (key: string, open: string, close: string) =>
    `  ${key}: ${open}${names.map((p) => `...${id(p)}.${key}`).join(', ')}${close},\n`;
  return `// Made by \`shutro-erp make\`: the parts in ./parts/, merged. Do not edit: run a make command instead.
${names.map((p) => `import * as ${id(p)} from './parts/${p}.ts';`).join('\n')}

export const parts = {
${spread('models', '[', ']')}${spread('actions', '{ ', ' }')}${spread('menus', '[', ']')}${spread('views', '{ ', ' }')}${spread('searches', '{ ', ' }')}${spread('importTemplates', '[', ']')}${spread('documents', '[', ']')}${spread('events', '[', ']')}};
`;
}

/** The module's index.ts with its parts merged in, or null when its shape is not the scaffold's. */
export function wireParts(index: string): string | null {
  if (index.includes("from './parts.ts'")) return index;
  const imports = [...index.matchAll(/^import .*;$/gm)];
  const last = imports.at(-1);
  const models = /(\n {2}models: \[)([^\]]*)(\],)/.exec(index);
  const manifest = /= defineModule\(\{/.exec(index);
  const end = index.lastIndexOf('});');
  const sdk = /import \{([^}]*)\} from 'shutro-erp\/modules-sdk';/.exec(index);
  if (last === undefined || models === null || manifest === null || end < 0 || sdk === null)
    return null;
  let out = `${index.slice(0, end)}}));${index.slice(end + 3)}`;
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
  return out.replace(last[0], `${last[0]}\nimport { parts } from './parts.ts';`);
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
  if (existsSync(partPath)) {
    write(
      `src/modules/${module}/parts/${name}.ts exists already: add to it with shutro-erp make field ${module}.${name} <field>.\n`,
    );
    return 1;
  }
  const label = values.label ?? title(name);
  const names: ModelNames = {
    module,
    name,
    model: `${module.replaceAll('-', '_')}.${name}`,
    constant: pascal(name),
    label,
    plural: values.plural ?? plural(label),
  };
  const index = await readFile(indexPath, 'utf8');
  const wired = wireParts(index);
  const existing = existsSync(join(dir, 'parts'))
    ? readdirSync(join(dir, 'parts'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => f.slice(0, -3))
    : [];
  const all = [...new Set([...existing, name])].sort();
  const dry = values['dry-run'] === true;
  const said = dry ? 'would write' : 'wrote  ';
  if (!dry) {
    await mkdir(join(dir, 'parts'), { recursive: true });
    await writeFile(partPath, partFile(names, fields));
    await writeFile(join(dir, 'parts.ts'), partsIndex(all));
    if (wired !== null && wired !== index) await writeFile(indexPath, wired);
  }
  write(
    `  ${said} src/modules/${module}/parts/${name}.ts (${names.model}: ${fields.length} fields, list, form, search, import template)\n`,
  );
  write(
    `  ${said} src/modules/${module}/parts.ts (${all.length} part${all.length === 1 ? '' : 's'})\n`,
  );
  if (wired === null) write(BY_HAND);
  else if (wired !== index)
    write(
      `  ${dry ? 'would update' : 'updated'} src/modules/${module}/index.ts (its parts merged in)\n`,
    );
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
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      label: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [target, name] = positionals;
  const dot = target?.lastIndexOf('.') ?? -1;
  if (
    target === undefined ||
    name === undefined ||
    dot <= 0 ||
    values.from === undefined ||
    values.to === undefined
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
  const transition = `${name}: emitting(${quote(topic)}, { from: [${quote(values.from)}], to: ${quote(values.to)} }),`;
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
  const dry = values['dry-run'] === true;
  if (!dry) await writeFile(path, text);
  write(
    `  ${dry ? 'would update' : 'updated'} ${rel} (${name}: ${values.from} to ${values.to}${first ? '; now a document: state, status bar, chatter, print template, event' : ''})\n`,
  );
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
  } catch (error) {
    // An option the command does not have.
    write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  write(USAGE);
  return what === '--help' || what === 'help' ? 0 : 2;
}
