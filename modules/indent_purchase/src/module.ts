/**
 * The Requests ↔ Purchase bridge (RFC 0032 §3.4): what an approved indent asks for beyond what the store holds —
 * and beyond what Purchase is already asked for — becomes a **purchase request**, one per indent with its lines
 * linked, drafted for the requester to submit; the indent shows what is being bought and the purchase request where
 * it came from. Proposed whenever both apps are installed.
 */
import { indentShutro } from '@kosh/indent';
import { purchaseShutro } from '@kosh/purchase';
import { type Decimal, orm } from '@kosh/server/orm';
import { defaultLocations, onHandIn, stockShutro } from '@kosh/stock';
import { compute, defineModule, type Env, extendModel, f, records } from './.kosh/bindings.js';

const zero: Decimal = orm.toDecimal(0);

export const IndentLineBuying = extendModel('indent.request.line', {
  fields: {
    purchaseLines: f.one2many('purchase.request.line', 'indentLine', {
      label: 'Purchase request lines',
    }),
    qtyBuying: f.decimal({
      scale: 3,
      store: true,
      label: 'Being bought',
      help: 'Asked of Purchase for this line, on purchase requests not cancelled.',
      ...compute(
        'indent.request.line',
        'qtyBuying',
        ['purchaseLines.quantity', 'purchaseLines.status'],
        (lines) => {
          for (const l of lines)
            l.qtyBuying = [...l.purchaseLines]
              .filter((p) => p.status !== 'cancelled')
              .reduce((s, p) => s.plus(p.quantity), zero);
        },
      ),
    }),
  },
});

/**
 * What each line of an indent still owes beyond the store's stock and what Purchase is already asked for: the
 * lines with a shortfall and its quantity.
 */
async function shortfalls(
  env: Env,
  id: number,
): Promise<{
  request: {
    id: number;
    name: string;
    purpose: string | null;
    requester: { id: number };
    company: { id: number };
    dateRequired: unknown;
    priority: string;
  };
  lines: {
    product: { id: number; name: string };
    uom: { id: number } | null;
    id: number;
    qty: Decimal;
  }[];
} | null> {
  const [r] = await env
    .model('indent.request')
    .browse([id as never])
    .load({ lines: { product: true, uom: true }, warehouse: true, company: true });
  if (r === undefined) return null;
  const places = await defaultLocations(env as never, 'internal', r.warehouse.id, r.company.id);
  const lines: {
    product: { id: number; name: string };
    uom: { id: number } | null;
    id: number;
    qty: Decimal;
  }[] = [];
  for (const l of r.lines) {
    const held =
      places.source === null ? zero : await onHandIn(env as never, l.product.id, places.source);
    const left = (l.qtyRemaining ?? zero).minus(held).minus(l.qtyBuying ?? zero);
    if (left.gt(0))
      lines.push({
        product: { id: l.product.id as number, name: l.product.name },
        uom: l.uom === null ? null : { id: l.uom.id as number },
        id: l.id as number,
        qty: left,
      });
  }
  return {
    request: {
      id: r.id as number,
      name: r.name,
      purpose: r.purpose ?? null,
      requester: { id: r.requester.id as number },
      company: { id: r.company.id as number },
      dateRequired: r.dateRequired,
      priority: r.priority,
    },
    lines,
  };
}

/** Drafts the purchase request of an indent's shortfall, as the system: the store keeper need not be a requester. */
async function requestPurchase(env: Env, id: number): Promise<void> {
  await env.asSuperuser({ reason: 'purchase request for an indent' }, async (su) => {
    const found = await shortfalls(su as never, id);
    if (found === null || found.lines.length === 0) return;
    const r = found.request;
    await su.model('purchase.request').create([
      {
        requester: r.requester.id,
        company: r.company.id,
        dateRequired: r.dateRequired,
        priority: r.priority,
        purpose: `${r.name}${r.purpose === null || r.purpose === '' ? '' : `: ${r.purpose}`}`,
        indent: r.id,
        lines: {
          create: found.lines.map((l) => ({
            product: l.product.id,
            name: l.product.name,
            uom: l.uom?.id ?? null,
            quantity: l.qty,
            dateRequired: r.dateRequired,
            indentLine: l.id,
          })),
        },
      },
    ] as never);
    await su.emit('indent.request.purchase_requested', { id: r.id });
  });
}

export const IndentBuying = extendModel('indent.request', {
  fields: {
    purchaseRequests: f.one2many('purchase.request', 'indent', { label: 'Purchase requests' }),
  },
  fieldOverrides: {
    state: {
      transitionsAdd: {
        /** What the store lacks goes to Purchase as a purchase request (RFC 0032 §3.4). */
        buy: {
          from: ['approved'],
          to: 'approved',
          requires: 'indent_purchase.buy',
          guard: records('indent.request', async (requests) => {
            const env = requests.env as unknown as Env;
            const out: number[] = [];
            for (const id of requests.ids) {
              const found = await shortfalls(env, id as number);
              if (found === null || found.lines.length === 0) out.push(id as number);
            }
            return out;
          }),
          message: 'The store holds enough for every line, or Purchase is asked already.',
          after: records('indent.request', async (requests) => {
            const env = requests.env as unknown as Env;
            await env.flush();
            for (const id of requests.ids) await requestPurchase(env, id as number);
          }),
        },
      },
    },
  },
});

export const RequestFromIndent = extendModel('purchase.request', {
  fields: {
    indent: f.many2one('indent.request', { ondelete: 'set null', label: 'Indent' }),
  },
});

export const RequestLineFromIndent = extendModel('purchase.request.line', {
  fields: {
    indentLine: f.many2one('indent.request.line', { ondelete: 'set null', label: 'Indent line' }),
  },
});

export const indentPurchaseShutro = defineModule({
  name: 'indent_purchase',
  version: '0.1.0',
  depends: [indentShutro, purchaseShutro, stockShutro],
  groups: [
    orm.defineGroup({
      code: 'indent_purchase.user',
      label: 'Requests with Purchase',
      implies: ['indent.store', 'purchase.requester'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'indent_purchase.buy',
      label: 'Ask Purchase for what the store lacks',
      groups: ['indent.store', 'indent_purchase.user'],
    }),
  ],
  models: [],
  extensions: [IndentLineBuying, IndentBuying, RequestFromIndent, RequestLineFromIndent],
});
