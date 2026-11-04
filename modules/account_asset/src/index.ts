/**
 * @packageDocumentation
 * `@kosh/account_asset` (RFC 0024 §2.5): **Fixed assets** in Accounting. Categories with their accounts, method and
 * life; assets from posted bills (a line on a category's asset account) or by hand; boards planned ahead — straight
 * line with prorata, declining balance switching to straight line, units of production by usage — posted month by
 * month, once each, with the asset's cost centre; disposal and sale with the gain or loss; revaluation and
 * impairment; and a tax book (reducing balance at the category's tax rate) beside the accounting book.
 *
 * - `POST /api/v1/assets/post-due`             `{ date }`: every running asset's lines due, posted
 * - `POST /api/v1/assets/:id/dispose`          `{ date, proceeds?, account? }`: disposed of or sold
 * - `POST /api/v1/assets/:id/revalue`          `{ date, value }`: revalued or impaired
 * - `GET  /api/v1/assets/tax-book?year=`       the tax book of the fiscal year starting in `year`
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import { orm, type Worker } from '@kosh/server/orm';
import { action, form, list, pivot, search, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { assetsFromBill, dispose, postDue, revalue, taxBookOf } from './books.js';
import { assetDemo } from './demo.js';
import { Asset, AssetCategory, AssetLine, accountAssetShutro } from './module.js';

export { board, taxBook, unitsLine } from './board.js';
export {
  assetsFromBill,
  dispose,
  planBoard,
  postDue,
  revalue,
  type TaxBookRow,
  taxBookOf,
} from './books.js';
export { Asset, AssetCategory, AssetLine, AssetUsage, accountAssetShutro } from './module.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The subscriber that makes draft assets of posted bills; tests `drain()` it, the server starts it. */
export function assetWorker(context: Pick<ModuleContext, 'shutro'>): Worker {
  return context.shutro.subscribe(
    'account_asset.bills',
    'account.move.posted',
    async (event, env) => {
      const payload = (event.payload ?? {}) as { id?: unknown; kind?: unknown };
      if (payload.kind !== 'in_invoice') return;
      const id = Number(payload.id);
      if (Number.isInteger(id) && id > 0)
        await (env as unknown as Env).asSuperuser({ reason: 'assets from a bill' }, (su) =>
          assetsFromBill(su, id),
        );
    },
    { pollMs: 5000 },
  );
}

