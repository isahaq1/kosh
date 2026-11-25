/**
 * How much of each model the activity log records, from the registry the server builds (Shutro tracks every
 * stored field that is set; `packages/server/src/audit-scope.ts` says what is left out):
 * `node --experimental-transform-types --no-warnings --import ./scripts/source-loader.mjs --conditions=@kosh/source scripts/tracking-report.ts`
 * Prints the models that record nothing — each should be a queue, a log, a sign-in internal or private —, and how
 * many of the stored fields of the others are tracked.
 */

import { demoCatalogue } from '../apps/demo/src/catalogue.ts';
import { buildKoshRegistry } from '../packages/server/src/index.ts';

interface FieldLike {
  readonly kind: string;
  readonly store?: boolean;
  readonly computed?: boolean;
}
interface ModelLike {
  readonly name: string;
  readonly tracking: readonly string[];
  readonly fields: Readonly<Record<string, FieldLike & { readonly tracking?: boolean }>>;
}
const SYSTEM = new Set(['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']);
const { registry } = buildKoshRegistry(demoCatalogue(), { security: { enforce: false } });
const models = [
  ...(registry as unknown as { models: ReadonlyMap<string, { model: ModelLike; module: string }> })
    .models,
];
let fields = 0;
let trackedFields = 0;
const none = new Map<string, string[]>();
for (const [name, { model, module }] of models) {
  let tracked = 0;
  for (const [key, field] of Object.entries(model.fields)) {
    if (SYSTEM.has(key) || field.kind === 'one2many' || field.kind === 'many2many') continue;
    if (field.store === false || field.computed === true) continue;
    fields += 1;
    if (field.tracking === true || model.tracking.includes(key)) tracked += 1;
  }
  trackedFields += tracked;
  if (tracked === 0) none.set(module, [...(none.get(module) ?? []), name]);
}
const silent = [...none.values()].reduce((n, names) => n + names.length, 0);
process.stdout.write(
  `models ${models.length}: ${models.length - silent} log their activity, ${silent} left out\n` +
    `fields a person or a rule sets ${fields}: ${trackedFields} tracked (${Math.round((trackedFields / fields) * 100)} %)\n` +
    'left out:\n',
);
for (const [module, names] of [...none].sort())
  process.stdout.write(`  ${module}: ${names.join(', ')}\n`);
