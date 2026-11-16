/**
 * The books at the cut-off, and the proof (RFC 0034 §2.3, step 3 part 2): Odoo's balances become one opening entry,
 * its open receivables and payables open items again, and a reconciliation compares Kosh with Odoo afterwards.
 *
 * - **The opening entry** (dated the cut-off, posted): every balance-sheet account at its Odoo balance, the profit
 *   and loss accounts at this fiscal year's balance (so the year's reports carry on), the earlier years' result on
 *   the retained earnings account — but receivables and payables, which come as open items.
 * - **Open items**: each Odoo line still open on a receivable or payable account. An invoice, a credit note or a bill
 *   becomes a Kosh document of the same kind for what is left to pay — its number as the reference, its dates kept,
 *   posted to the partner's account — so it can be paid, followed up and reconciled; another open item (an advance,
 *   a payment not matched yet) is a line of the opening entry with its partner.
 * - Both meet on an **opening balances** account, which nets to zero when Odoo's receivables and payables equal its
 *   open items.
 *
 * The reconciliation reads Kosh's posted books in the same transaction (before a dry run is rolled back): each
 * account against Odoo, each partner's receivable and payable against Odoo, the opening balances account at zero,
 * every open document present.
 */
import type { Env } from '@kosh/server/orm';
import { orm } from '@kosh/server/orm';
import { idOf, type OdooClient, type OdooRecord, type OdooValue, textOf } from './rpc.js';

type Decimal = ReturnType<typeof orm.toDecimal>;
const dec = (v: OdooValue | undefined | string): Decimal =>
  orm.toDecimal(typeof v === 'number' ? v.toFixed(2) : typeof v === 'string' && v !== '' ? v : '0');
const ZERO = orm.toDecimal(0);

export interface OpeningOptions {
  /** The cut-off date (`YYYY-MM-DD`): balances at the end of this day. Run it with no posting in Odoo after it. */
  readonly cutoff: string;
  /** The first day of the fiscal year the cut-off is in: profit and loss before it is the earlier years' result. */
  readonly yearStart: string;
}

const RECEIVABLE_PAYABLE = ['asset_receivable', 'liability_payable'];
const PL_TYPES = [
  'income',
  'income_other',
  'expense',
  'expense_direct_cost',
  'expense_depreciation',
];
const DOCUMENT_KINDS: Readonly<Record<string, string>> = {
  out_invoice: 'out_invoice',
  out_refund: 'out_refund',
  in_invoice: 'in_invoice',
  in_refund: 'in_refund',
};

interface OpenItem {
  readonly id: number;
  readonly move: number;
  readonly account: number;
  readonly partner: number | null;
  readonly residual: Decimal;
  readonly maturity: string | null;
  readonly name: string;
}
interface OdooMove {
  readonly id: number;
  readonly type: string;
  readonly name: string;
  readonly date: string;
  readonly dateDue: string | null;
  readonly ref: string;
}

/** What is read from Odoo for the opening, before anything is written to Kosh. */
export interface OdooOpening {
  readonly options: OpeningOptions;
  /** Odoo account id → its type. */
  readonly types: ReadonlyMap<number, string>;
  /** Odoo account id → its balance at the cut-off, and this year's for profit and loss. */
  readonly balances: ReadonlyMap<number, Decimal>;
  readonly yearBalances: ReadonlyMap<number, Decimal>;
  /** Each partner's receivable or payable balance at the cut-off, by `account:partner`. */
  readonly partnerBalances: ReadonlyMap<string, Decimal>;
  readonly items: readonly OpenItem[];
  readonly moves: ReadonlyMap<number, OdooMove>;
}

/** Odoo's company of the signed-in user: what is read is that company's books. */
async function odooCompany(client: OdooClient): Promise<number> {
  const [me] = await client.read('res.users', [client.uid], ['company_id']);
  const company = idOf(me?.['company_id']);
  if (company === null) throw new Error('The Odoo user has no company.');
  return company;
}

const sumsBy = (
  rows: readonly Readonly<Record<string, OdooValue>>[],
  key: (r: Readonly<Record<string, OdooValue>>) => string | number | null,
): Map<string | number, Decimal> => {
  const out = new Map<string | number, Decimal>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    out.set(k, (out.get(k) ?? ZERO).plus(dec(r['balance'])));
  }
  return out;
};

