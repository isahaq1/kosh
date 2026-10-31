/**
 * The module standard (RFC 0023): every module in `modules/` is measured against the rules of §3, and `pnpm lint`
 * fails when an enforced rule is broken by a model the module has not waived (`standard: { waive: [...] }` in the
 * manifest, with a reason). Rules not yet enforced are reported, so the gaps stay visible.
 *
 *   node --import ./scripts/source-loader.mjs --conditions=@kosh/source scripts/check-modules.ts [--all]
 *
 * `--all` prints every rule's result, met or not.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type M = Record<string, unknown>;
interface Waiver {
  readonly rule: string;
  readonly model?: string;
  readonly reason: string;
}
interface Model {
  readonly module: string;
  readonly name: string;
  readonly fields: Readonly<Record<string, M>>;
  /** A document: it has a state field (`f.state`). */
  readonly hasState: boolean;
  /** A line or sub-record: it belongs to a parent (`ondelete: 'cascade'`), shown and imported with it. */
  readonly isLine: boolean;
  readonly hasName: boolean;
  readonly archivable: boolean;
  readonly tracking: readonly string[];
  readonly label: string | undefined;
  readonly isPrivate: boolean;
}

const root = join(fileURLToPath(import.meta.url), '..', '..');
const all = process.argv.includes('--all');

/** The rules `pnpm lint` enforces today; the others are reported (RFC 0023 §5 switches them on step by step). */
const ENFORCED = new Set(['M1', 'M2', 'M3', 'M4', 'V1']);
const RULES: Readonly<Record<string, string>> = {
  M1: 'every model has a label',
  M2: 'every model with a list view has a search spec',
  M3: 'master data (referred to, no state) is archivable',
  M4: 'documents (a state) have a chatter and track their state',
  M5: 'state, selection and computed-amount fields have help',
  V1: 'every public model has a list and a form',
  P1: 'every document model has a print template',
  I1: 'every master and document model has an import template',
  E1: 'every document model emits named events',
  A1: 'every app has an overview and demo data',
  T1: 'every module ships Bangla for its labels',
};

/** A manifest: what `defineModule` returns (the Shutro module, a name, a version, dependencies). */
const isManifest = (value: unknown): value is M =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as M)['name'] === 'string' &&
  typeof (value as M)['version'] === 'string' &&
  Array.isArray((value as M)['depends']) &&
  typeof (value as M)['shutro'] === 'object';

// Every module on disk, through its package entry (`modules/<name>/src/index.ts`), with its dependencies.
const onDisk = existsSync(join(root, 'modules')) ? readdirSync(join(root, 'modules')).sort() : [];
const byName = new Map<string, M>();
const missing: string[] = [];
const collect = (m: M): void => {
  if (byName.has(m['name'] as string)) return;
  byName.set(m['name'] as string, m);
  for (const d of (m['depends'] as M[]) ?? []) collect(d);
  for (const d of (m['bridge'] as M[] | undefined) ?? []) collect(d);
};
for (const name of onDisk) {
  const entry = join(root, 'modules', name, 'src', 'index.ts');
  if (!existsSync(entry)) continue;
  const exported = (await import(`../modules/${name}/src/index.ts`)) as Record<string, unknown>;
  const manifests = Object.values(exported).filter(isManifest);
  if (manifests.length === 0) missing.push(name);
  for (const m of manifests) collect(m);
}
const catalogue = [...byName.values()];
const modules = catalogue.filter((m) => onDisk.includes(m['name'] as string));

// ---- the models of the modules under check, and what refers to them.
const models: Model[] = [];
for (const m of modules) {
  const shutro = m['shutro'] as M | undefined;
  const priv = new Set((m['privateModels'] as string[] | undefined) ?? []);
  for (const model of (shutro?.['models'] as M[] | undefined) ?? []) {
    const fields = (model['fields'] as Readonly<Record<string, M>> | undefined) ?? {};
    models.push({
      module: m['name'] as string,
      name: model['name'] as string,
      fields,
      hasState: Object.entries(fields).some(
        ([key, d]) => d['kind'] === 'state' || (key === 'state' && d['kind'] === 'selection'),
      ),
      isLine: Object.values(fields).some(
        (d) => d['kind'] === 'many2one' && d['ondelete'] === 'cascade',
      ),
      hasName: 'name' in fields || typeof model['recName'] === 'string',
      archivable: model['archivable'] === true || 'active' in fields,
      tracking: Array.isArray(model['tracking']) ? (model['tracking'] as string[]) : [],
      label: typeof model['label'] === 'string' ? model['label'] : undefined,
      isPrivate: priv.has(model['name'] as string),
    });
  }
}
const referred = new Set<string>();
for (const m of catalogue)
  for (const model of ((m['shutro'] as M | undefined)?.['models'] as M[] | undefined) ?? [])
    for (const d of Object.values((model['fields'] as Record<string, M> | undefined) ?? {}))
      if (d['kind'] === 'many2one' && typeof d['target'] === 'string') referred.add(d['target']);

/** Master data: named, referred to by other records, neither a document nor a line. */
const isMaster = (model: Model) =>
  !model.hasState && !model.isLine && model.hasName && referred.has(model.name) && !model.isPrivate;
