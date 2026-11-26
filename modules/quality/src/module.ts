/**
 * The data layer of Quality (RFC 0038 §4): **control points** say what is checked — for which products, on which
 * operation, from which vendor, how often —, **checks** are the checks to do on a document, made by the server
 * from the points that apply and decided once, and **alerts** are the problems found, closed with their root cause
 * and what was done about it.
 *
 * A measure decides itself: within the tolerances it passes, outside it fails — the verdict that does not match
 * the value is refused. A photo check passes with its photo. A decided check is done again, or a failed one
 * released, by a Quality manager only, with the reason kept.
 *
 * Other apps ask for the checks of their documents with `checksFor` and are held by `blockingChecks`; Quality
 * imports none of them.
 */

import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import { check, defineModel, defineModule, type Env, f, records } from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;

export const CHECK_KINDS = {
  pass_fail: 'Pass or fail',
  measure: 'A measure within tolerances',
  checklist: 'A checklist',
  photo: 'A photo',
} as const;

export const OPERATIONS = {
  any: 'Any operation',
  receipt: 'Receipt',
  delivery: 'Delivery',
  internal: 'Internal move',
  production: 'Production',
} as const;
export type Operation = Exclude<keyof typeof OPERATIONS, 'any'>;

export const QualityPoint = defineModel('quality.point', {
  label: 'Control point',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'quality.user': READ, 'quality.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, label: 'Title' }),
    kind: f.selection(CHECK_KINDS, {
      required: true,
      default: 'pass_fail',
      label: 'What is checked',
      help: 'Pass or fail by the checker; a measure decides itself by its tolerances; a checklist is ticked through; a photo is taken.',
    }),
    product: f.many2one('product.product', {
      ondelete: 'cascade',
      label: 'Product',
      help: 'Only this product; empty: every product of the category, or every product.',
    }),
    category: f.many2one('product.category', {
      ondelete: 'cascade',
      label: 'Product category',
      help: 'Only products of this category; empty with no product: every product.',
    }),
    operation: f.selection(OPERATIONS, {
      required: true,
      default: 'receipt',
      label: 'On',
      help: 'The operation the check belongs to: goods coming in, going out, moving inside, or made.',
    }),
    partner: f.many2one('res.partner', {
      ondelete: 'cascade',
      label: 'Only from',
      help: 'Only when the operation is with this vendor or customer; empty: whoever it is with.',
    }),
    every: f.integer({
      required: true,
      default: 1,
      label: 'One in',
      help: '1: every operation is checked; 5: one operation in five.',
    }),
    /** How many operations the point applied to: one in `every` of them gets a check. */
    seen: f.integer({ required: true, default: 0, groups: { write: [...SYSTEM] } }),
    instructions: f.text({
      label: 'Instructions',
      help: 'What to look at and how; for a checklist, one thing to tick per line.',
    }),
    unit: f.char({ size: 20, label: 'Unit', help: 'Of the measure: mm, °C, %, kg.' }),
    low: f.decimal({
      scale: 4,
      label: 'At least',
      help: 'The measure fails below this; empty: no lower limit.',
    }),
    high: f.decimal({
      scale: 4,
      label: 'At most',
      help: 'The measure fails above this; empty: no upper limit.',
    }),
  },
  sqlConstraints: {
    every: { check: orm.sql`every >= 1`, message: 'One operation in at least one is checked.' },
    tolerances: {
      check: orm.sql`low IS NULL OR high IS NULL OR low <= high`,
      message: 'The lower tolerance is not above the upper one.',
    },
    measured: {
      check: orm.sql`kind <> 'measure' OR low IS NOT NULL OR high IS NOT NULL`,
      message: 'A measure needs at least one tolerance.',
    },
  },
});

const CHECK_DECIDES =
  'A decided check is done again, or a failed one released, by a Quality manager — with the reason.';

/** The checks among `records` whose verdict does not agree with what was recorded. */
async function wrongVerdict(records: unknown, verdict: 'passed' | 'failed'): Promise<number[]> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  const failing: number[] = [];
  for (const c of await env
    .model('quality.check')
    .browse([...ids] as never)
    .load({ point: true })) {
    if (c.kind === 'measure') {
      // The value decides, not the checker.
      if (c.measure === null) failing.push(c.id as number);
      else if (within(c.measure, c.point.low, c.point.high) !== (verdict === 'passed'))
        failing.push(c.id as number);
    } else if (c.kind === 'photo' && verdict === 'passed' && c.photo === null)
      failing.push(c.id as number);
  }
  return failing;
}

/** Whether a measure is within its tolerances (a missing one does not limit). */
export function within(value: Decimal, low: Decimal | null, high: Decimal | null): boolean {
  return (low === null || value.gte(low)) && (high === null || value.lte(high));
}

