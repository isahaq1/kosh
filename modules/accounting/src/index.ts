/**
 * @packageDocumentation
 * `@kosh/accounting` (RFC 0009): the Accounting app. Step 1, the ledger core: chart of accounts (generic and
 * Bangladesh templates), journals, fiscal years and lock dates, currency rates, and journal entries posted in exact
 * money, numbered gaplessly per journal type, immutable once posted and corrected by reversal. Invoices, bills,
 * payments, reconciliation and the reports follow (RFC 0009 §10).
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, form, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import {
  CHARTS,
  ChartInstalledError,
  type ChartTemplate,
  installChart,
  installedChart,
  installImmutability,
} from './chart.js';
import {
  AccountAccount,
  AccountFiscalYear,
  AccountJournal,
  AccountMove,
  accountingShutro,
  REVERSED_KIND,
  ResCurrencyRate,
} from './module.js';

export {
  CHARTS,
  type ChartInstalled,
  ChartInstalledError,
  type ChartTemplate,
  installChart,
  installedChart,
  installImmutability,
} from './chart.js';
export {
  ACCOUNT_TYPES,
  AccountAccount,
  AccountFiscalYear,
  AccountJournal,
  AccountMove,
  AccountMoveLine,
  type AccountType,
  accountingShutro,
  CompanyAccounting,
  JOURNAL_TYPES,
  type JournalType,
  MOVE_KINDS,
  type MoveKind,
  NUMBER_FIELD,
  REVERSED_KIND,
  ResCurrencyRate,
  TaxAccounts,
} from './module.js';

export interface Reversed {
  readonly id: number;
  readonly name: string;
  readonly state: string;
}

/**
 * Reverses a posted entry: a new entry in the same journal with every line negated, linked both ways, posted when
 * asked. The original is never touched beyond its `reversedBy` link.
 */