/** A document the user works on as such, not a line of one. */
const isDocument = (model: Model) => model.hasState && !model.isPrivate && !model.isLine;

// ---- the rules.
interface Finding {
  readonly rule: string;
  readonly module: string;
  readonly model: string | null;
  readonly detail: string;
}
const findings: Finding[] = [];
const fail = (rule: string, module: string, model: string | null, detail: string) =>
  findings.push({ rule, module, model, detail });

for (const m of modules) {
  const name = m['name'] as string;
  const views = Object.values((m['views'] as Record<string, M> | undefined) ?? {});
  const search = (m['search'] as M | undefined) ?? {};
  const documents = ((m['documents'] as M[] | undefined) ?? []).map((d) => d['model'] as string);
  const imports = ((m['importTemplates'] as M[] | undefined) ?? []).map(
    (d) => d['model'] as string,
  );
  const events = ((m['events'] as M[] | undefined) ?? []).map((d) => d['model'] as string);
  for (const model of models.filter((x) => x.module === name)) {
    const mine = views.filter((v) => v['model'] === model.name);
    const types = new Set(mine.map((v) => v['type'] as string));
    const forms = mine.filter((v) => v['type'] === 'form');
    if (model.label === undefined) fail('M1', name, model.name, 'no label');
    if (types.has('list') && search[model.name] === undefined)
      fail('M2', name, model.name, 'a list view without a search spec');
    if (isMaster(model) && !model.archivable)
      fail('M3', name, model.name, 'referred to by other records, not archivable');
    if (isDocument(model)) {
      if (forms.length > 0 && !forms.some((f) => f['chatter'] === true))
        fail('M4', name, model.name, 'a document form without a chatter');
      if (!model.tracking.includes('state'))
        fail('M4', name, model.name, 'the state is not tracked');
      if (!documents.includes(model.name)) fail('P1', name, model.name, 'no print template');
      if (!events.includes(model.name)) fail('E1', name, model.name, 'no named event');
    }
    if (!model.isPrivate && !model.isLine && (!types.has('list') || !types.has('form')))
      fail('V1', name, model.name, `views: ${[...types].join(', ') || 'none'}`);
    if ((isMaster(model) || isDocument(model)) && !imports.includes(model.name))
      fail('I1', name, model.name, 'no import template');
    for (const [key, d] of Object.entries(model.fields)) {
      const amount =
        (d['kind'] === 'monetary' || d['kind'] === 'decimal') && d['computed'] === true;
      if (
        (d['kind'] === 'state' || d['kind'] === 'selection' || amount) &&
        typeof d['help'] !== 'string'
      )
        fail('M5', name, model.name, `${key} has no help`);
    }
  }
  if (m['app'] !== undefined) {
    const hooks = (m['hooks'] as M | undefined) ?? {};
    if (m['overview'] === undefined) fail('A1', name, null, 'no overview');
    if (hooks['demo'] === undefined) fail('A1', name, null, 'no demo data');
  }
  if (m['i18n'] === undefined || !('bn' in (m['i18n'] as M))) fail('T1', name, null, 'no Bangla');
}

// ---- waivers: a finding the module explains is not a failure.
const waived: (Finding & { readonly reason: string })[] = [];
const open = findings.filter((f) => {
  const m = modules.find((x) => x['name'] === f.module);
  const waivers = ((m?.['standard'] as M | undefined)?.['waive'] as Waiver[] | undefined) ?? [];
  const w = waivers.find(
    (x) => x.rule === f.rule && (x.model === undefined || x.model === f.model),
  );
  if (w !== undefined) waived.push({ ...f, reason: w.reason });
  return w === undefined;
});

// ---- the report.
const lines: string[] = [];
let broken = 0;
for (const [rule, text] of Object.entries(RULES)) {
  const mine = open.filter((f) => f.rule === rule);
  const enforced = ENFORCED.has(rule);
  if (mine.length === 0) {
    if (all) lines.push(`${rule} ${text}: met${enforced ? '' : ' (not enforced yet)'}`);
    continue;
  }
  if (enforced) broken += mine.length;
  lines.push(`${rule} ${text}: ${mine.length} ${enforced ? 'FAILING' : 'open (reported)'}`);
  if (enforced || all)
    for (const f of mine) lines.push(`    ${f.module}: ${f.model ?? '(module)'} — ${f.detail}`);
}
if (waived.length > 0 && all) {
  lines.push(`waived: ${waived.length}`);
  for (const w of waived)
    lines.push(`    ${w.rule} ${w.module}: ${w.model ?? '(module)'} — ${w.reason}`);
}
if (missing.length > 0) lines.push(`no manifest exported by src/index.ts: ${missing.join(', ')}`);
process.stdout.write(
  `check-modules: ${modules.length} modules, ${models.length} models, ${open.length} open findings, ${waived.length} waived\n`,
);
process.stdout.write(`${lines.join('\n')}\n`);
if (broken > 0 || missing.length > 0) {
  process.stderr.write(
    `check-modules: ${broken} failing finding(s) of enforced rules${missing.length > 0 ? `; ${missing.length} module(s) without a manifest` : ''}. Fix them or waive them with a reason (RFC 0023).\n`,
  );
  process.exit(1);
}