export async function readOpening(
  client: OdooClient,
  options: OpeningOptions,
): Promise<OdooOpening> {
  const company = await odooCompany(client);
  const posted = [
    ['parent_state', '=', 'posted'],
    ['company_id', '=', company],
    ['date', '<=', options.cutoff],
  ];
  const accounts = await client.readAll('account.account', ['account_type']);
  const types = new Map(accounts.map((a) => [a.id, textOf(a['account_type'])]));
  const all = await client.group('account.move.line', posted, ['balance:sum'], ['account_id']);
  const year = await client.group(
    'account.move.line',
    [...posted, ['date', '>=', options.yearStart]],
    ['balance:sum'],
    ['account_id'],
  );
  const byPartner = await client.group(
    'account.move.line',
    [...posted, ['account_id.account_type', 'in', RECEIVABLE_PAYABLE]],
    ['balance:sum'],
    ['account_id', 'partner_id'],
  );
  const lines = await client.readAll(
    'account.move.line',
    ['move_id', 'account_id', 'partner_id', 'amount_residual', 'date_maturity', 'name'],
    {
      domain: [
        ...posted,
        ['account_id.account_type', 'in', RECEIVABLE_PAYABLE],
        ['reconciled', '=', false],
        ['amount_residual', '!=', 0],
      ],
    },
  );
  const items: OpenItem[] = lines.map((l: OdooRecord) => ({
    id: l.id,
    move: idOf(l['move_id']) ?? 0,
    account: idOf(l['account_id']) ?? 0,
    partner: idOf(l['partner_id']),
    residual: dec(l['amount_residual']),
    maturity: textOf(l['date_maturity']) || null,
    name: textOf(l['name']),
  }));
  const moveRows = await client.read(
    'account.move',
    [...new Set(items.map((i) => i.move))],
    ['move_type', 'name', 'invoice_date', 'date', 'invoice_date_due', 'ref'],
  );
  const moves = new Map(
    moveRows.map((m) => [
      m.id,
      {
        id: m.id,
        type: textOf(m['move_type']),
        name: textOf(m['name']),
        date: textOf(m['invoice_date']) || textOf(m['date']),
        dateDue: textOf(m['invoice_date_due']) || null,
        ref: textOf(m['ref']),
      },
    ]),
  );
  return {
    options,
    types,
    balances: sumsBy(all, (r) => idOf(r['account_id'])) as Map<number, Decimal>,
    yearBalances: sumsBy(year, (r) => idOf(r['account_id'])) as Map<number, Decimal>,
    partnerBalances: sumsBy(byPartner, (r) =>
      idOf(r['account_id']) === null
        ? null
        : `${idOf(r['account_id'])}:${idOf(r['partner_id']) ?? ''}`,
    ) as Map<string, Decimal>,
    items,
    moves,
  };
}

// ---- Kosh

type Recs = {
  readonly ids: readonly number[];
  readonly length: number;
  read(k: string[]): Record<string, unknown>[];
};
interface Model {
  search(q: unknown): Promise<Recs & { load(k: string[]): Promise<Recs> }>;
  browse(ids: readonly number[]): { post(): Promise<void>; load(k: string[]): Promise<Recs> };
  create(values: unknown): Promise<Recs>;
}
const model = (env: Env, name: string): Model => env.model(name as never) as unknown as Model;
const idOfValue = (v: unknown): number | null =>
  typeof v === 'number'
    ? v
    : typeof v === 'object' && v !== null && 'id' in v
      ? Number((v as { id: unknown }).id)
      : null;
const amount = (d: Decimal): string => d.toFixed(2);

export interface OpeningResult {
  /** `skipped`: an opening at this cut-off was imported before (found by its external id). */
  readonly status: 'done' | 'skipped';
  readonly entry: number | null;
  readonly entryLines: number;
  readonly documents: number;
  readonly failed: readonly { readonly what: string; readonly error: string }[];
}

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly summary: string;
  /** What differs: one line per account, partner or document, with Odoo's figure and Kosh's. */
  readonly differences: readonly {
    readonly what: string;
    readonly odoo: string;
    readonly kosh: string;
  }[];
}

