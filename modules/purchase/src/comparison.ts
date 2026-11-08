/**
 * Comparative statements (RFC 0032 §3.4, after Paragon's procurement chain): once an RFQ to vendors has its
 * responses, a buyer draws up a **comparative statement** — every RFQ line against every vendor who quoted: the
 * quantity to buy from them, the quoted price, two negotiation rounds, the final price, the total — selects lines
 * per vendor (several vendors may share an RFQ), submits it through the approval engine, and confirms it: one
 * purchase order per selected vendor at the final prices, linked to the request lines. When the RFQ asks for a
 * **technical comparison** first, an engineer scores each vendor and confirms it before the financial statement
 * may be submitted. The lowest final price of each line is marked.
 */
import { approvalGuard, requestApprovals } from '@kosh/permissions';
import { type Decimal, orm } from '@kosh/server/orm';
import { check, compute, defineModel, type Env, f, onchange, records } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero: Decimal = orm.toDecimal(0);

export const PurchaseTechnicalComparison = defineModel('purchase.technical.comparison', {
  label: 'Technical comparison',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'engineer'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    name: f.char({ required: true, sequence: 'purchase.technical.comparison', label: 'Reference' }),
    tender: f.many2one('purchase.tender', { required: true, ondelete: 'cascade', label: 'RFQ' }),
    engineer: f.many2one('res.users', {
      required: true,
      ondelete: 'restrict',
      default: (env: Env) => env.userId,
      label: 'Assigned engineer',
    }),
    kind: f.selection(
      { simple: 'Type A — simple (flat specifications)', detailed: 'Type B — detailed (criteria)' },
      {
        required: true,
        default: 'simple',
        label: 'CS type',
        help: 'Scored as a whole, or criterion by criterion.',
      },
    ),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    remarks: f.text(),
    lines: f.one2many('purchase.technical.comparison.line', 'comparison', {
      label: 'Vendors scored',
    }),
    state: f.state({
      states: {
        draft: 'Draft',
        submitted: 'Submitted',
        approved: 'Approved',
        confirmed: 'Confirmed',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      help: 'Drafted by the engineer, submitted, approved by a Purchase manager, confirmed: the financial comparison may then be submitted.',
      transitions: {
        /** Every vendor who quoted, to score. */
        fill: {
          from: ['draft'],
          to: 'draft',
          after: records('purchase.technical.comparison', async (comparisons) => {
            const env = comparisons.env as unknown as Env;
            for (const c of await comparisons.load({ lines: true, tender: true })) {
              await env
                .model('purchase.technical.comparison.line')
                .browse([...c.lines].map((l) => l.id))
                .unlink();
              const responses = await env
                .model('purchase.tender.response')
                .search({ where: { tender: c.tender.id, state: 'submitted' } });
              if (responses.ids.length > 0)
                await env.model('purchase.technical.comparison.line').create(
                  [...responses.ids].map((response) => ({
                    comparison: c.id,
                    response,
                    score: '0',
                  })) as never,
                );
            }
          }),
        },
        submit: {
          from: ['draft'],
          to: 'submitted',
          guard: records('purchase.technical.comparison', async (comparisons) =>
            [...(await comparisons.load({ lines: true }))]
              .filter((c) => c.lines.length === 0)
              .map((c) => c.id),
          ),
          message: 'Score the vendors first.',
        },
        approve: { from: ['submitted'], to: 'approved', requires: 'purchase.compare_approve' },
        confirm: {
          from: ['approved'],
          to: 'confirmed',
          after: records('purchase.technical.comparison', async (comparisons) => {
            // The ranks go onto the responses: 1 for the best score.
            const env = comparisons.env as unknown as Env;
            for (const c of await comparisons.load({ lines: { response: true } })) {
              const ranked = [...c.lines].sort((a, b) => Number(b.score) - Number(a.score));
              for (const [i, l] of ranked.entries())
                await env
                  .model('purchase.tender.response')
                  .browse([l.response.id])
                  .write({ technicalRank: i + 1 } as never);
            }
          }),
        },
        cancel: { from: ['draft', 'submitted', 'approved'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
});

export const PurchaseTechnicalComparisonLine = defineModel('purchase.technical.comparison.line', {
  label: 'Technical score',
  order: ['comparison desc', 'id asc'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    comparison: f.many2one('purchase.technical.comparison', {
      required: true,
      ondelete: 'cascade',
    }),
    response: f.many2one('purchase.tender.response', {
      required: true,
      ondelete: 'restrict',
      label: 'Vendor response',
    }),
    score: f.decimal({ scale: 2, required: true, default: '0', help: 'Out of 100.' }),
    meetsSpecifications: f.boolean({ default: true, label: 'Meets the specifications' }),
    note: f.char({ size: 300 }),
  },
  sqlConstraints: {
    range: {
      check: orm.sql`score >= 0 AND score <= 100`,
      message: 'A score is between 0 and 100.',
    },
  },
});

export const PurchaseComparison = defineModel('purchase.comparison', {
  label: 'Comparative statement',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amountTotal', 'expiryDate'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    name: f.char({ required: true, sequence: 'purchase.comparison', label: 'Reference' }),
    tender: f.many2one('purchase.tender', { required: true, ondelete: 'cascade', label: 'RFQ' }),
    date: f.date({ required: true, default: (env: Env) => env.today(), label: 'CS date' }),
    expiryDate: f.date({ label: 'Expiry date', help: 'The quoted prices hold until this day.' }),
    dateDelivery: f.date({ label: 'Delivery date' }),
    multiVendor: f.boolean({
      default: false,
      label: 'Several vendors',
      help: 'Lines may be awarded to different vendors; off, every selected line goes to one vendor.',
    }),
    note: f.text(),
    lines: f.one2many('purchase.comparison.line', 'comparison', { label: 'Comparison' }),
    amountTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Awarded total',
      help: 'The selected lines at their final prices.',
      ...compute(
        'purchase.comparison',
        'amountTotal',
        ['lines.selected', 'lines.total'],
        (comparisons) => {
          for (const c of comparisons)
            c.amountTotal = [...c.lines]
              .filter((l) => l.selected)
              .reduce((s, l) => s.plus(l.total ?? zero), zero);
        },
      ),
    }),
    state: f.state({
      states: {
        draft: 'Draft',
        submitted: 'Submitted',
        approved: 'Approved',
        confirmed: 'Confirmed',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      help: 'Drafted from the responses, negotiated, submitted for approval, approved, confirmed into purchase orders.',
      transitions: {
        /** The workspace: every RFQ line against every vendor who quoted, at the quoted prices. */
        fill: {
          from: ['draft'],
          to: 'draft',
          after: records('purchase.comparison', async (comparisons) => {
            const env = comparisons.env as unknown as Env;
            for (const c of await comparisons.load({
              lines: true,
              tender: { lines: true, responses: { lines: { tenderLine: true } } },
            })) {
              await env
                .model('purchase.comparison.line')
                .browse([...c.lines].map((l) => l.id))
                .unlink();
              const rows: Record<string, unknown>[] = [];
              for (const line of c.tender.lines)
                for (const r of c.tender.responses) {
                  if (r.state !== 'submitted') continue;
                  const quoted = [...r.lines].find((x) => x.tenderLine.id === line.id);
                  if (quoted === undefined) continue;
                  rows.push({
                    comparison: c.id,
                    tenderLine: line.id,
                    response: r.id,
                    csQty: line.quantity,
                    quote: quoted.priceUnit,
                    finalPrice: quoted.priceUnit,
                  });
                }
              if (rows.length > 0)
                await env.model('purchase.comparison.line').create(rows as never);
              if (c.dateDelivery === null && c.tender.dateDelivery !== null)
                await env
                  .model('purchase.comparison')
                  .browse([c.id])
                  .write({ dateDelivery: c.tender.dateDelivery } as never);
            }
          }),
        },
        submit: {
          from: ['draft'],
          to: 'submitted',
          guard: records('purchase.comparison', async (comparisons) => {
            const env = comparisons.env as unknown as Env;
            const out: number[] = [];
            for (const c of await comparisons.load({ lines: true, tender: true })) {
              const selected = [...c.lines].filter((l) => l.selected);
              if (selected.length === 0) {
                out.push(c.id);
                continue;
              }
              if (!c.multiVendor && new Set(selected.map((l) => l.response.id)).size > 1) {
                out.push(c.id);
                continue;
              }
              // A technical comparison, confirmed, comes first when the RFQ asks for one.
              if (c.tender.technical) {
                const done = await env.model('purchase.technical.comparison').search({
                  where: { tender: c.tender.id, state: 'confirmed' },
                  limit: 1,
                });
                if (done.length === 0) out.push(c.id);
              }
            }
            return out;
          }),
          message:
            'Select the lines to award (one vendor unless several are allowed); when the RFQ asks for a technical comparison, confirm it first.',
          after: records('purchase.comparison', async (comparisons) => {
            await requestApprovals(comparisons);
            for (const c of await comparisons.load({}))
              await comparisons.env.emit('purchase.comparison.submitted', { id: c.id });
          }),
        },
        approve: {
          from: ['submitted'],
          to: 'approved',
          guard: records('purchase.comparison', (comparisons) => approvalGuard(comparisons)),
          message: 'Waiting for approvals.',
        },
        reject: { from: ['submitted'], to: 'draft' },
        /** One purchase order per selected vendor at the final prices; the RFQ is ordered. */
        confirm: {
          from: ['approved'],
          to: 'confirmed',
          requires: 'purchase.request_buy',
          after: records('purchase.comparison', async (comparisons) => {
            const env = comparisons.env as unknown as Env;
            await env.flush();
            for (const id of comparisons.ids) await confirmComparison(env, id as number);
          }),
        },
        cancel: { from: ['draft', 'submitted', 'approved'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
});

export const PurchaseComparisonLine = defineModel('purchase.comparison.line', {
  label: 'Comparison line',
  order: ['comparison desc', 'tenderLine asc', 'id asc'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    comparison: f.many2one('purchase.comparison', { required: true, ondelete: 'cascade' }),
    tenderLine: f.many2one('purchase.tender.line', {
      required: true,
      ondelete: 'restrict',
      label: 'RFQ line',
    }),
    response: f.many2one('purchase.tender.response', {
      required: true,
      ondelete: 'restrict',
      label: 'Vendor response',
    }),
    csQty: f.decimal({
      scale: 3,
      required: true,
      default: '0',
      label: 'CS quantity',
      help: 'How much to buy from this vendor.',
    }),
    quote: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Quote',
      help: 'As the vendor quoted.',
    }),
    nego1: f.decimal({ scale: 2, label: 'Nego 1', help: 'After the first negotiation round.' }),
    nego2: f.decimal({ scale: 2, label: 'Nego 2', help: 'After the second negotiation round.' }),
    finalPrice: f.decimal({ scale: 2, required: true, default: '0', label: 'Final' }),
    total: f.decimal({
      scale: 2,
      store: true,
      help: 'The CS quantity at the final price.',
      ...compute('purchase.comparison.line', 'total', ['csQty', 'finalPrice'], (lines) => {
        for (const l of lines) l.total = l.csQty.times(l.finalPrice).toDecimalPlaces(2);
      }),
    }),
    selected: f.boolean({ default: false, label: 'Select', help: 'Awarded to this vendor.' }),
    lowest: f.boolean({
      store: true,
      label: 'Lowest',
      help: 'The lowest final price among the vendors of this RFQ line.',
      ...compute(
        'purchase.comparison.line',
        'lowest',
        ['finalPrice', 'comparison.lines.finalPrice', 'comparison.lines.tenderLine'],
        (lines) => {
          for (const l of lines) {
            const rivals = [...l.comparison.lines].filter(
              (x) => x.tenderLine.id === l.tenderLine.id && x.finalPrice.gt(0),
            );
            l.lowest = l.finalPrice.gt(0) && rivals.every((x) => x.finalPrice.gte(l.finalPrice));
          }
        },
      ),
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`cs_qty >= 0 AND quote >= 0 AND final_price >= 0`,
      message: 'Quantities and prices are positive.',
    },
  },
  constraints: {
    sameTender: {
      ...check(
        'purchase.comparison.line',
        ['tenderLine', 'response', 'comparison'],
        async (lines) =>
          [...(await lines.load({ tenderLine: true, response: true, comparison: true }))]
            .filter(
              (l) =>
                l.tenderLine.tender.id !== l.comparison.tender.id ||
                l.response.tender.id !== l.comparison.tender.id,
            )
            .map((l) => l.id),
      ),
      message: 'A comparison line belongs to the statement’s RFQ.',
    },
  },
  onchange: {
    nego1: onchange('purchase.comparison.line', async (d): Promise<void> => {
      const v = d.get('nego1');
      if (v !== null && v !== undefined) d.set('finalPrice', v as never);
    }),
    nego2: onchange('purchase.comparison.line', async (d): Promise<void> => {
      const v = d.get('nego2');
      if (v !== null && v !== undefined) d.set('finalPrice', v as never);
    }),
  },
});

/** One purchase order per selected vendor at the final prices; the RFQ becomes ordered. */
export async function confirmComparison(env: Env, id: number): Promise<number[]> {
  const [c] = await env
    .model('purchase.comparison')
    .browse([id as never])
    .load({
      lines: { tenderLine: { product: true, uom: true }, response: { vendor: { currency: true } } },
      tender: { currency: true, request: true },
      company: { currency: true },
    });
  if (c === undefined) return [];
  const byVendor = new Map<number, typeof c.lines extends Iterable<infer T> ? T[] : never>();
  for (const l of c.lines) {
    if (!l.selected || l.csQty.lte(0)) continue;
    const vendor = l.response.vendor.id as number;
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), l]);
  }
  const made: number[] = [];
  for (const [vendor, lines] of byVendor) {
    const first = lines[0];
    const order = await env.model('purchase.order').create([
      {
        partner: vendor,
        user: env.userId,
        company: c.company.id,
        currency:
          c.tender.currency?.id ?? first?.response.vendor.currency?.id ?? c.company.currency.id,
        origin: `${c.tender.name} · ${c.name}`,
        datePlanned: c.dateDelivery ?? c.tender.dateDelivery,
        note: c.note,
        lines: {
          create: lines.map((l) => ({
            product: l.tenderLine.product.id,
            name: l.tenderLine.name ?? l.tenderLine.product.name,
            quantity: l.csQty,
            uom: l.tenderLine.uom?.id ?? null,
            manualPrice: l.finalPrice,
            datePlanned: c.dateDelivery ?? c.tender.dateDelivery,
            requestLine: l.tenderLine.requestLine?.id ?? null,
          })),
        },
      },
    ] as never);
    made.push(order.ids[0] as number);
  }
  await env.flush();
  const tender = env.model('purchase.tender').browse([c.tender.id]);
  if (c.tender.state !== 'ordered') await tender.order();
  await env.emit('purchase.comparison.confirmed', { id: c.id });
  return made;
}
