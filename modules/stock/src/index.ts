/**
 * @packageDocumentation
 * `@kosh/stock` (RFC 0021): the **Stockroom** app. Warehouses and a tree of locations; the Transfer — one document
 * for receipts, deliveries and internal moves — with one status chip (Draft, Waiting, Ready, Done, Cancelled);
 * reservations that say what they are for; units converted exactly; stock that never goes below zero. Every company
 * gets its main warehouse (`WH`, `WH/Stock`) when the app is installed or the company is created.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { action, field, form, kanban, list, search, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { stockDemo } from './demo.js';
import {
  onHandIn,
  StockCount,
  StockCountLine,
  StockLocation,
  StockLot,
  StockLotLine,
  StockMove,
  StockPicking,
  StockPutaway,
  StockQuant,
  StockReorder,
  StockReservation,
  StockScrap,
  StockWarehouse,
  stockShutro,
} from './module.js';
import { orderAutomatic, orderRules, refreshRules } from './replenish.js';
import {
  createReturn,
  installReturnReasons,
  returnableLines,
  StockReturnReason,
} from './returns.js';

export {
  defaultLocations,
  inProductUnit,
  onHandIn,
  ProductStock,
  reserveOnConfirm,
  SCRAP_REASONS,
  type Step,
  StockCount,
  StockCountLine,
  StockLocation,
  StockLot,
  StockLotLine,
  StockMove,
  StockPicking,
  StockPutaway,
  StockQuant,
  StockReorder,
  StockReservation,
  StockScrap,
  StockWarehouse,
  stepLocation,
  stockShutro,
  transitLocation,
  warehouseStock,
} from './module.js';
export { orderAutomatic, orderRules, reckon, refreshRules } from './replenish.js';
export {
  createReturn,
  DEFAULT_RETURN_REASONS,
  type Returnable,
  returnableLines,
  StockReturnReason,
} from './returns.js';

/** Every company without a warehouse gets its main one, `WH`, with its stock location `WH/Stock`. */
async function mainWarehouses(env: Env): Promise<string | undefined> {
  const companies = await env.model('res.company').search({});
  let made = 0;
  for (const company of companies.ids) {
    const any = await env
      .withFlags({ activeTest: false })
      .model('stock.warehouse')
      .search({ where: { company }, limit: 1 });
    if (any.length > 0) continue;
    const warehouse = (
      await env.model('stock.warehouse').create([{ name: 'Main warehouse', code: 'WH', company }])
    ).ids[0];
    if (warehouse === undefined) continue;
    await env
      .model('stock.location')
      .create([{ name: 'Stock', usage: 'internal', warehouse, company }]);
    made += 1;
  }
  // Checked here, in this scope (the caller's flush would run the checks without its rights).
  await env.flush();
  return made === 0 ? undefined : `${made} main warehouse(s) made`;
}

/**
 * Counting from a phone: each scan adds to what is counted (one, or the quantity sent) — a lot or serial number's
 * name counts that lot, a product's barcode the product — on the count's line, made with what is expected when it
 * was not listed. As the user: their rights apply; the count must be counting.
 */
/**
 * Returns (RFC 0030 §3.2): what a done delivery or receipt can still return, and the return made with its reason.
 * As the user: Stockroom rights apply.
 */
function registerReturnRoutes({ app }: ModuleContext): void {
  const pickingId = (params: unknown) => {
    const id = Number((params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'A transfer id.');
    return id;
  };
  app.get('/api/v1/stockroom/pickings/:id/returnable', async (request) => {
    const id = pickingId(request.params);
    return request.env(async (env) => ({ lines: await returnableLines(env as Env, id) }));
  });
  app.post('/api/v1/stockroom/pickings/:id/return', async (request) => {
    const id = pickingId(request.params);
    const body = (request.body ?? {}) as {
      lines?: unknown;
      reason?: unknown;
      note?: unknown;
      location?: unknown;
    };
    const lines = Array.isArray(body.lines)
      ? body.lines.map((l) => ({
          move: Number((l as { move?: unknown }).move),
          quantity: String((l as { quantity?: unknown }).quantity ?? ''),
        }))
      : [];
    if (lines.some((l) => !Number.isSafeInteger(l.move) || !/^\d+(\.\d+)?$/.test(l.quantity)))
      throw new HttpProblem(400, 'invalid-body', 'Invalid lines', 'lines: [{ move, quantity }].');
    const reason = Number(body.reason);
    if (!Number.isSafeInteger(reason) || reason <= 0)
      throw new HttpProblem(
        400,
        'invalid-body',
        'Reason required',
        'Give the reason of the return.',
      );
    const location = body.location == null ? null : Number(body.location);
    return request.env(
      (env) =>
        createReturn(env as Env, id, {
          lines,
          reason,
          note: typeof body.note === 'string' ? body.note : null,
          location: location !== null && Number.isSafeInteger(location) ? location : null,
        }),
      { write: true },
    );
  });
}

function registerCountRoutes({ app }: ModuleContext): void {
  app.post('/api/v1/stockroom/counts/:id/scan', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'A count id.');
    const body = (request.body ?? {}) as { barcode?: unknown; quantity?: unknown };
    const barcode = typeof body.barcode === 'string' ? body.barcode.trim() : '';
    if (barcode === '')
      throw new HttpProblem(400, 'invalid-barcode', 'No barcode', 'Send the scanned barcode.');
    let quantity = orm.toDecimal(1);
    if (body.quantity !== undefined)
      try {
        quantity = orm.toDecimal(String(body.quantity));
      } catch {
        throw new HttpProblem(400, 'invalid-quantity', 'Invalid quantity', 'A positive number.');
      }
    if (quantity.lte(0))
      throw new HttpProblem(400, 'invalid-quantity', 'Invalid quantity', 'A positive number.');
    return request.env(
      async (raw) => {
        const env = raw as Env;
        const [count] = await (
          await env
            .model('stock.count')
            .search({ where: { id: orm.asId(id, 'stock.count') }, limit: 1 })
        ).load({ location: true });
        if (count === undefined)
          throw new HttpProblem(404, 'missing-record', 'Not found', `There is no count ${id}.`);
        if (count.state !== 'counting')
          throw new HttpProblem(409, 'not-counting', 'Not counting', 'Start the count first.');
        const [scannedLot] = await (
          await env.model('stock.lot').search({ where: { name: barcode }, limit: 1 })
        ).load({ product: true });
        const lot = scannedLot?.id ?? null;
        const [found] =
          scannedLot !== undefined
            ? [scannedLot.product]
            : await (
                await env.model('product.product').search({ where: { barcode }, limit: 1 })
              ).load(['name', 'kind']);
        if (found === undefined)
          throw new HttpProblem(
            404,
            'unknown-barcode',
            'Unknown barcode',
            `No product has the barcode ${barcode}.`,
          );
        const product = found.id as Id<'product.product'>;
        const [line] = await (
          await env.model('stock.count.line').search({
            where: { count: count.id, product, lot: lot === null ? { isNull: true } : lot },
            limit: 1,
          })
        ).load(['counted', 'expected']);
        const counted = (line?.counted ?? orm.toDecimal(0)).plus(quantity);
        if (line !== undefined) await line.write({ counted });
        else
          await env.model('stock.count.line').create([
            {
              count: count.id,
              product,
              lot,
              expected: await onHandIn(env, product, count.location.id, lot),
              counted,
            },
          ]);
        await env.flush();
        return {
          product: found.name,
          ...(scannedLot === undefined ? {} : { lot: scannedLot.name }),
          counted: counted.toString(),
        };
      },
      { write: true },
    );
  });
}