/** Writes the opening entry and the open documents; `ref` maps Odoo ids of earlier steps to Kosh ids. */
export async function writeOpening(
  env: Env,
  data: OdooOpening,
  ref: (model: string, id: number | null) => number | null,
  errorText: (e: unknown) => string,
): Promise<OpeningResult> {
  const { cutoff } = data.options;
  const entryXmlId = `odoo.opening_${cutoff.replaceAll('-', '')}`;
  try {
    await env.refId('account.move' as never, entryXmlId);
    return { status: 'skipped', entry: null, entryLines: 0, documents: 0, failed: [] };
  } catch {
    // not imported yet
  }
  const failed: { what: string; error: string }[] = [];
  const companyId = env.companyId as number;
  const [company] = (
    await model(env, 'res.company')
      .browse([companyId])
      .load(['currency', 'accountRetainedEarnings'])
  ).read(['currency', 'accountRetainedEarnings']);
  const currency = idOfValue(company?.['currency']);
  const retained = idOfValue(company?.['accountRetainedEarnings']);
  const journal = async (tx: Env, type: string) => {
    const found = await model(tx, 'account.journal').search({ where: { type }, limit: 1 });
    if (found.length === 0)
      throw new Error(`No ${type} journal: install a chart of accounts first.`);
    return found.ids[0] as number;
  };

  // The account both sides meet on.
  const clearing = await (async () => {
    const found = await model(env, 'account.account').search({
      where: { code: 'OPENING' },
      limit: 1,
    });
    if (found.length === 1) return found.ids[0] as number;
    const made = await model(env, 'account.account').create([
      { code: 'OPENING', name: 'Opening balances (from Odoo)', type: 'equity' },
    ]);
    return made.ids[0] as number;
  })();

  // ---- the opening entry's lines
  const lines: { account: number; partner?: number; name: string; balance: Decimal }[] = [];
  let earlierResult = ZERO;
  for (const [odooAccount, balance] of data.balances) {
    const type = data.types.get(odooAccount) ?? '';
    if (RECEIVABLE_PAYABLE.includes(type)) continue;
    const account = ref('account.account', odooAccount);
    if (account === null) {
      failed.push({
        what: `Odoo account #${odooAccount}`,
        error: 'not imported: its balance cannot be opened',
      });
      continue;
    }
    const opened = PL_TYPES.includes(type) ? (data.yearBalances.get(odooAccount) ?? ZERO) : balance;
    if (PL_TYPES.includes(type)) earlierResult = earlierResult.plus(balance.minus(opened));
    if (!opened.isZero()) lines.push({ account, name: 'Opening balance', balance: opened });
  }
  if (!earlierResult.isZero()) {
    if (retained === null)
      failed.push({
        what: 'earlier years’ result',
        error: 'the company has no retained earnings account',
      });
    else
      lines.push({
        account: retained,
        name: 'Result of earlier years (from Odoo)',
        balance: earlierResult,
      });
  }
  // Open items that are not documents: on the opening entry, with their partner.
  const documents = new Map<number, OpenItem[]>();
  for (const item of data.items) {
    const move = data.moves.get(item.move);
    if (move !== undefined && DOCUMENT_KINDS[move.type] !== undefined) {
      documents.set(item.move, [...(documents.get(item.move) ?? []), item]);
      continue;
    }
    const account = ref('account.account', item.account);
    const partner = ref('res.partner', item.partner);
    if (account === null) {
      failed.push({ what: `open item ${item.name}`, error: 'its account was not imported' });
      continue;
    }
    lines.push({
      account,
      ...(partner === null ? {} : { partner }),
      name: `Open item: ${move?.name ?? item.name}`,
      balance: item.residual,
    });
  }
  const total = lines.reduce((s, l) => s.plus(l.balance), ZERO);
  if (!total.isZero())
    lines.push({ account: clearing, name: 'Opening balances', balance: total.negated() });

  let entry: number | null = null;
  if (lines.length > 0)
    try {
      entry = await env.transaction(async (tx) => {
        const made = await model(tx, 'account.move').create([
          {
            kind: 'entry',
            journal: await journal(tx, 'general'),
            date: cutoff,
            ref: `Opening balance from Odoo at ${cutoff}`,
            currency,
            lines: {
              create: lines.map((l) => ({
                account: l.account,
                ...(l.partner === undefined ? {} : { partner: l.partner }),
                name: l.name,
                debit: amount(l.balance.isPositive() ? l.balance : ZERO),
                credit: amount(l.balance.isNegative() ? l.balance.negated() : ZERO),
              })),
            },
          },
        ]);
        const id = made.ids[0] as number;
        await model(tx, 'account.move').browse([id]).post();
        await tx.setExternalId('account.move' as never, id, entryXmlId);
        return id;
      });
    } catch (error) {
      failed.push({ what: 'the opening entry', error: errorText(error) });
    }

  // ---- open documents, each for what is left to pay
  let made = 0;
  for (const [moveId, items] of documents) {
    const move = data.moves.get(moveId) as OdooMove;
    const residual = items.reduce((s, i) => s.plus(i.residual), ZERO);
    const partner = ref('res.partner', items[0]?.partner ?? null);
    const due =
      items
        .map((i) => i.maturity)
        .filter((d): d is string => d !== null)
        .sort()[0] ?? move.dateDue;
    try {
      await env.transaction(async (tx) => {
        const sale = move.type.startsWith('out_');
        const created = await model(tx, 'account.move').create([
          {
            kind: DOCUMENT_KINDS[move.type],
            journal: await journal(tx, sale ? 'sale' : 'purchase'),
            partner,
            date: move.date,
            ...(due === null ? {} : { dateDue: due }),
            ref: move.name,
            currency,
            lines: {
              create: [
                {
                  lineKind: 'product',
                  name: `Open balance of ${move.name}${move.ref === '' ? '' : ` (${move.ref})`} from Odoo`,
                  quantity: '1',
                  priceUnit: amount(residual.abs()),
                  account: clearing,
                },
              ],
            },
          },
        ]);
        const id = created.ids[0] as number;
        await model(tx, 'account.move').browse([id]).post();
        await tx.setExternalId('account.move' as never, id, `odoo.account_move_${moveId}`);
      });
      made += 1;
    } catch (error) {
      failed.push({ what: `${move.name}`, error: errorText(error) });
    }
  }
  return { status: 'done', entry, entryLines: lines.length, documents: made, failed };
}