function registerAssetRoutes(context: ModuleContext): void {
  const { app } = context;
  const managers = (env: Env) => {
    if (!env.administrator && !env.groups.has('account.manager'))
      throw new HttpProblem(
        403,
        'access',
        'Accounting managers',
        'This needs the Accounting manager role.',
      );
  };
  const dateOf = (v: unknown) => {
    if (typeof v !== 'string' || !DATE.test(v))
      throw new HttpProblem(422, 'invalid-date', 'Invalid date', 'Give the date as YYYY-MM-DD.');
    return v;
  };
  const amountOf = (v: unknown, what: string) => {
    const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
    if (!/^\d+(\.\d+)?$/.test(text))
      throw new HttpProblem(422, 'invalid-amount', 'Invalid amount', `Give ${what} as a number.`);
    return orm.toDecimal(text);
  };
  const asProblem = (error: unknown): never => {
    if (error instanceof orm.ValidationError)
      throw new HttpProblem(422, 'invalid', 'Not possible', error.message);
    throw error;
  };

  app.post('/api/v1/assets/post-due', async (request) => {
    const date = dateOf((request.body as Record<string, unknown> | null)?.['date']);
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        managers(env);
        return env.asSuperuser({ reason: 'post depreciation' }, async (su) => ({
          posted: await postDue(su, date),
        }));
      },
      { write: true },
    );
  });

  app.post('/api/v1/assets/:id/dispose', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const date = dateOf(body['date']);
    const proceeds =
      body['proceeds'] === undefined
        ? orm.toDecimal(0)
        : amountOf(body['proceeds'], 'the proceeds');
    const account =
      body['account'] === undefined || body['account'] === null ? null : Number(body['account']);
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        managers(env);
        return env.asSuperuser({ reason: 'asset disposal' }, async (su) => {
          const move = await dispose(su, id, { date, proceeds, account }).catch(asProblem);
          await audit(env, {
            kind: 'asset.disposed',
            summary: `Asset ${id} disposed of.`,
            targetModel: 'account.asset',
            targetId: id,
            ip: request.ip,
          });
          return { move };
        });
      },
      { write: true },
    );
  });

  app.post('/api/v1/assets/:id/revalue', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const date = dateOf(body['date']);
    const value = amountOf(body['value'], 'the new value');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        managers(env);
        return env.asSuperuser({ reason: 'asset revaluation' }, async (su) => {
          const move = await revalue(su, id, { date, value }).catch(asProblem);
          await audit(env, {
            kind: 'asset.revalued',
            summary: `Asset ${id} revalued to ${value.toString()}.`,
            targetModel: 'account.asset',
            targetId: id,
            ip: request.ip,
          });
          return { move };
        });
      },
      { write: true },
    );
  });

  app.get('/api/v1/assets/tax-book', async (request) => {
    const year = Number((request.query as { year?: string }).year);
    if (!Number.isInteger(year) || year < 1990 || year > 2100)
      throw new HttpProblem(
        422,
        'invalid-year',
        'Invalid year',
        'Give the year the fiscal year starts in (2026).',
      );
    return request.env(async (raw) => {
      const env = raw as unknown as Env;
      if (!env.administrator && !env.groups.has('account.user'))
        throw new HttpProblem(403, 'access', 'Accountants', 'This needs the Accountant role.');
      return { year, rows: await taxBookOf(env, year) };
    });
  });

  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const worker = assetWorker(context);
  worker.start();
  // Depreciation due, daily, company by company.
  const run = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const companies = await context.shutro.bootstrap(
        { reason: 'depreciation' },
        async (env) => (await (env as unknown as Env).model('res.company').search({})).ids,
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'depreciation', company }, (env) =>
          (env as unknown as Env).asSuperuser({ reason: 'depreciation' }, (su) =>
            postDue(su, today),
          ),
        );
    } catch (error) {
      app.log.error({ err: error }, 'depreciation');
    }
  };
  const timer = setInterval(() => void run(), 86_400_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await worker.stop();
  });
}

