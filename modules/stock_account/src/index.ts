/**
 * @packageDocumentation
 * `@kosh/stock_account`: the bridge between Stockroom and Accounting (RFC 0021 step 3). Proposed whenever both apps
 * are installed. Stock is valued as it moves — average cost or FIFO, per product or its category — and posted at once
 * in the Stock journal; Stockroom › Valuation shows the layers by product, and the stock's value at any date.
 *
 * - `GET /api/v1/stockroom/valuation?date=YYYY-MM-DD`   the quantity and value of each product at the end of a date
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { stock } from '@kosh/stock';
import { action, field, form, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { landedCostFromBill, previewLandedCost, StockLandedCost } from './landed.js';
import { StockValuationLayer, stockAccountShutro, stockAccountsOf } from './module.js';

export {
  landedCostFromBill,
  previewLandedCost,
  type Share,
  StockLandedCost,
  StockLandedCostLine,
} from './landed.js';

export {
  CategoryValuation,
  CompanyStockAccounts,
  MoveCost,
  PickingLayers,
  PickingValued,
  ProductValuation,
  STOCK_ACCOUNTS,
  StockValuationLayer,
  stockAccountShutro,
  stockAccountsOf,
} from './module.js';

/** Every company with a chart gets the stock accounts and the Stock journal (again after a chart is installed). */
async function stockDefaults(env: Env): Promise<string | undefined> {
  return env.asSuperuser({ reason: 'stock accounts' }, async (su) => {
    let ready = 0;
    for (const company of (await su.model('res.company').search({})).ids)
      if ((await stockAccountsOf(su, company)) !== null) ready += 1;
    await su.flush();
    return ready === 0 ? undefined : `stock accounts ready in ${ready} company(ies)`;
  });
}

/** Landed costs (RFC 0030 §3.3): the split before posting, and a draft from a vendor bill's landed-cost lines. */
function registerLandedCostRoutes({ app }: ModuleContext): void {
  const id = (params: unknown) => {
    const n = Number((params as { id?: unknown }).id);
    if (!Number.isSafeInteger(n) || n <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'A record id.');
    return n;
  };
  app.get('/api/v1/stockroom/landed-costs/:id/preview', async (request) => {
    const cost = id(request.params);
    return request.env(async (env) => ({ lines: await previewLandedCost(env as Env, cost) }));
  });
  app.post('/api/v1/stockroom/landed-costs/from-bill/:id', async (request) => {
    const bill = id(request.params);
    return request.env((env) => landedCostFromBill(env as Env, bill), { write: true });
  });
}

function registerValuationRoutes({ app }: ModuleContext): void {
  app.get('/api/v1/stockroom/valuation', async (request) => {
    const date = (request.query as { date?: unknown }).date;
    if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)))
      throw new HttpProblem(400, 'invalid-date', 'Invalid date', 'A date as YYYY-MM-DD.');
    return request.env(async (raw) => {
      const env = raw as Env;
      const rows = await env.model('stock.valuation.layer').aggregate({
        ...(date === undefined ? {} : { where: { date: { lte: date } } }),
        groupBy: ['product'],
        measures: { quantity: { sum: 'quantity' }, value: { sum: 'value' } },
      } as never);
      return {
        date: date ?? null,
        products: (rows as { product: unknown; quantity: unknown; value: unknown }[]).map((r) => ({
          product: r.product,
          quantity: String(r.quantity ?? '0'),
          value: orm.toDecimal(String(r.value ?? '0')).toFixed(2),
        })),
      };
    });
  });
}

