/**
 * The data layer of fixed assets (RFC 0024 §2.5): **categories** (the accounts, the journal, the method and life,
 * the tax book's rate), **assets** (from a posted bill's line on a category's asset account, or by hand) with their
 * **board** of month-end depreciation lines — each posted once — and, for units of production, the **usage** of each
 * month. A running asset is disposed of or sold with its gain or loss, revalued or impaired (the rest of its board
 * planned again); a fully depreciated one closes.
 */
import { accountingShutro } from '@kosh/accounting';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const ZERO = orm.toDecimal(0);

const METHODS = {
  linear: 'Straight line',
  degressive: 'Declining balance',
  units: 'Units of production',
} as const;

export const AssetCategory = defineModel('account.asset.category', {
  label: 'Asset category',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'account.user': READ, 'account.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    assetAccount: f.many2one('account.account', {
      required: true,
      ondelete: 'restrict',
      label: 'Asset account',
      help: 'A bill line on this account makes a draft asset of this category.',
    }),
    accumulatedAccount: f.many2one('account.account', {
      required: true,
      ondelete: 'restrict',
      label: 'Accumulated depreciation',
    }),
    expenseAccount: f.many2one('account.account', {
      required: true,
      ondelete: 'restrict',
      label: 'Depreciation expense',
    }),
    gainAccount: f.many2one('account.account', { ondelete: 'restrict', label: 'Gain on disposal' }),
    lossAccount: f.many2one('account.account', {
      ondelete: 'restrict',
      label: 'Loss on disposal or impairment',
    }),
    journal: f.many2one('account.journal', { required: true, ondelete: 'restrict' }),
    method: f.selection(METHODS, {
      required: true,
      default: 'linear',
      help: 'Straight line over the life; declining balance at the rate, switching to straight line at the end; units of production by usage.',
    }),
    lifeMonths: f.integer({ required: true, default: 60, label: 'Life (months)' }),
    rate: f.decimal({ scale: 2, default: '20', label: 'Declining rate (% a year)' }),
    prorata: f.boolean({
      default: true,
      label: 'From the date of use',
      help: 'The first month counts from the day the asset is put to use.',
    }),
    taxRate: f.decimal({
      scale: 2,
      label: 'Tax depreciation (% a year)',
      help: 'The tax book: reducing balance at this rate (Bangladesh: the Third Schedule of the Income Tax Act — verify for the year).',
    }),
  },
  sqlConstraints: {
    life: { check: orm.sql`life_months > 0`, message: 'An asset’s life is at least a month.' },
  },
});

const STATES = {
  draft: 'Draft',
  running: 'Running',
  disposed: 'Disposed',
  closed: 'Fully depreciated',
} as const;