export const QualityCheck = defineModel('quality.check', {
  label: 'Quality check',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'measure', 'released', 'reason'],
  access: {
    'quality.user': ['read', 'write'],
    'quality.manager': [...ALL, 'export'],
  },
  fields: {
    name: f.char({ required: true, sequence: 'quality.check', label: 'Reference' }),
    point: f.many2one('quality.point', { required: true, ondelete: 'restrict', index: true }),
    title: f.char({ label: 'What to check' }),
    kind: f.selection(CHECK_KINDS, {
      required: true,
      default: 'pass_fail',
      label: 'Kind',
      help: 'From the control point, as it was when the check was made.',
      groups: { write: [...SYSTEM] },
    }),
    operation: f.selection(OPERATIONS, {
      label: 'On',
      help: 'The operation the check belongs to.',
      groups: { write: [...SYSTEM] },
    }),
    product: f.many2one('product.product', { ondelete: 'restrict', index: true }),
    lot: f.char({ label: 'Lot or serial number' }),
    partner: f.many2one('res.partner', {
      ondelete: 'set null',
      index: true,
      label: 'Vendor or customer',
    }),
    /** The document the check is for: a transfer, a production order. */
    resModel: f.char({ size: 80, label: 'Document type', groups: { write: [...SYSTEM] } }),
    resId: f.integer({ label: 'Document id', groups: { write: [...SYSTEM] } }),
    resName: f.char({ label: 'Document', groups: { write: [...SYSTEM] } }),
    measure: f.decimal({
      scale: 4,
      label: 'Measured',
      help: 'What was measured: within the point’s tolerances the check passes, outside it fails.',
    }),
    photo: f.many2one('storage.attachment', { ondelete: 'set null', label: 'Photo' }),
    notes: f.text(),
    checkedBy: f.many2one('res.users', {
      ondelete: 'set null',
      label: 'Checked by',
      groups: { write: [...SYSTEM] },
    }),
    checkedAt: f.datetime({ label: 'Checked at', groups: { write: [...SYSTEM] } }),
    /** A failed check a manager let through: the document is no longer held by it. */
    released: f.boolean({
      default: false,
      label: 'Released',
      help: 'A failed check a Quality manager let through, with the reason: it no longer holds its document.',
      groups: { write: [...SYSTEM] },
    }),
    reason: f.char({
      label: 'Reason',
      help: 'Why a failed check was released, or a decided one done again (needed for both).',
    }),
    alert: f.many2one('quality.alert', { ondelete: 'set null', label: 'Alert' }),
    state: f.state({
      states: { todo: 'To do', passed: 'Passed', failed: 'Failed' },
      initial: 'todo',
      help: 'Decided once: passed or failed. A failed check holds its document until a manager releases it or it is done again.',
      transitions: {
        pass: emitting('quality.check.passed', {
          from: ['todo'],
          to: 'passed',
          guard: records('quality.check', (checks) => wrongVerdict(checks, 'passed')),
          message:
            'A measure passes by its value — record it, within the tolerances — and a photo check with its photo.',
          after: records('quality.check', (checks) => stamp(checks)),
        }),
        fail: emitting('quality.check.failed', {
          from: ['todo'],
          to: 'failed',
          guard: records('quality.check', (checks) => wrongVerdict(checks, 'failed')),
          message: 'A measure fails by its value: record it; within the tolerances it passes.',
          after: records('quality.check', async (checks) => {
            await stamp(checks);
            await raiseAlerts(checks);
          }),
        }),
        // Let through although it failed: by a manager, saying why.
        release: {
          from: ['failed'],
          to: 'failed',
          requires: 'quality.decide',
          guard: records('quality.check', (checks) => unexplained(checks)),
          message: CHECK_DECIDES,
          after: records('quality.check', async (checks) => {
            const env = checks.env as unknown as Env;
            await env.asSuperuser({ reason: 'a failed check released' }, (su) =>
              su
                .model('quality.check')
                .browse(checks.ids as never)
                .write({ released: true } as never),
            );
          }),
        },
        redo: {
          from: ['passed', 'failed'],
          to: 'todo',
          requires: 'quality.decide',
          guard: records('quality.check', (checks) => unexplained(checks)),
          message: CHECK_DECIDES,
          after: records('quality.check', async (checks) => {
            const env = checks.env as unknown as Env;
            await env.asSuperuser({ reason: 'a check done again' }, (su) =>
              su
                .model('quality.check')
                .browse(checks.ids as never)
                .write({ released: false, checkedBy: null, checkedAt: null } as never),
            );
          }),
        },
      },
    }),
  },
});