/** Kosh's posted books against Odoo's, at the cut-off. */
export async function reconcile(
  env: Env,
  data: OdooOpening,
  ref: (model: string, id: number | null) => number | null,
): Promise<Check[]> {
  const { cutoff } = data.options;
  const company = env.companyId as number;
  const companyRow = (
    await model(env, 'res.company').browse([company]).load(['accountRetainedEarnings'])
  ).read(['accountRetainedEarnings'])[0];
  const retained = idOfValue(companyRow?.['accountRetainedEarnings']);
  const rows = await env.sql<{
    account_id: number;
    code: string;
    partner_id: number | null;
    account_type: string;
    balance: string;
  }>`
    SELECT l.account_id, a.code, l.partner_id, l.account_type, SUM(l.balance)::text AS balance
    FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id
    WHERE l.posted AND m.company_id = ${company} AND l.date <= ${cutoff}::date
    GROUP BY l.account_id, a.code, l.partner_id, l.account_type`;
  const koshByAccount = new Map<number, Decimal>();
  const koshByPartner = new Map<string, Decimal>();
  const codes = new Map<number, string>();
  for (const r of rows) {
    codes.set(r.account_id, r.code);
    koshByAccount.set(
      r.account_id,
      (koshByAccount.get(r.account_id) ?? ZERO).plus(orm.toDecimal(r.balance)),
    );
    if (RECEIVABLE_PAYABLE.includes(r.account_type)) {
      const k = `${r.account_id}:${r.partner_id ?? ''}`;
      koshByPartner.set(k, (koshByPartner.get(k) ?? ZERO).plus(orm.toDecimal(r.balance)));
    }
  }

  // Each account: Odoo's balance (this year's for profit and loss), the earlier years' result on retained earnings.
  const expected = new Map<number, Decimal>();
  let earlier = ZERO;
  for (const [odooAccount, balance] of data.balances) {
    const account = ref('account.account', odooAccount);
    if (account === null) continue;
    const type = data.types.get(odooAccount) ?? '';
    const shown = PL_TYPES.includes(type) ? (data.yearBalances.get(odooAccount) ?? ZERO) : balance;
    if (PL_TYPES.includes(type)) earlier = earlier.plus(balance.minus(shown));
    expected.set(account, (expected.get(account) ?? ZERO).plus(shown));
  }
  if (retained !== null && !earlier.isZero())
    expected.set(retained, (expected.get(retained) ?? ZERO).plus(earlier));
  const accountDiffs: Check['differences'][number][] = [];
  for (const account of new Set([...expected.keys(), ...koshByAccount.keys()])) {
    const odoo = expected.get(account) ?? ZERO;
    const kosh = koshByAccount.get(account) ?? ZERO;
    if (!odoo.equals(kosh))
      accountDiffs.push({
        what: `account ${codes.get(account) ?? `#${account}`}`,
        odoo: amount(odoo),
        kosh: amount(kosh),
      });
  }

  // Each partner's receivable and payable.
  const partnerDiffs: Check['differences'][number][] = [];
  const expectedByPartner = new Map<string, { odoo: Decimal; label: string }>();
  for (const [key, balance] of data.partnerBalances) {
    const [a, p] = key.split(':');
    const account = ref('account.account', Number(a));
    const partner = p === '' ? null : ref('res.partner', Number(p));
    const k = `${account ?? '?'}:${partner ?? ''}`;
    const prev = expectedByPartner.get(k);
    expectedByPartner.set(k, {
      odoo: (prev?.odoo ?? ZERO).plus(balance),
      label: `partner #${p || '—'} on Odoo account #${a}`,
    });
  }
  for (const k of new Set([...expectedByPartner.keys(), ...koshByPartner.keys()])) {
    const odoo = expectedByPartner.get(k)?.odoo ?? ZERO;
    const kosh = koshByPartner.get(k) ?? ZERO;
    if (!odoo.equals(kosh))
      partnerDiffs.push({
        what: expectedByPartner.get(k)?.label ?? `Kosh ${k}`,
        odoo: amount(odoo),
        kosh: amount(kosh),
      });
  }

  // The opening balances account nets to zero.
  const [clearing] = await env.sql<{ balance: string | null }>`
    SELECT SUM(l.balance)::text AS balance FROM account_move_line l JOIN account_account a ON a.id = l.account_id
    WHERE l.posted AND a.code = 'OPENING' AND a.company_id = ${company}`;
  const clearingBalance = orm.toDecimal(clearing?.balance ?? '0');

  // Every open document is there.
  const documentMoves = [...new Set(data.items.map((i) => i.move))].filter(
    (m) => DOCUMENT_KINDS[data.moves.get(m)?.type ?? ''] !== undefined,
  );
  const missing: Check['differences'][number][] = [];
  for (const m of documentMoves)
    try {
      await env.refId('account.move' as never, `odoo.account_move_${m}`);
    } catch {
      missing.push({ what: data.moves.get(m)?.name ?? `#${m}`, odoo: 'open', kosh: 'missing' });
    }

  return [
    {
      name: 'trial balance',
      ok: accountDiffs.length === 0,
      summary: `${expected.size} accounts at ${cutoff}${accountDiffs.length === 0 ? ', every one equal' : `, ${accountDiffs.length} different`}`,
      differences: accountDiffs,
    },
    {
      name: 'receivables and payables',
      ok: partnerDiffs.length === 0,
      summary: `${expectedByPartner.size} partner balances${partnerDiffs.length === 0 ? ', every one equal' : `, ${partnerDiffs.length} different`}`,
      differences: partnerDiffs,
    },
    {
      name: 'opening balances account',
      ok: clearingBalance.isZero(),
      summary: clearingBalance.isZero() ? 'nets to zero' : `left with ${amount(clearingBalance)}`,
      differences: clearingBalance.isZero()
        ? []
        : [{ what: 'OPENING', odoo: '0.00', kosh: amount(clearingBalance) }],
    },
    {
      name: 'open documents',
      ok: missing.length === 0,
      summary: `${documentMoves.length} open invoices, credit notes and bills${missing.length === 0 ? ', all present' : `, ${missing.length} missing`}`,
      differences: missing,
    },
  ];
}