export const Asset = defineModel('account.asset', {
  label: 'Fixed asset',
  recName: 'name',
  order: ['dateInUse desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'value', 'salvage', 'method', 'lifeMonths'],
  access: { 'account.user': READ, 'account.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    code: f.char({ size: 64, label: 'Tag', help: 'The tag on the asset, scanned in counts.' }),
    category: f.many2one('account.asset.category', { required: true, ondelete: 'restrict' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Vendor' }),
    bill: f.many2one('account.move', { ondelete: 'set null', label: 'From bill' }),
    billLine: f.many2one('account.move.line', { ondelete: 'set null', label: 'From bill line' }),
    analytic: f.many2one('account.analytic', { ondelete: 'set null', label: 'Cost centre' }),
    value: f.decimal({ scale: 2, required: true, label: 'Cost' }),
    salvage: f.decimal({ scale: 2, required: true, default: '0', label: 'Salvage value' }),
    dateAcquired: f.date({ required: true, label: 'Acquired' }),
    dateInUse: f.date({ required: true, label: 'In use from' }),
    method: f.selection(METHODS, {
      required: true,
      default: 'linear',
      help: 'From the category; changeable while the asset is a draft.',
    }),
    lifeMonths: f.integer({ required: true, default: 60, label: 'Life (months)' }),
    rate: f.decimal({ scale: 2, default: '20', label: 'Declining rate (% a year)' }),
    prorata: f.boolean({ default: true, label: 'From the date of use' }),
    totalUnits: f.decimal({
      scale: 2,
      label: 'Units over its life',
      help: 'Units of production: hours, kilometres, pieces.',
    }),
    lines: f.one2many('account.asset.line', 'asset', { label: 'Board' }),
    usage: f.one2many('account.asset.usage', 'asset'),
    depreciated: f.decimal({
      scale: 2,
      label: 'Depreciated (posted)',
      help: 'The posted depreciation, impairments included.',
      ...compute(
        'account.asset',
        'depreciated',
        ['lines.amount', 'lines.posted', 'lines.kind'],
        (assets) => {
          for (const a of assets)
            a.depreciated = [...a.lines]
              .filter((l) => l.posted && (l.kind === 'depreciation' || l.kind === 'impairment'))
              .reduce((s, l) => s.plus(l.amount), ZERO);
        },
      ),
      store: true,
    }),
    bookValue: f.decimal({
      scale: 2,
      label: 'Book value',
      help: 'The cost, revaluations included, less what was depreciated.',
      ...compute(
        'account.asset',
        'bookValue',
        ['value', 'depreciated', 'lines.amount', 'lines.kind', 'lines.posted'],
        (assets) => {
          for (const a of assets) {
            const revalued = [...a.lines]
              .filter((l) => l.posted && l.kind === 'revaluation')
              .reduce((s, l) => s.plus(l.amount), ZERO);
            a.bookValue = a.value.plus(revalued).minus(a.depreciated ?? ZERO);
          }
        },
      ),
      store: true,
    }),
    disposedOn: f.date({ label: 'Disposed on' }),
    proceeds: f.decimal({ scale: 2, label: 'Sold for' }),
    state: f.state({
      states: STATES,
      initial: 'draft',
      help: 'A running asset is depreciated month by month; disposing of it, or the last month, ends it.',
      transitions: {
        confirm: {
          from: ['draft'],
          to: 'running',
          after: records('account.asset', async (assets) => {
            const env = assets.env as unknown as Env;
            await env.flush();
            const { planBoard } = await import('./books.js');
            await env.asSuperuser({ reason: 'asset board' }, async (su) => {
              await planBoard(su, assets.ids as readonly number[]);
              await su.flush();
            });
          }),
        },
        dispose: { from: ['running'], to: 'disposed' },
        close: { from: ['running'], to: 'closed' },
      },
    }),
  },
  sqlConstraints: {
    amounts: {
      check: orm.sql`value > 0 AND salvage >= 0 AND salvage < value AND life_months > 0`,
      message: 'The cost is positive, the salvage value below it, the life at least a month.',
    },
    dates: {
      check: orm.sql`date_in_use >= date_acquired`,
      message: 'An asset is used after it is acquired.',
    },
  },
  constraints: {
    units: {
      ...check('account.asset', ['method', 'totalUnits'], (assets) =>
        [...assets]
          .filter((a) => a.method === 'units' && (a.totalUnits === null || a.totalUnits.lte(0)))
          .map((a) => a.id),
      ),
      message: 'Units of production need the units over the asset’s life.',
    },
  },
});

export const AssetLine = defineModel('account.asset.line', {
  label: 'Depreciation line',
  order: ['date asc', 'id asc'],
  access: { 'account.user': READ, 'account.manager': ALL },
  fields: {
    asset: f.many2one('account.asset', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true }),
    kind: f.selection(
      {
        depreciation: 'Depreciation',
        impairment: 'Impairment',
        revaluation: 'Revaluation',
        disposal: 'Disposal',
      },
      {
        required: true,
        default: 'depreciation',
        help: 'Depreciation and impairment lower the book value; a revaluation raises it.',
      },
    ),
    amount: f.decimal({ scale: 2, required: true }),
    posted: f.boolean({ default: false }),
    move: f.many2one('account.move', { ondelete: 'restrict', label: 'Journal entry' }),
  },
});

export const AssetUsage = defineModel('account.asset.usage', {
  label: 'Asset usage',
  order: ['date asc', 'id asc'],
  access: { 'account.user': READ, 'account.manager': ALL },
  fields: {
    asset: f.many2one('account.asset', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true, help: 'The month it was used in (its last day).' }),
    units: f.decimal({ scale: 2, required: true }),
    line: f.many2one('account.asset.line', { ondelete: 'set null', label: 'Depreciated by' }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`units > 0`, message: 'Usage is positive.' },
  },
});

export const accountAssetShutro = defineModule({
  name: 'account_asset',
  version: '0.1.0',
  depends: [accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'account_asset.user',
      label: 'Fixed assets',
      implies: ['account.user'],
    }),
  ],
  models: [AssetCategory, Asset, AssetLine, AssetUsage],
});
