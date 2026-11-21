/**
 * How much of each model the audit trail records (Shutro tracks the fields a model names, and state fields):
 * `node --experimental-transform-types --no-warnings --import ./scripts/source-loader.mjs --conditions=@kosh/source scripts/tracking-report.ts`
 * Prints the models with no tracked field at all — nothing of them is logged, not even a creation or a deletion —
 * and, for the others, how many of their stored fields are tracked.
 */
import { demoCatalogue } from '../apps/demo/src/catalogue.ts';

const catalogue = demoCatalogue();

interface FieldLike {
  readonly kind: string;
  readonly tracking?: boolean;
  readonly store?: boolean;
  readonly compute?: unknown;
}
interface ModelLike {
  readonly name: string;
  readonly tracking?: readonly string[];
  readonly fields: Readonly<Record<string, FieldLike>>;
}
const SYSTEM = new Set(['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']);
const seen = new Map<string, { module: string; tracked: number; own: number }>();
for (const module of catalogue) {
  const shutro = (module as { shutro?: { name: string; models?: readonly ModelLike[] } }).shutro;
  for (const model of shutro?.models ?? []) {
    let tracked = 0;
    let own = 0;
    for (const [key, field] of Object.entries(model.fields)) {
      if (SYSTEM.has(key) || field.kind === 'one2many' || field.kind === 'many2many') continue;
      if (field.compute !== undefined && field.store !== true) continue;
      own += 1;
      if (field.tracking === true || (model.tracking ?? []).includes(key) || field.kind === 'state')
        tracked += 1;
    }
    seen.set(model.name, { module: shutro?.name ?? '?', tracked, own });
  }
}
const none = [...seen].filter(([, m]) => m.tracked === 0);
const some = [...seen].filter(([, m]) => m.tracked > 0);
const fields = [...seen.values()].reduce((n, m) => n + m.own, 0);
const trackedFields = [...seen.values()].reduce((n, m) => n + m.tracked, 0);
process.stdout.write(
  `models ${seen.size}: ${none.length} with nothing tracked, ${some.length} with something\n` +
    `stored fields ${fields}: ${trackedFields} tracked (${Math.round((trackedFields / fields) * 100)} %)\n`,
);
const byModule = new Map<string, string[]>();
for (const [name, m] of none) byModule.set(m.module, [...(byModule.get(m.module) ?? []), name]);
for (const [module, names] of [...byModule].sort())
  process.stdout.write(`  ${module}: ${names.join(', ')}\n`);