/** The checks among `records` without a reason. */
async function unexplained(records: unknown): Promise<number[]> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  return [
    ...(await env
      .model('quality.check')
      .browse([...ids] as never)
      .load(['reason'])),
  ]
    .filter((c) => (c.reason ?? '').trim() === '')
    .map((c) => c.id as number);
}

/** Who decided, and when. */
async function stamp(records: unknown): Promise<void> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  const who = env.uid;
  await env.asSuperuser({ reason: 'a check decided' }, (su) =>
    su
      .model('quality.check')
      .browse([...ids] as never)
      .write({ checkedBy: who, checkedAt: new Date() } as never),
  );
}

/** A failed check proposes its alert, once: the product, the lot, the vendor and what failed are on it. */
async function raiseAlerts(records: unknown): Promise<void> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  await env.asSuperuser({ reason: 'an alert for a failed check' }, async (su) => {
    for (const c of await su
      .model('quality.check')
      .browse([...ids] as never)
      .load({ point: true, product: true, partner: true, alert: true })) {
      if (c.alert !== null) continue;
      const measured =
        c.kind === 'measure' && c.measure !== null
          ? ` Measured ${c.measure.toString()}${c.point.unit ? ` ${c.point.unit}` : ''} (${
              c.point.low?.toString() ?? '…'
            } to ${c.point.high?.toString() ?? '…'}).`
          : '';
      const made = await su.model('quality.alert').create([
        {
          title: `${c.point.name}${c.product ? ` — ${c.product.name}` : ''}`,
          company: c.company.id,
          product: c.product?.id ?? null,
          lot: c.lot,
          partner: c.partner?.id ?? null,
          check: c.id,
          description: `Check ${c.name} failed${c.resName ? ` on ${c.resName}` : ''}.${measured}${
            c.notes ? ` ${c.notes}` : ''
          }`,
        } as never,
      ]);
      await su
        .model('quality.check')
        .browse([c.id])
        .write({ alert: made.ids[0] ?? null } as never);
    }
  });
}

export const QualityAlert = defineModel('quality.alert', {
  label: 'Quality alert',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'priority', 'responsible', 'rootCause', 'corrective'],
  access: {
    'quality.user': ['read', 'write', 'create'],
    'quality.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, sequence: 'quality.alert', label: 'Reference' }),
    title: f.char({ required: true }),
    product: f.many2one('product.product', { ondelete: 'restrict', index: true }),
    lot: f.char({ label: 'Lot or serial number' }),
    partner: f.many2one('res.partner', {
      ondelete: 'set null',
      index: true,
      label: 'Vendor or customer',
    }),
    check: f.many2one('quality.check', { ondelete: 'set null', label: 'From the check' }),
    priority: f.selection(
      { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
      { required: true, default: 'normal', help: 'How soon it must be dealt with.' },
    ),
    responsible: f.many2one('res.users', { ondelete: 'set null' }),
    description: f.text({ label: 'What was found' }),
    rootCause: f.text({
      label: 'Root cause',
      help: 'Why it happened: needed to resolve the alert.',
    }),
    corrective: f.text({
      label: 'Corrective action',
      help: 'What was done about what was found: needed to resolve the alert.',
    }),
    preventive: f.text({ label: 'Preventive action', help: 'What keeps it from happening again.' }),
    resolvedAt: f.datetime({ label: 'Resolved at', groups: { write: [...SYSTEM] } }),
    state: f.state({
      states: {
        new: 'New',
        investigating: 'Investigating',
        resolved: 'Resolved',
        cancelled: 'Cancelled',
      },
      initial: 'new',
      help: 'Investigated, then resolved with its root cause and the corrective action — by a Quality manager.',
      transitions: {
        investigate: { from: ['new'], to: 'investigating' },
        resolve: emitting('quality.alert.resolved', {
          from: ['new', 'investigating'],
          to: 'resolved',
          requires: 'quality.decide',
          guard: records('quality.alert', async (alerts) =>
            [...(await alerts.load(['rootCause', 'corrective']))]
              .filter(
                (a) => (a.rootCause ?? '').trim() === '' || (a.corrective ?? '').trim() === '',
              )
              .map((a) => a.id),
          ),
          message: 'Write the root cause and the corrective action first.',
          after: records('quality.alert', async (alerts) => {
            const env = alerts.env as unknown as Env;
            await env.asSuperuser({ reason: 'an alert resolved' }, (su) =>
              su
                .model('quality.alert')
                .browse(alerts.ids as never)
                .write({ resolvedAt: new Date() } as never),
            );
          }),
        }),
        cancel: { from: ['new', 'investigating'], to: 'cancelled', requires: 'quality.decide' },
        reopen: {
          from: ['resolved', 'cancelled'],
          to: 'investigating',
          requires: 'quality.decide',
        },
      },
    }),
  },
  constraints: {
    // Kept true after the fact too: a resolved alert does not lose its cause.
    explained: {
      ...check('quality.alert', ['state', 'rootCause', 'corrective'], (alerts) =>
        [...alerts]
          .filter(
            (a) =>
              a.state === 'resolved' &&
              ((a.rootCause ?? '').trim() === '' || (a.corrective ?? '').trim() === ''),
          )
          .map((a) => a.id),
      ),
      message: 'A resolved alert keeps its root cause and its corrective action.',
    },
  },
});