const ruleIds = (body: unknown): number[] | undefined => {
  const given = (body as Record<string, unknown> | null)?.['rules'];
  if (given === undefined) return undefined;
  if (!Array.isArray(given) || !given.every((v) => Number.isSafeInteger(v) && Number(v) > 0))
    throw new HttpProblem(400, 'invalid-rules', 'Invalid rules', 'A list of reorder rule ids.');
  return given.map(Number);
};
const needs = (env: Env, group: 'stock.user' | 'stock.manager', who: string) => {
  if (!env.administrator && !env.groups.has(group))
    throw new HttpProblem(403, 'access', who, `This needs the ${who} role.`);
};

/**
 * My operations (RFC 0032 §3.3): per warehouse and kind of transfer, what is ready (everything reserved, or a receipt
 * confirmed), waiting (confirmed, not all reserved) and late (not done, scheduled before today) — counted as the user,
 * so their record rules apply — with the domain each count stands for.
 */
function registerOperationsRoutes(context: ModuleContext): void {
  const { app } = context;
  const ACTIONS = {
    receipt: 'stockroom.action_receipts',
    delivery: 'stockroom.action_deliveries',
    internal: 'stockroom.action_transfers',
  } as const;
  app.get('/api/v1/stockroom/operations', async (request) =>
    request.env(async (raw) => {
      const env = raw as Env;
      needs(env, 'stock.user', 'Stockroom user');
      const today = env.today();
      const open = await (
        await env.model('stock.picking').search({
          where: {
            state: { in: ['draft', 'confirmed'] },
            kind: { in: ['receipt', 'delivery', 'internal'] },
            warehouse: { isNull: false },
          },
          limit: 20000,
        })
      ).load({ warehouse: true });
      const cards = new Map<
        string,
        { warehouse: { id: number; name: string }; kind: keyof typeof ACTIONS; n: number[] }
      >();
      for (const p of open) {
        if (p.warehouse === null) continue;
        const kind = p.kind as keyof typeof ACTIONS;
        const key = `${p.warehouse.id}:${kind}`;
        const card = cards.get(key) ?? {
          warehouse: { id: p.warehouse.id as number, name: p.warehouse.name },
          kind,
          n: [0, 0, 0],
        };
        const ready =
          p.state === 'confirmed' && (p.kind === 'receipt' || p.availability === 'full');
        const counts = card.n as [number, number, number];
        if (ready) counts[0] += 1;
        else if (p.state === 'confirmed') counts[1] += 1;
        if (p.scheduledDate !== null && isoDay(p.scheduledDate) < isoDay(today)) counts[2] += 1;
        cards.set(key, card);
      }
      const order = { receipt: 0, delivery: 1, internal: 2 } as const;
      return {
        operations: [...cards.values()]
          .sort(
            (a, b) =>
              a.warehouse.name.localeCompare(b.warehouse.name) || order[a.kind] - order[b.kind],
          )
          .map((c) => {
            const base = { warehouse: c.warehouse.id, kind: c.kind };
            return {
              warehouse: c.warehouse,
              kind: c.kind,
              action: ACTIONS[c.kind],
              ready: {
                count: c.n[0],
                domain:
                  c.kind === 'receipt'
                    ? { ...base, state: 'confirmed' }
                    : { ...base, state: 'confirmed', availability: 'full' },
              },
              waiting: {
                count: c.n[1],
                domain:
                  c.kind === 'receipt'
                    ? { ...base, state: 'confirmed', id: { in: [] } }
                    : { ...base, state: 'confirmed', availability: { ne: 'full' } },
              },
              late: {
                count: c.n[2],
                domain: {
                  ...base,
                  state: { in: ['draft', 'confirmed'] },
                  scheduledDate: { lt: isoDay(today) },
                },
              },
            };
          }),
      };
    }),
  );
}