export async function reverseMove(
  env: Env,
  id: number,
  options: { readonly date?: string | undefined; readonly post?: boolean | undefined } = {},
): Promise<Reversed> {
  const moves = env.model('account.move');
  const [m] = await moves.browse([id]).load({
    lines: { account: true, partner: true },
    journal: true,
    partner: true,
    currency: true,
    reversedBy: true,
  });
  if (m === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no entry ${id}.`);
  if (m.state !== 'posted')
    throw new HttpProblem(409, 'not-posted', 'Not posted', 'Only a posted entry is reversed.');
  if (m.reversedBy !== null)
    throw new HttpProblem(
      409,
      'already-reversed',
      'Already reversed',
      `Entry ${m.name} is reversed by ${m.reversedBy.name}.`,
    );
  const created = await moves.create([
    {
      journal: m.journal.id,
      date: options.date ?? env.today(),
      kind: REVERSED_KIND[m.kind],
      partner: m.partner?.id ?? null,
      currency: m.currency.id,
      rate: m.rate,
      ref: `Reversal of ${m.name}`,
      reversalOf: m.id,
      company: m.company.id,
      lines: {
        create: m.lines.map((l) => ({
          account: l.account.id,
          partner: l.partner?.id ?? null,
          name: l.name,
          debit: l.credit.amount,
          credit: l.debit.amount,
          amountCurrency: l.amountCurrency === null ? null : l.amountCurrency.amount.negated(),
          dateMaturity: l.dateMaturity,
        })),
      },
    },
  ]);
  const reversalId = created.ids[0] as (typeof created.ids)[number];
  await moves.browse([m.id]).write({ reversedBy: reversalId });
  if (options.post === true) await created.post();
  const [reversal] = await created.load({});
  return {
    id: reversalId,
    name: reversal?.name ?? '/',
    state: reversal?.state ?? 'draft',
  };
}

const TEMPLATES = Object.keys(CHARTS) as ChartTemplate[];

export const accounting: ReturnType<typeof defineModule> = defineModule({
  shutro: accountingShutro,
  kosh: '^0.1.0',
  depends: [contacts, product, messaging],
  app: {
    code: 'accounting',
    label: 'Accounting',
    icon: 'accounting',
    sequence: 30,
    category: 'Finance',
    summary: 'Chart of accounts, journals, entries posted in exact money',
  },
  accessLevels: {
    invoicing: { label: 'Invoicing (invoices and their payments)', groups: ['account.invoicing'] },
    user: {
      label: 'Accountant (entries, reports)',
      groups: ['account.user'],
      implies: ['invoicing'],
    },
    manager: {
      label: 'Manager (chart, lock dates, closing)',
      groups: ['account.manager'],
      implies: ['user'],
    },
  },
  actions: {
    'accounting.action_moves': action(AccountMove, {
      label: 'Journal entries',
      views: ['list', 'form'],
    }),
    'accounting.action_accounts': action(AccountAccount, {
      label: 'Chart of accounts',
      views: ['list', 'form'],
    }),
    'accounting.action_journals': action(AccountJournal, {
      label: 'Journals',
      views: ['list', 'form'],
    }),
    'accounting.action_fiscal_years': action(AccountFiscalYear, {
      label: 'Fiscal years',
      views: ['list', 'form'],
    }),
    'accounting.action_rates': action(ResCurrencyRate, {
      label: 'Currency rates',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'accounting.root', label: 'Accounting', app: 'accounting' },
    {
      id: 'accounting.moves',
      parent: 'accounting.root',
      label: 'Journal entries',
      action: 'accounting.action_moves',
      sequence: 1,
    },
    {
      id: 'accounting.configuration',
      parent: 'accounting.root',
      label: 'Configuration',
      sequence: 9,
    },
    {
      id: 'accounting.accounts',
      parent: 'accounting.configuration',
      label: 'Chart of accounts',
      action: 'accounting.action_accounts',
      sequence: 1,
    },
    {
      id: 'accounting.journals',
      parent: 'accounting.configuration',
      label: 'Journals',
      action: 'accounting.action_journals',
      sequence: 2,
    },
    {
      id: 'accounting.fiscal_years',
      parent: 'accounting.configuration',
      label: 'Fiscal years',
      action: 'accounting.action_fiscal_years',
      sequence: 3,
    },
    {
      id: 'accounting.rates',
      parent: 'accounting.configuration',
      label: 'Currency rates',
      action: 'accounting.action_rates',
      sequence: 4,
    },
  ],
  views: {
    'account.move.list': list(AccountMove, {
      columns: [
        'name',
        'date',
        'journal',
        'partner',
        'ref',
        { field: 'amountDebit', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['date desc', 'name desc'],
    }),
    'account.move.form': form(AccountMove, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('post', { primary: true, label: 'Post' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this entry?' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['journal', 'date', 'partner', 'ref']),
        k.group('money', ['currency', 'rate', 'kind', 'reversalOf', 'reversedBy']),
        k.lines(
          'lines',
          [
            'account',
            { field: 'partner', id: 'line_partner' },
            { field: 'name', id: 'line_name' },
            'debit',
            'credit',
            'amountCurrency',
            'dateMaturity',
          ],
          { readonlyWhen: { state: { ne: 'draft' } } },
        ),
        k.group('totals', ['amountDebit', 'amountCredit'], { label: 'Totals' }),
        k.group('notes', ['narration'], { columns: 1 }),
      ],
      readonlyWhen: { state: { ne: 'draft' } },
      chatter: true,
    })),
    'account.account.list': list(AccountAccount, {
      columns: ['code', 'name', 'type', 'reconcile', 'currency'],
      defaultOrder: ['code asc'],
      inlineEdit: ['name', 'reconcile'],
    }),
    'account.account.form': form(AccountAccount, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['code', 'name', 'type', 'reconcile', 'currency']),
        k.group('notes', ['note'], { columns: 1 }),
      ],
    })),
    'account.journal.list': list(AccountJournal, {
      columns: ['code', 'name', 'type', 'defaultAccount'],
    }),
    'account.journal.form': form(AccountJournal, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['code', 'name', 'type', 'defaultAccount'])],
    })),
    'account.fiscal.year.list': list(AccountFiscalYear, {
      columns: ['name', 'dateFrom', 'dateTo', { field: 'state', widget: 'badge' }, 'lockDate'],
    }),
    'account.fiscal.year.form': form(AccountFiscalYear, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'dateFrom', 'dateTo', 'state', 'lockDate'])],
    })),
    'res.currency.rate.list': list(ResCurrencyRate, {
      columns: ['date', 'currency', 'rate', 'company'],
      defaultOrder: ['date desc'],
      inlineEdit: ['rate'],
    }),
    'res.currency.rate.form': form(ResCurrencyRate, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['currency', 'date', 'rate', 'company'])],
    })),
  },
  search: {
    'account.move': search(AccountMove, {
      fields: ['name', 'ref', 'partner.name'],
      filters: {
        draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
        posted: { label: 'Posted', domain: { state: 'posted' }, group: 'state' },
        entries: { label: 'Journal entries', domain: { kind: 'entry' }, group: 'kind' },
        invoices: {
          label: 'Invoices and bills',
          domain: { kind: { in: ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'] } },
          group: 'kind',
        },
      },
      groupBy: ['journal', 'state', 'partner', 'date:month'],
    }),
    'account.account': search(AccountAccount, {
      fields: ['code', 'name'],
      filters: {
        receivable: { label: 'Receivable', domain: { type: 'asset_receivable' } },
        payable: { label: 'Payable', domain: { type: 'liability_payable' } },
      },
      groupBy: ['type'],
    }),
  },
  hooks: {
    // The immutability triggers, idempotent (with every seed and app install).
    defaults: async (env) => {
      await installImmutability(env as Env);
      return undefined;
    },
  },
  routes: (context: ModuleContext) => {
    context.app.post('/api/v1/accounting/charts/install', async (request) => {
      const template = (request.body as { template?: unknown } | null)?.template;
      if (typeof template !== 'string' || !TEMPLATES.includes(template as ChartTemplate))
        throw new HttpProblem(
          400,
          'invalid-template',
          'Unknown chart template',
          `template must be one of ${TEMPLATES.join(', ')}.`,
        );
      return request.env(
        async (env) => {
          try {
            return await installChart(env as Env, template as ChartTemplate);
          } catch (error) {
            if (error instanceof ChartInstalledError)
              throw new HttpProblem(
                409,
                'chart-installed',
                'Chart already installed',
                error.message,
              );
            throw error;
          }
        },
        { write: true },
      );
    });
    context.app.get('/api/v1/accounting/charts', async (request) =>
      request.env(async (env) => ({
        installed: await installedChart(env as Env),
        templates: TEMPLATES.map((t) => ({ code: t, label: CHARTS[t].label })),
      })),
    );
    context.app.post('/api/v1/accounting/moves/:id/reverse', async (request) => {
      const id = Number((request.params as { id: string }).id);
      const body = (request.body ?? {}) as { date?: unknown; post?: unknown };
      if (!Number.isInteger(id))
        throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The entry id is an integer.');
      if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date)))
        throw new HttpProblem(400, 'invalid-date', 'Invalid date', 'date is YYYY-MM-DD.');
      return request.env(
        (env) =>
          reverseMove(env as Env, id, {
            date: body.date === undefined ? undefined : String(body.date),
            post: body.post === true,
          }),
        { write: true },
      );
    });
  },
});