export const stockAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: stockAccountShutro,
  kosh: '^0.1.0',
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'stock.landed.cost',
        reason:
          'Made from a vendor bill or by hand for chosen receipts, then posted; never imported.',
      },
      {
        rule: 'V1',
        model: 'stock.valuation.layer',
        reason: 'A ledger read in lists and pivots; layers are written by transfers.',
      },
    ],
  },
  depends: [stock, accounting, product],
  bridge: [stock, accounting],
  hooks: { defaults: async (env) => stockDefaults(env as Env) },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Stock valuation (read)', groups: ['stock_account.user'] },
  },
  routes: (context: ModuleContext) => {
    registerValuationRoutes(context);
    registerLandedCostRoutes(context);
  },
  events: [
    {
      topic: 'stock.landed.cost.posted',
      model: 'stock.landed.cost',
      label: 'Landed cost posted',
    },
  ],
  documents: [
    {
      key: 'landed_cost',
      name: 'Landed cost',
      model: 'stock.landed.cost',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Landed cost {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'about',
            items: [
              { label: 'Date', bind: 'date' },
              { label: 'Vendor bill', bind: 'vendorBill.name' },
              { label: 'Status', bind: 'state' },
              { label: 'Total', bind: 'amountTotal' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Cost', bind: 'product.name' },
              { label: 'Description', bind: 'name' },
              { label: 'Split', bind: 'split' },
              { label: 'Amount', bind: 'amount' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
        ],
      },
    },
  ],
  actions: {
    'stockroom.action_landed_costs': action(StockLandedCost, {
      label: 'Landed costs',
      views: ['list', 'form'],
    }),
    'stockroom.action_valuation': action(StockValuationLayer, {
      label: 'Valuation',
      views: ['pivot', 'list'],
    }),
  },
  menus: [
    {
      id: 'stockroom.valuation',
      parent: 'stockroom.root',
      label: 'Valuation',
      action: 'stockroom.action_valuation',
      sequence: 7,
    },
    {
      id: 'stockroom.landed_costs',
      parent: 'stockroom.root',
      label: 'Landed costs',
      action: 'stockroom.action_landed_costs',
      sequence: 7.5,
    },
  ],
  views: {
    'stock.valuation.layer.list': list(StockValuationLayer, {
      columns: [
        'date',
        'product',
        'picking',
        'quantity',
        'unitCost',
        { field: 'value', sum: true },
        'remainingQty',
        'accountMove',
      ],
      defaultOrder: ['date desc', 'id desc'],
    }),
    'stock.landed.cost.list': list(StockLandedCost, {
      columns: ['name', 'date', 'vendorBill', { field: 'amountTotal', sum: true }, 'state'],
      defaultOrder: ['date desc', 'id desc'],
    }),
    'stock.landed.cost.form': form(StockLandedCost, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('post', { primary: true, label: 'Post' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this landed cost?' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'date', 'vendorBill', 'move', 'amountTotal'], {
          description:
            'Choose the done receipts, add the costs and how each is split; the preview shows each line’s share before posting.',
        }),
        k.group('receipts', [{ field: 'pickings', widget: 'tags' }], {
          label: 'Receipts',
          columns: 1,
        }),
        k.lines(
          'lines' as never,
          [
            { field: 'product', id: 'cost_product' },
            { field: 'name', id: 'cost_name' },
            { field: 'split', id: 'cost_split' },
            { field: 'amount', id: 'cost_amount' },
          ] as never,
        ),
        k.component('landed_preview', 'stock_account.LandedPreview'),
        k.group('about', ['note'], { columns: 1 }),
      ],
      readonlyWhen: { state: { ne: 'draft' } },
      chatter: true,
    })),
    'stock.valuation.layer.pivot': pivot(StockValuationLayer, {
      rows: ['product'],
      measures: [{ sum: 'quantity' }, { sum: 'value' }],
    }),
  },
  search: {
    'stock.landed.cost': search(StockLandedCost, {
      fields: ['name', 'vendorBill.name', 'pickings.name'],
      filters: {
        draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
        posted: { label: 'Posted', domain: { state: 'posted' }, group: 'state' },
      },
      groupBy: ['state', 'date:month'],
    }),
    'stock.valuation.layer': search(StockValuationLayer, {
      fields: ['product.name', 'picking.name'],
      filters: {
        incoming: { label: 'In', domain: { quantity: { gt: '0' } }, group: 'direction' },
        outgoing: { label: 'Out', domain: { quantity: { lt: '0' } }, group: 'direction' },
      },
      groupBy: ['product', 'date'],
    }),
  },
  viewExtensions: [
    {
      view: 'product.category.form',
      operations: [
        {
          append: 'main',
          nodes: [
            field({ field: 'costMethod', id: 'category_cost_method' }),
            field({ field: 'stockValuationAccount', id: 'category_valuation_account' }),
            field({ field: 'stockCogsAccount', id: 'category_cogs_account' }),
          ],
        },
      ],
    },
    {
      view: 'product.product.form',
      operations: [
        {
          append: 'stock_quantities',
          nodes: [
            field({ field: 'costMethod', id: 'product_cost_method' }),
            field({ field: 'landedCost', id: 'product_landed_cost' }),
            field({ field: 'landedSplit', id: 'product_landed_split' }),
          ],
        },
      ],
    },
  ],
});