/** A date as `YYYY-MM-DD`. */
function isoDay(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

/**
 * Replenishment (RFC 0024 §2.6): the rules' figures refreshed now, the rules chosen ordered (what they propose, or
 * the quantities given), snoozed for some days. Ordering makes documents in other apps (requests for quotation,
 * production orders), so it runs in an audited superuser scope for Stockroom managers; the rules are read as the
 * user first, so their record rules apply. Hourly on the server: every rule refreshed, the automatic ones ordered.
 */
function registerReplenishmentRoutes(context: ModuleContext): void {
  const { app } = context;
  const visible = async (env: Env, ids: readonly number[] | undefined) =>
    (
      await env
        .model('stock.reorder')
        .search(ids === undefined ? {} : { where: { id: { in: ids as never } } })
    ).ids;
  app.post('/api/v1/stockroom/replenishment/refresh', async (request) => {
    const ids = ruleIds(request.body);
    return request.env(
      async (raw) => {
        const env = raw as Env;
        needs(env, 'stock.user', 'Stockroom user');
        const rules = await visible(env, ids);
        return {
          rules: await env.asSuperuser({ reason: 'replenishment figures' }, (su) =>
            refreshRules(su, rules),
          ),
        };
      },
      { write: true },
    );
  });
  app.post('/api/v1/stockroom/replenishment/order', async (request) => {
    const ids = ruleIds(request.body);
    if (ids === undefined || ids.length === 0)
      throw new HttpProblem(400, 'invalid-rules', 'No rules', 'Choose the rules to order.');
    const given = (request.body as Record<string, unknown>)['quantities'];
    const quantities = new Map<number, Decimal>();
    if (given !== undefined && given !== null) {
      if (typeof given !== 'object')
        throw new HttpProblem(400, 'invalid-quantity', 'Invalid quantities', 'Rule id → quantity.');
      for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
        let q: Decimal;
        try {
          q = orm.toDecimal(String(v));
        } catch {
          throw new HttpProblem(400, 'invalid-quantity', 'Invalid quantity', 'A positive number.');
        }
        if (q.lte(0))
          throw new HttpProblem(400, 'invalid-quantity', 'Invalid quantity', 'A positive number.');
        quantities.set(Number(k), q);
      }
    }
    return request.env(
      async (raw) => {
        const env = raw as Env;
        needs(env, 'stock.manager', 'Stockroom manager');
        const rules = await visible(env, ids);
        if (rules.length !== ids.length)
          throw new HttpProblem(404, 'missing-record', 'Not found', 'A rule is not there.');
        return env.asSuperuser({ reason: 'replenishment ordered' }, (su) =>
          orderRules(su, rules, quantities),
        );
      },
      { write: true },
    );
  });
  app.post('/api/v1/stockroom/replenishment/snooze', async (request) => {
    const ids = ruleIds(request.body);
    const days = Number((request.body as Record<string, unknown> | null)?.['days'] ?? 7);
    if (ids === undefined || ids.length === 0)
      throw new HttpProblem(400, 'invalid-rules', 'No rules', 'Choose the rules to snooze.');
    if (!Number.isSafeInteger(days) || days < 0 || days > 365)
      throw new HttpProblem(400, 'invalid-days', 'Invalid days', 'From 0 (wake up) to 365 days.');
    return request.env(
      async (raw) => {
        const env = raw as Env;
        needs(env, 'stock.manager', 'Stockroom manager');
        const until = new Date(`${env.today()}T00:00:00Z`);
        until.setUTCDate(until.getUTCDate() + days);
        const rules = env.model('stock.reorder').browse((await visible(env, ids)) as never);
        await rules.write({ snoozedUntil: days === 0 ? null : until.toISOString().slice(0, 10) });
        await env.flush();
        return { rules: rules.length, until: days === 0 ? null : until.toISOString().slice(0, 10) };
      },
      { write: true },
    );
  });
  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const run = async () => {
    try {
      const companies = await context.shutro.bootstrap(
        { reason: 'replenishment' },
        async (env) => (await (env as unknown as Env).model('res.company').search({})).ids,
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'replenishment', company }, (env) =>
          (env as unknown as Env).asSuperuser({ reason: 'replenishment' }, (su) =>
            orderAutomatic(su),
          ),
        );
    } catch (error) {
      app.log.error({ err: error }, 'replenishment');
    }
  };
  const timer = setInterval(() => void run(), 3_600_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

export const stock: ReturnType<typeof defineModule> = defineModule({
  shutro: stockShutro,
  kosh: '^0.1.0',
  hooks: {
    defaults: async (env) =>
      (env as Env).asSuperuser({ reason: 'main warehouses and return reasons' }, async (su) => {
        const made = await mainWarehouses(su);
        const reasons = await installReturnReasons(su);
        return (
          [made, reasons > 0 ? `${reasons} return reason(s)` : undefined]
            .filter((x) => x !== undefined)
            .join('; ') || undefined
        );
      }),
    demo: stockDemo,
  },
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'stock.return.reason',
        reason: 'A short list of reasons, installed with the app and edited on screen.',
      },
      {
        rule: 'M3',
        model: 'stock.quant',
        reason: 'Stock levels, written by moves only; a level is never archived.',
      },
    ],
  },
  depends: [product, contacts, messaging, reporting],
  app: {
    code: 'stockroom',
    label: 'Stockroom',
    icon: 'stockroom',
    sequence: 12,
    category: 'Operations',
    summary: 'Warehouses, transfers with one clear status, reservations that say what they are for',
  },
  documents: [
    {
      key: 'transfer',
      name: 'Transfer',
      model: 'stock.picking',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'transfer',
            items: [
              { label: 'Kind', bind: 'kind' },
              { label: 'Contact', bind: 'partner.name' },
              { label: 'Warehouse', bind: 'warehouse.name' },
              { label: 'From', bind: 'source.name' },
              { label: 'To', bind: 'destination.name' },
              { label: 'Scheduled', bind: 'scheduledDate' },
              { label: 'Done', bind: 'doneDate' },
              { label: 'Source document', bind: 'origin' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'moves',
            bind: 'moves',
            columns: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Description', bind: 'name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Unit', bind: 'uom.name' },
              { label: 'Done', bind: 'quantityDone' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'signature', id: 'sign', labels: ['Handed over by', 'Received by'] },
        ],
      },
    },
    {
      key: 'stock_count',
      name: 'Stock count sheet',
      model: 'stock.count',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Stock count {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'count',
            items: [
              { label: 'Location', bind: 'location.name' },
              { label: 'Date', bind: 'date' },
              { label: 'Counted by', bind: 'user.name' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Lot', bind: 'lot.name' },
              { label: 'Expected', bind: 'expected' },
              { label: 'Counted', bind: 'counted' },
              { label: 'Difference', bind: 'difference' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'signature', id: 'sign', labels: ['Counted by', 'Checked by'] },
        ],
      },
    },
    {
      key: 'scrap',
      name: 'Scrap note',
      model: 'stock.scrap',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Scrap {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'scrap',
            items: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Lot', bind: 'lot.name' },
              { label: 'From', bind: 'location.name' },
              { label: 'Reason', bind: 'reason' },
              { label: 'Date', bind: 'date' },
              { label: 'Status', bind: 'state' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'signature', id: 'sign', labels: ['Scrapped by', 'Approved by'] },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'stock_count',
      model: 'stock.count',
      label: 'Count',
      columns: [
        { header: 'Location', field: 'location' },
        { header: 'Date', field: 'date' },
        { header: 'Counted by', field: 'user' },
        { header: 'Note', field: 'note' },
        { header: 'Lines › Product', field: 'lines.product' },
        { header: 'Lines › Lot / serial number', field: 'lines.lot' },
        { header: 'Lines › Expected', field: 'lines.expected' },
        { header: 'Lines › Counted', field: 'lines.counted' },
      ],
    },
    {
      key: 'stock_warehouse',
      model: 'stock.warehouse',
      label: 'Warehouse',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Short code', field: 'code' },
        { header: 'Address', field: 'address' },
        { header: 'Receipts', field: 'receptionSteps' },
        { header: 'Deliveries', field: 'deliverySteps' },
        { header: 'Locations › Name', field: 'locations.name' },
        { header: 'Locations › Inside', field: 'locations.parent' },
        { header: 'Locations › Usage', field: 'locations.usage' },
        { header: 'Locations › Step', field: 'locations.step' },
      ],
    },
    {
      key: 'stock_lot',
      model: 'stock.lot',
      label: 'Lot / serial number',
      columns: [
        { header: 'Lot / serial number', field: 'name' },
        { header: 'Product', field: 'product' },
        { header: 'Expires on', field: 'expiryDate' },
        { header: 'Note', field: 'note' },
      ],
    },
    {
      key: 'stock_quant',
      model: 'stock.quant',
      label: 'Stock',
      columns: [
        { header: 'Product', field: 'product' },
        { header: 'Location', field: 'location' },
        { header: 'Lot', field: 'lot' },
        { header: 'On hand', field: 'quantity' },
      ],
    },
    {
      key: 'stock_picking',
      model: 'stock.picking',
      label: 'Transfer',
      columns: [
        { header: 'Type', field: 'kind' },
        { header: 'Contact', field: 'partner' },
        { header: 'Warehouse', field: 'warehouse' },
        { header: 'From', field: 'source' },
        { header: 'To', field: 'destination' },
        { header: 'Scheduled', field: 'scheduledDate' },
        { header: 'Source document', field: 'origin' },
        { header: 'Note', field: 'note' },
        { header: 'Lines › Product', field: 'moves.product' },
        { header: 'Lines › Description', field: 'moves.name' },
        { header: 'Lines › Quantity', field: 'moves.quantity' },
        { header: 'Lines › Unit', field: 'moves.uom' },
        { header: 'Lines › Done', field: 'moves.quantityDone' },
      ],
    },
    {
      key: 'stock_scrap',
      model: 'stock.scrap',
      label: 'Scrap',
      columns: [
        { header: 'Product', field: 'product' },
        { header: 'Quantity', field: 'quantity' },
        { header: 'From', field: 'location' },
        { header: 'Lot / serial number', field: 'lot' },
        { header: 'Reason', field: 'reason' },
        { header: 'Note', field: 'note' },
        { header: 'Date', field: 'date' },
      ],
    },
  ],
  events: [
    { topic: 'stock.picking.done', model: 'stock.picking', label: 'Transfer done' },
    { topic: 'stock.count.applied', model: 'stock.count', label: 'Stock count applied' },
    { topic: 'stock.scrap.done', model: 'stock.scrap', label: 'Scrap done' },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User (transfers, stock)', groups: ['stock.user'] },
    manager: {
      label: 'Manager (warehouses, locations, everything)',
      groups: ['stock.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => {
    registerOperationsRoutes(context);
    registerCountRoutes(context);
    registerReturnRoutes(context);
    registerReplenishmentRoutes(context);
  },
  settings: {
    sections: [
      {
        key: 'reservations',
        label: 'Reservations',
        description: 'When transfers hold the stock they take.',
        keywords: 'reserve reservation availability transfer delivery',
        scope: 'installation',
        editors: ['stock.manager'],
        fields: [
          {
            key: 'reserveOnConfirm',
            type: 'boolean',
            label: 'Reserve when a transfer is confirmed',
            default: true,
            help: 'Off: stock is reserved only with Check availability.',
          },
        ],
      },
    ],
  },
  // The Overview (RFC 0022 step 2).
  overview: {
    cards: [
      {
        id: 'receipts_todo',
        title: 'Receipts to do',
        kind: 'kpi',
        model: 'stock.picking',
        measure: 'count',
        filter: { kind: 'receipt', status: { in: ['waiting', 'ready'] } },
        w: 3,
      },
      {
        id: 'deliveries_todo',
        title: 'Deliveries to do',
        kind: 'kpi',
        model: 'stock.picking',
        measure: 'count',
        filter: { kind: 'delivery', status: { in: ['waiting', 'ready'] } },
        w: 3,
      },
      {
        id: 'done_month',
        title: 'Transfers done this month',
        kind: 'kpi',
        model: 'stock.picking',
        measure: 'count',
        filter: { status: 'done' },
        comparison: { field: 'scheduledDate', mode: 'previous' },
        w: 3,
      },
      {
        id: 'reservations',
        title: 'Reservations',
        kind: 'kpi',
        model: 'stock.reservation',
        measure: 'count',
        w: 3,
      },
      {
        id: 'to_reorder',
        title: 'Products to reorder',
        kind: 'kpi',
        model: 'stock.reorder',
        measure: 'count',
        filter: { proposed: { gt: 0 } },
        w: 3,
      },
      {
        id: 'by_status',
        title: 'Transfers by status',
        kind: 'chart',
        model: 'stock.picking',
        measure: 'count',
        groupBy: 'status',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'on_hand_by_location',
        title: 'On hand by location',
        kind: 'chart',
        model: 'stock.quant',
        measure: 'sum:quantity',
        groupBy: 'location',
        filter: { quantity: { gt: 0 } },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'most_stocked',
        title: 'Most stocked products',
        kind: 'pivot',
        model: 'stock.quant',
        measure: 'sum:quantity',
        groupBy: 'product',
        filter: { quantity: { gt: 0 } },
        w: 6,
      },
      {
        id: 'late',
        title: 'Scheduled transfers',
        kind: 'list',
        model: 'stock.picking',
        measure: 'count',
        filter: { status: { in: ['waiting', 'ready'] } },
        w: 6,
      },
    ],
  },
  actions: {
    'stockroom.action_transfers': action(StockPicking, {
      label: 'Transfers',
      views: ['list', 'kanban', 'form'],
      defaults: { kind: 'internal' },
      defaultFilters: ['open'],
    }),
    'stockroom.action_returns': action(StockPicking, {
      label: 'Returns',
      views: ['list', 'form'],
      domain: { returnOf: { ne: null } },
    }),
    'stockroom.action_return_reasons': action(StockReturnReason, {
      label: 'Return reasons',
      views: ['list', 'form'],
    }),
    'stockroom.action_receipts': action(StockPicking, {
      label: 'Receipts',
      views: ['list', 'kanban', 'form'],
      defaults: { kind: 'receipt' },
      defaultFilters: ['receipts', 'open'],
    }),
    'stockroom.action_deliveries': action(StockPicking, {
      label: 'Deliveries',
      views: ['list', 'kanban', 'form'],
      defaults: { kind: 'delivery' },
      defaultFilters: ['deliveries', 'open'],
    }),
    'stockroom.action_stock': action(StockQuant, {
      label: 'Stock',
      views: ['list', 'form'],
      defaultFilters: ['in_stock'],
    }),
    'stockroom.action_reservations': action(StockReservation, {
      label: 'Reservations',
      views: ['list'],
    }),
    'stockroom.action_lots': action(StockLot, {
      label: 'Lots and serial numbers',
      views: ['list', 'form'],
      defaultFilters: ['in_stock'],
    }),
    'stockroom.action_scraps': action(StockScrap, {
      label: 'Scrap',
      views: ['list', 'form'],
    }),
    'stockroom.action_counts': action(StockCount, {
      label: 'Counts',
      views: ['list', 'form'],
      defaultFilters: ['open'],
    }),
    'stockroom.action_replenishment': {
      type: 'client',
      page: 'stock.Replenishment',
      label: 'Replenishment',
    },
    'stockroom.action_operations': {
      type: 'client',
      page: 'stock.Operations',
      label: 'My operations',
    },
    'stockroom.action_putaway': action(StockPutaway, {
      label: 'Putaway rules',
      views: ['list', 'form'],
    }),
    'stockroom.action_reorder': action(StockReorder, {
      label: 'Reorder rules',
      views: ['list', 'form'],
    }),
    'stockroom.action_warehouses': action(StockWarehouse, {
      label: 'Warehouses',
      views: ['list', 'form'],
    }),
    'stockroom.action_locations': action(StockLocation, {
      label: 'Locations',
      views: ['list', 'form'],
      defaultFilters: ['internal'],
    }),
  },
  menus: [
    { id: 'stockroom.root', label: 'Stockroom', app: 'stockroom' },
    {
      id: 'stockroom.operations',
      parent: 'stockroom.root',
      label: 'My operations',
      action: 'stockroom.action_operations',
      sequence: 0,
    },
    {
      id: 'stockroom.transfers',
      parent: 'stockroom.root',
      label: 'Transfers',
      action: 'stockroom.action_transfers',
      sequence: 1,
    },
    {
      id: 'stockroom.receipts',
      parent: 'stockroom.root',
      label: 'Receipts',
      action: 'stockroom.action_receipts',
      sequence: 2,
    },
    {
      id: 'stockroom.deliveries',
      parent: 'stockroom.root',
      label: 'Deliveries',
      action: 'stockroom.action_deliveries',
      sequence: 3,
    },
    {
      id: 'stockroom.returns',
      parent: 'stockroom.root',
      label: 'Returns',
      action: 'stockroom.action_returns',
      sequence: 3.5,
    },
    {
      id: 'stockroom.return_reasons',
      parent: 'stockroom.configuration',
      label: 'Return reasons',
      action: 'stockroom.action_return_reasons',
      sequence: 8,
    },
    {
      id: 'stockroom.stock',
      parent: 'stockroom.root',
      label: 'Stock',
      action: 'stockroom.action_stock',
      sequence: 4,
    },
    {
      id: 'stockroom.reservations',
      parent: 'stockroom.root',
      label: 'Reservations',
      action: 'stockroom.action_reservations',
      sequence: 5,
    },
    {
      id: 'stockroom.lots',
      parent: 'stockroom.root',
      label: 'Lots and serial numbers',
      action: 'stockroom.action_lots',
      sequence: 5,
    },
    {
      id: 'stockroom.counts',
      parent: 'stockroom.root',
      label: 'Counts',
      action: 'stockroom.action_counts',
      sequence: 6,
    },
    {
      id: 'stockroom.replenishment',
      parent: 'stockroom.root',
      label: 'Replenishment',
      action: 'stockroom.action_replenishment',
      sequence: 7,
    },
    {
      id: 'stockroom.scraps',
      parent: 'stockroom.root',
      label: 'Scrap',
      action: 'stockroom.action_scraps',
      sequence: 8,
    },
    {
      id: 'stockroom.configuration',
      parent: 'stockroom.root',
      label: 'Configuration',
      sequence: 9,
    },
    {
      id: 'stockroom.warehouses',
      parent: 'stockroom.configuration',
      label: 'Warehouses',
      action: 'stockroom.action_warehouses',
      sequence: 1,
    },
    {
      id: 'stockroom.locations',
      parent: 'stockroom.configuration',
      label: 'Locations',
      action: 'stockroom.action_locations',
      sequence: 2,
    },
    {
      id: 'stockroom.reorder',
      parent: 'stockroom.configuration',
      label: 'Reorder rules',
      action: 'stockroom.action_reorder',
      sequence: 3,
    },
    {
      id: 'stockroom.putaway',
      parent: 'stockroom.configuration',
      label: 'Putaway rules',
      action: 'stockroom.action_putaway',
      sequence: 4,
    },
  ],
  views: {
    'stock.picking.list': list(StockPicking, {
      columns: [
        'name',
        'kind',
        'partner',
        'source',
        'destination',
        { field: 'scheduledDate', widget: 'daysLeft' },
        'origin',
        { field: 'status', widget: 'badge' },
      ],
      decorations: {
        success: { status: 'done' },
        warning: { status: 'waiting' },
        neutral: { status: 'cancelled' },
      },
    }),
    'stock.picking.kanban': kanban(StockPicking, {
      groupBy: 'status',
      card: {
        title: 'name',
        subtitle: 'partner',
        color: 'kind',
        footer: [{ field: 'scheduledDate', widget: 'daysLeft' }, 'origin'],
        badges: [{ field: 'kind', widget: 'badge' }],
      },
    }),
    'stock.picking.form': form(StockPicking, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('confirm', { primary: true, label: 'Confirm' }),
          k.button('reserve', { label: 'Check availability' }),
          k.button('validate', { primary: true, label: 'Validate' }),
          k.button('unreserve', { label: 'Unreserve' }),
          k.button('cancel', {
            label: 'Cancel',
            confirm: 'Cancel this transfer? Its reservations are released.',
          }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['kind', 'partner', 'warehouse', 'source', 'destination']),
        k.group('when', [
          'scheduledDate',
          'doneDate',
          'origin',
          'status',
          'availability',
          'backorderOf',
          'next',
          'returnOf',
          'returnReason',
        ]),
        // Return part of a done delivery or receipt, with a reason (RFC 0030 §3.2).
        k.component('return', 'stock.Return'),
        k.lines('moves', [
          'product',
          'name',
          'quantity',
          'uom',
          { field: 'reserved', id: 'move_reserved' },
          { field: 'quantityDone', id: 'move_done' },
          { field: 'restrictLot', id: 'move_restrict_lot' },
          { field: 'destination', id: 'move_put_away' },
          { field: 'procurement', id: 'move_procurement', readonlyWhen: {} },
        ]),
        k.lines('lotLines', [
          { field: 'product', id: 'lot_line_product' },
          { field: 'lot', id: 'lot_line_lot' },
          { field: 'lotName', id: 'lot_line_name' },
          { field: 'quantity', id: 'lot_line_quantity' },
        ]),
        k.group('info', ['responsible', 'carrier', 'trackingRef', 'weight'], {
          label: 'Additional information',
        }),
        k.group(
          'transport',
          [
            'vehicleNumber',
            'driverName',
            { field: 'driverMobile', widget: 'phone' },
            'transporter',
            'transportDate',
            'gateIn',
            'gateOut',
            'freightAmount',
            'deductFromSupplier',
            'supplierDeduction',
          ],
          {
            label: 'Transport details',
            description:
              'With Accounting, validating drafts the transport vendor’s freight bill and, for a receipt, a vendor refund for the supplier’s deduction.',
          },
        ),
        k.lines('charges', [
          { field: 'name', id: 'charge_name' },
          { field: 'kind', id: 'charge_kind' },
          { field: 'amount', id: 'charge_amount' },
        ]),
        k.lines('extras', [
          { field: 'product', id: 'extra_product' },
          { field: 'name', id: 'extra_name' },
          { field: 'quantity', id: 'extra_quantity' },
          { field: 'note', id: 'extra_note' },
        ]),
        k.group('gate', ['gateNote', 'remarks'], { label: 'Gate and QC', columns: 1 }),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.return.reason.list': list(StockReturnReason, {
      columns: ['sequence', 'name', 'code'],
      inlineEdit: ['sequence', 'name'],
    }),
    'stock.return.reason.form': form(StockReturnReason, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'code', 'sequence'])],
    })),
    'stock.quant.list': list(StockQuant, {
      columns: ['product', 'location', 'lot', 'quantity', 'reserved', 'available'],
    }),
    'stock.lot.list': list(StockLot, {
      columns: ['name', 'product', 'expiryDate', 'qtyOnHand'],
    }),
    'stock.lot.form': form(StockLot, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'product', 'expiryDate', 'qtyOnHand']),
        k.lines('quants', [
          { field: 'location', id: 'lot_quant_location' },
          { field: 'quantity', id: 'lot_quant_quantity' },
          { field: 'reserved', id: 'lot_quant_reserved' },
        ]),
        k.lines('history', [
          { field: 'picking', id: 'lot_history_picking' },
          { field: 'quantity', id: 'lot_history_quantity' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.lot.line.list': list(StockLotLine, {
      columns: ['picking', 'product', 'lot', 'lotName', 'quantity'],
    }),
    'stock.quant.form': form(StockQuant, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['product', 'location', 'lot']),
        k.group('quantities', ['quantity', 'reserved', 'available']),
        k.lines('reservations', [{ field: 'label', id: 'reservation_label' }]),
      ],
    })),
    'stock.reservation.list': list(StockReservation, {
      columns: ['label', 'quant', 'quantity', 'move'],
    }),
    'stock.scrap.list': list(StockScrap, {
      columns: [
        'name',
        'date',
        'product',
        'quantity',
        'reason',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'stock.scrap.form': form(StockScrap, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('validate', {
            primary: true,
            label: 'Scrap',
            confirm: 'Scrap it? The stock leaves for the Scrap location.',
          }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      sheet: [
        k.group('main', ['product', 'quantity', 'location', 'lot']),
        k.group('why', ['reason', 'date', 'picking']),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.count.list': list(StockCount, {
      columns: ['name', 'location', 'date', 'user', { field: 'state', widget: 'badge' }],
    }),
    'stock.count.form': form(StockCount, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('start', { primary: true, label: 'Start counting' }),
          k.button('apply', {
            primary: true,
            label: 'Apply',
            confirm: 'Apply this count? Stock is adjusted to what was counted.',
          }),
          k.button('cancel', { label: 'Cancel' }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['location', 'date', 'user']),
        k.component('scan', 'stock.Scan'),
        k.lines('lines', [
          { field: 'product', id: 'count_product' },
          { field: 'lot', id: 'count_lot' },
          { field: 'expected', id: 'count_expected' },
          { field: 'counted', id: 'count_counted' },
          { field: 'difference', id: 'count_difference' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'stock.count.line.list': list(StockCountLine, {
      columns: ['count', 'product', 'expected', 'counted', 'difference'],
    }),
    'stock.warehouse.list': list(StockWarehouse, { columns: ['name', 'code', 'address'] }),
    'stock.warehouse.form': form(StockWarehouse, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'code', 'address']),
        k.group('routes', ['receptionSteps', 'deliverySteps'], {
          label: 'Routes',
          description:
            'In two or three steps, a receipt goes into Input and on through Quality control to stock; a delivery leaves from Output after a pick (and a pack). Each step is its own transfer, made when the one before it is done.',
        }),
        k.lines('locations', [
          { field: 'name', id: 'location_name' },
          { field: 'usage', id: 'location_usage' },
          { field: 'parent', id: 'location_parent' },
          { field: 'step', id: 'location_step' },
        ]),
      ],
    })),
    'stock.location.list': list(StockLocation, {
      columns: ['fullName', 'usage', 'warehouse', 'step'],
    }),
    'stock.putaway.list': list(StockPutaway, {
      columns: ['location', 'product', 'category', 'destination', 'sequence'],
    }),
    'stock.putaway.form': form(StockPutaway, (k) => ({
      sheet: [
        k.group('main', ['location', 'product', 'category', 'destination', 'sequence'], {
          description:
            'What arrives in the location — this product, or any product of this category — is put away in the location inside it.',
        }),
      ],
    })),
    'stock.location.form': form(StockLocation, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'parent', 'warehouse', 'usage', 'fullName'])],
    })),
    'stock.reorder.list': list(StockReorder, {
      columns: [
        'product',
        'warehouse',
        'method',
        'trigger',
        'minimum',
        'maximum',
        'forecast',
        'proposed',
        'lastOrder',
      ],
      decorations: { warning: { proposed: { gt: 0 } } },
    }),
    'stock.reorder.form': form(StockReorder, (k) => ({
      sheet: [
        k.group('rule', ['product', 'warehouse', 'minimum', 'maximum', 'multiple'], {
          description:
            'Below the minimum, the forecast proposes enough to reach the maximum, in steps of the multiple.',
        }),
        k.group(
          'how',
          ['method', 'trigger', 'vendor', 'sourceWarehouse', 'leadDays', 'auto', 'snoozedUntil'],
          {
            label: 'How it is ordered',
          },
        ),
        k.group(
          'figures',
          ['onHand', 'forecast', 'proposed', 'explanation', 'refreshedAt', 'lastOrder'],
          {
            label: 'Forecast',
          },
        ),
      ],
      chatter: true,
    })),
    'stock.move.list': list(StockMove, {
      columns: ['picking', 'product', 'quantity', 'uom', 'reserved'],
    }),
  },
  search: {
    'stock.return.reason': search(StockReturnReason, { fields: ['name', 'code'] }),
    'stock.picking': search(StockPicking, {
      fields: ['name', 'origin', 'partner.name', 'moves.product.name'],
      filters: {
        open: {
          label: 'To do',
          domain: { state: { in: ['draft', 'confirmed'] } },
          group: 'state',
        },
        ready: { label: 'Ready', domain: { status: 'ready' }, group: 'state' },
        waiting: { label: 'Waiting', domain: { status: 'waiting' }, group: 'state' },
        done: { label: 'Done', domain: { state: 'done' }, group: 'state' },
        receipts: { label: 'Receipts', domain: { kind: 'receipt' }, group: 'kind' },
        deliveries: { label: 'Deliveries', domain: { kind: 'delivery' }, group: 'kind' },
        dropships: { label: 'Dropships', domain: { kind: 'dropship' }, group: 'kind' },
        returns: { label: 'Returns', domain: { returnOf: { ne: null } }, group: 'kind' },
        internal: { label: 'Internal moves', domain: { kind: 'internal' }, group: 'kind' },
        steps: {
          label: 'Steps of a route',
          domain: { or: [{ next: { isNull: false } }, { 'source.step': { isNull: false } }] },
          group: 'kind',
        },
      },
      groupBy: ['kind', 'status', 'partner', 'scheduledDate', 'returnReason'],
    }),
    'stock.quant': search(StockQuant, {
      fields: ['product.name', 'location.fullName'],
      filters: {
        in_stock: { label: 'In stock', domain: { quantity: { gt: 0 } } },
        reserved: { label: 'Reserved', domain: { reserved: { gt: 0 } } },
      },
      groupBy: ['product', 'location'],
    }),
    'stock.reservation': search(StockReservation, {
      fields: ['label', 'quant.product.name'],
      groupBy: ['quant'],
    }),
    'stock.warehouse': search(StockWarehouse, { fields: ['name', 'code'] }),
    'stock.count': search(StockCount, {
      fields: ['name', 'location.fullName'],
      filters: {
        open: { label: 'To do', domain: { state: { in: ['draft', 'counting'] } } },
        applied: { label: 'Applied', domain: { state: 'done' } },
      },
      groupBy: ['location', 'user'],
    }),
    'stock.scrap': search(StockScrap, {
      fields: ['name', 'product.name'],
      groupBy: ['reason', 'product', 'date'],
    }),
    'stock.count.line': search(StockCountLine, { fields: ['product.name', 'count.name'] }),
    'stock.lot': search(StockLot, {
      fields: ['name', 'product.name'],
      filters: {
        in_stock: { label: 'In stock', domain: { qtyOnHand: { gt: 0 } } },
      },
      groupBy: ['product', 'expiryDate'],
    }),
    'stock.lot.line': search(StockLotLine, {
      fields: ['lot.name', 'product.name', 'picking.name'],
    }),
    'stock.location': search(StockLocation, {
      fields: ['fullName'],
      filters: { internal: { label: 'Internal', domain: { usage: 'internal' } } },
      groupBy: ['warehouse', 'usage'],
    }),
    'stock.move': search(StockMove, { fields: ['product.name', 'picking.name'] }),
    'stock.putaway': search(StockPutaway, {
      fields: ['location.fullName', 'product.name', 'category.name'],
      groupBy: ['location', 'category'],
    }),
    'stock.reorder': search(StockReorder, {
      fields: ['product.name', 'warehouse.name', 'vendor.name'],
      filters: {
        to_order: { label: 'To order', domain: { proposed: { gt: 0 } }, group: 'state' },
        snoozed: { label: 'Snoozed', domain: { snoozedUntil: { isNull: false } }, group: 'state' },
        automatic: { label: 'Ordered automatically', domain: { auto: true } },
      },
      groupBy: ['warehouse', 'method', 'vendor'],
    }),
  },
  // Products show what they have in stock, where, and what is reserved.
  viewExtensions: [
    {
      view: 'product.product.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'product_on_hand',
              label: 'On hand',
              model: 'stock.quant',
              where: { product: { $record: 'id' }, 'location.usage': 'internal' },
              measure: { sum: 'quantity' },
              action: 'stockroom.action_stock',
            }),
            stat({
              id: 'product_reorder',
              label: 'Reorder rules',
              model: 'stock.reorder',
              where: { product: { $record: 'id' } },
              action: 'stockroom.action_reorder',
            }),
          ],
        },
      ],
    },
    {
      view: 'product.product.form',
      operations: [
        {
          insertAfter: 'prices',
          nodes: [
            {
              kind: 'group',
              id: 'stock_quantities',
              label: 'Stock',
              children: [
                field({ field: 'tracking', id: 'stock_tracking' }),
                field({ field: 'qtyOnHand', id: 'stock_on_hand' }),
                field({ field: 'qtyReserved', id: 'stock_reserved' }),
                field({ field: 'qtyAvailable', id: 'stock_available' }),
              ],
            },
          ],
        },
      ],
    },
    {
      view: 'product.product.list',
      operations: [
        {
          insertAfter: 'listPrice',
          nodes: [field({ field: 'qtyAvailable', id: 'stock_list_available' })],
        },
      ],
    },
  ],
});