export const accountAsset: ReturnType<typeof defineModule> = defineModule({
  shutro: accountAssetShutro,
  kosh: '^0.1.0',
  hooks: { demo: assetDemo },
  depends: [accounting],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Fixed assets', groups: ['account_asset.user'] },
  },
  routes: (context: ModuleContext) => registerAssetRoutes(context),
  events: [{ topic: 'account.asset.disposed', model: 'account.asset', label: 'Asset disposed of' }],
  documents: [
    {
      key: 'asset_card',
      name: 'Asset card',
      model: 'account.asset',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'asset',
            items: [
              { label: 'Tag', bind: 'code' },
              { label: 'Category', bind: 'category.name' },
              { label: 'Vendor', bind: 'partner.name' },
              { label: 'Acquired', bind: 'dateAcquired' },
              { label: 'Cost', bind: 'value' },
              { label: 'Depreciated', bind: 'depreciated' },
              { label: 'Book value', bind: 'bookValue' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'board',
            bind: 'lines',
            columns: [
              { label: 'Date', bind: 'date' },
              { label: 'Kind', bind: 'kind' },
              { label: 'Amount', bind: 'amount' },
              { label: 'Posted', bind: 'posted' },
            ],
          },
          { kind: 'qr', id: 'qr', bind: 'code', size: 22, label: 'Asset tag' },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'assets',
      model: 'account.asset',
      label: 'Fixed assets (opening register)',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Tag', field: 'code' },
        { header: 'Category', field: 'category' },
        { header: 'Cost', field: 'value' },
        { header: 'Salvage value', field: 'salvage' },
        { header: 'Acquired', field: 'dateAcquired' },
        { header: 'In use from', field: 'dateInUse' },
        { header: 'Life (months)', field: 'lifeMonths' },
      ],
    },
    {
      key: 'categories',
      model: 'account.asset.category',
      label: 'Asset categories',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Asset account', field: 'assetAccount' },
        { header: 'Accumulated depreciation', field: 'accumulatedAccount' },
        { header: 'Depreciation expense', field: 'expenseAccount' },
        { header: 'Journal', field: 'journal' },
        { header: 'Method', field: 'method' },
        { header: 'Life (months)', field: 'lifeMonths' },
        { header: 'Tax depreciation (%)', field: 'taxRate' },
      ],
    },
  ],
  actions: {
    'accounting.action_assets': action(Asset, {
      label: 'Fixed assets',
      views: ['list', 'form', 'pivot'],
    }),
    'accounting.action_asset_categories': action(AssetCategory, {
      label: 'Asset categories',
      views: ['list', 'form'],
    }),
  },
  menus: [
    {
      id: 'accounting.assets',
      parent: 'accounting.root',
      label: 'Fixed assets',
      action: 'accounting.action_assets',
      sequence: 6,
    },
    {
      id: 'accounting.asset_categories',
      parent: 'accounting.configuration',
      label: 'Asset categories',
      action: 'accounting.action_asset_categories',
      sequence: 8,
    },
  ],
  views: {
    'account.asset.list': list(Asset, {
      columns: [
        'code',
        'name',
        'category',
        'dateInUse',
        'value',
        'depreciated',
        'bookValue',
        'state',
      ],
      defaultOrder: ['dateInUse desc'],
    }),
    'account.asset.pivot': pivot(Asset, {
      rows: ['category'],
      cols: ['state'],
      measures: [{ sum: 'value' }, { sum: 'bookValue' }],
    }),
    'account.asset.form': form(Asset, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [k.button('confirm', { primary: true, label: 'Confirm and plan the board' })],
      },
      readonlyWhen: { state: { in: ['disposed', 'closed'] } },
      sheet: [
        k.stats('related', [
          stat({
            id: 'asset_posted',
            label: 'Depreciation posted',
            model: AssetLine,
            where: { asset: { $record: 'id' }, posted: true, kind: 'depreciation' },
            measure: { sum: 'amount' },
          }),
        ]),
        k.group('main', ['name', 'code', 'category', 'partner', 'bill', 'analytic']),
        k.group(
          'worth',
          ['value', 'salvage', 'dateAcquired', 'dateInUse', 'depreciated', 'bookValue'],
          { label: 'Value' },
        ),
        k.group('depreciation', ['method', 'lifeMonths', 'rate', 'prorata', 'totalUnits'], {
          label: 'Depreciation',
          description: 'Confirming plans the board; a revaluation plans the rest of it again.',
        }),
        k.lines(
          'lines',
          ['date', 'kind', { field: 'amount', id: 'line_amount' }, 'posted', 'move'],
          { readonlyWhen: {} },
        ),
        k.lines('usage', [{ field: 'date', id: 'usage_date' }, 'units', 'line']),
        k.group('disposal', ['disposedOn', 'proceeds'], { label: 'Disposal' }),
      ],
      chatter: true,
    })),
    'account.asset.category.list': list(AssetCategory, {
      columns: ['name', 'method', 'lifeMonths', 'rate', 'taxRate', 'assetAccount'],
    }),
    'account.asset.category.form': form(AssetCategory, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'method', 'lifeMonths', 'rate', 'prorata']),
        k.group(
          'accounts',
          [
            'assetAccount',
            'accumulatedAccount',
            'expenseAccount',
            'gainAccount',
            'lossAccount',
            'journal',
          ],
          {
            label: 'Accounts',
          },
        ),
        k.group('tax', ['taxRate'], { label: 'Tax book' }),
      ],
    })),
  },
  search: {
    'account.asset': search(Asset, {
      fields: ['name', 'code', 'partner.name'],
      filters: {
        running: { label: 'Running', domain: { state: 'running' }, group: 'state' },
        draft: { label: 'To confirm', domain: { state: 'draft' }, group: 'state' },
      },
      groupBy: ['category', 'state', 'analytic', 'dateAcquired:year'],
    }),
    'account.asset.category': search(AssetCategory, { fields: ['name'], groupBy: ['method'] }),
  },
});
