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
import { action, field, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { StockValuationLayer, stockAccountShutro, stockAccountsOf } from './module.js';

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
  depends: [stock, accounting, product],
  bridge: [stock, accounting],
  hooks: { defaults: async (env) => stockDefaults(env as Env) },
  accessLevels: {
    user: { label: 'Stock valuation (read)', groups: ['stock_account.user'] },
  },
  routes: (context: ModuleContext) => registerValuationRoutes(context),
  actions: {
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
    'stock.valuation.layer.pivot': pivot(StockValuationLayer, {
      rows: ['product'],
      measures: [{ sum: 'quantity' }, { sum: 'value' }],
    }),
  },
  search: {
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
          nodes: [field({ field: 'costMethod', id: 'product_cost_method' })],
        },
      ],
    },
  ],
});