// ---- for the apps whose documents are checked

/** A line of a document: what is checked on it. */
export interface CheckedLine {
  readonly product: number;
  readonly lot?: string | null;
}

/** A document that asks for its checks. */
export interface CheckedDocument {
  readonly operation: Operation;
  readonly company: number;
  readonly partner: number | null;
  readonly resModel: string;
  readonly resId: number;
  readonly resName: string;
  readonly lines: readonly CheckedLine[];
}

/**
 * Makes the checks of a document (RFC 0038 §4.2): for each of its products, the control points that apply — the
 * operation, the product or its category, the vendor — get one check, **once** per point, document and product,
 * however often it is asked. A point checked one time in *n* counts the operations it applied to. Run as the
 * system. Returns how many checks were made.
 */
export async function checksFor(su: Env, doc: CheckedDocument): Promise<number> {
  const products = [...new Set(doc.lines.map((l) => l.product))];
  if (products.length === 0) return 0;
  const points = await (
    await su.model('quality.point').search({
      where: { active: true, operation: { in: ['any', doc.operation] } } as never,
      order: ['id asc'],
    })
  ).load({ product: true, category: true, partner: true });
  if (points.length === 0) return 0;
  const loaded = await su
    .model('product.product')
    .browse(products as never)
    .load({ category: true });
  const categoryOf = new Map<number, number | null>();
  for (const p of loaded)
    categoryOf.set(p.id as number, (p.category?.id as number | undefined) ?? null);
  const existing = new Set(
    [
      ...(await (
        await su.model('quality.check').search({
          where: { resModel: doc.resModel, resId: doc.resId } as never,
        })
      ).load(['point', 'product'])),
    ].map((c) => `${c.point.id}|${c.product?.id ?? 0}`),
  );
  const toMake: Record<string, unknown>[] = [];
  for (const point of points) {
    if (point.partner !== null && point.partner.id !== doc.partner) continue;
    const mine = products.filter(
      (product) =>
        (point.product === null || point.product.id === product) &&
        (point.category === null || point.category.id === categoryOf.get(product)) &&
        !existing.has(`${point.id}|${product}`),
    );
    if (mine.length === 0) continue;
    // One operation in `every`: the first, then every n-th the point applies to.
    const seen = point.seen ?? 0;
    await su
      .model('quality.point')
      .browse([point.id])
      .write({ seen: seen + 1 } as never);
    if (seen % Math.max(1, point.every) !== 0) continue;
    for (const product of mine)
      toMake.push({
        point: point.id,
        title: point.name,
        kind: point.kind,
        operation: doc.operation,
        company: doc.company,
        product,
        lot: doc.lines.find((l) => l.product === product)?.lot ?? null,
        partner: doc.partner,
        resModel: doc.resModel,
        resId: doc.resId,
        resName: doc.resName,
      });
  }
  if (toMake.length > 0) await su.model('quality.check').create(toMake as never);
  await su.flush();
  return toMake.length;
}

/** The checks that hold a document: still to do, or failed and not released. */
export async function blockingChecks(
  su: Env,
  resModel: string,
  resId: number,
): Promise<{ id: number; name: string; title: string; state: string }[]> {
  return [
    ...(await su.model('quality.check').search({
      where: {
        resModel,
        resId,
        or: [{ state: 'todo' }, { state: 'failed', released: false }],
      } as never,
      order: ['id asc'],
    })),
  ].map((c) => ({
    id: c.id as number,
    name: c.name,
    title: c.title ?? '',
    state: c.state,
  }));
}

export const qualityShutro = defineModule({
  name: 'quality',
  version: '0.1.0',
  depends: [contactsShutro, productShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'quality.user',
      label: 'Quality: checks and alerts',
      implies: ['product.user'],
    }),
    orm.defineGroup({
      code: 'quality.manager',
      label: 'Quality manager',
      implies: ['quality.user'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'quality.decide',
      label: 'Release failed checks, redo checks, close alerts',
      groups: ['quality.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'quality.check',
      prefix: 'QC/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
    orm.defineSequence({
      code: 'quality.alert',
      prefix: 'QA/{year}/',
      padding: 4,
      reset: 'yearly',
    }),
  ],
  models: [QualityPoint, QualityCheck, QualityAlert],
});
