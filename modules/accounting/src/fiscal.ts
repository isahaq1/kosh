/**
 * Fiscal positions and account determination (RFC 0029 §3.5).
 *
 * A fiscal position maps taxes (a tax to another, or to none: exports) and accounts (domestic sales to export
 * sales). A document's position is the one chosen on it, else its partner's, else the first automatic one whose
 * conditions the partner meets (countries, states, a tax number). Taxes are mapped when the document is posted;
 * accounts as its lines are posted.
 *
 * A product line's account is the line's own, else what an app proposes (`productLineAccounts`), else the product's
 * income or expense account, else its category's, else the journal's default. The counterpart is the partner's
 * receivable or payable account, else the company's. Every choice says where it came from, for the preview.
 */
import { HttpProblem } from '@kosh/server';
import { defineModel, type Env, extendModel, f } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

export const AccountFiscalPosition = defineModel('account.fiscal.position', {
  label: 'Fiscal position',
  archivable: true,
  companyScoped: { required: true },
  order: ['sequence asc', 'id asc'],
  access: { 'account.invoicing': ['read'], 'account.user': ['read'], 'account.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true, label: 'Fiscal position' }),
    sequence: f.integer({ default: 10 }),
    autoApply: f.boolean({
      default: false,
      label: 'Apply by itself',
      help: 'Chosen for partners who meet its conditions, unless a document or the partner names another.',
    }),
    countries: f.char({
      label: 'Countries',
      help: 'ISO codes separated by commas (BD, IN); empty: any country. "!BD" means any country but BD.',
    }),
    states: f.char({ label: 'States', help: 'ISO codes (IN-MH) separated by commas; empty: any.' }),
    vatRequired: f.selection(
      { any: 'With or without', with: 'With a tax number', without: 'Without a tax number' },
      {
        required: true,
        default: 'any',
        label: 'Tax number',
        help: 'Whether the partner must have a tax number (BIN, GSTIN, VAT) for it to apply.',
      },
    ),
    note: f.text({ translate: true, label: 'Note on documents' }),
    taxes: f.one2many('account.fiscal.position.tax', 'position', { label: 'Tax mapping' }),
    accounts: f.one2many('account.fiscal.position.account', 'position', {
      label: 'Account mapping',
    }),
  },
});

export const AccountFiscalPositionTax = defineModel('account.fiscal.position.tax', {
  label: 'Tax mapping',
  access: { 'account.invoicing': ['read'], 'account.user': ['read'], 'account.manager': ALL },
  fields: {
    position: f.many2one('account.fiscal.position', { required: true, ondelete: 'cascade' }),
    taxSrc: f.many2one('account.tax', { required: true, ondelete: 'cascade', label: 'Tax' }),
    taxDest: f.many2one('account.tax', {
      ondelete: 'restrict',
      label: 'Becomes',
      help: 'Empty: the tax is removed (an export, an exempt customer).',
    }),
  },
});

export const AccountFiscalPositionAccount = defineModel('account.fiscal.position.account', {
  label: 'Account mapping',
  access: { 'account.invoicing': ['read'], 'account.user': ['read'], 'account.manager': ALL },
  fields: {
    position: f.many2one('account.fiscal.position', { required: true, ondelete: 'cascade' }),
    accountSrc: f.many2one('account.account', {
      required: true,
      ondelete: 'cascade',
      label: 'Account',
    }),
    accountDest: f.many2one('account.account', {
      required: true,
      ondelete: 'restrict',
      label: 'Becomes',
    }),
  },
});

/** Income and expense accounts on products and their categories. */
export const ProductAccounts = extendModel('product.product', {
  fields: {
    incomeAccount: f.many2one('account.account', {
      ondelete: 'set null',
      label: 'Income account',
      help: 'Where its sales post; empty: its category’s, else the journal’s.',
    }),
    expenseAccount: f.many2one('account.account', {
      ondelete: 'set null',
      label: 'Expense account',
      help: 'Where its purchases post; empty: its category’s, else the journal’s.',
    }),
  },
});

export const CategoryAccounts = extendModel('product.category', {
  fields: {
    incomeAccount: f.many2one('account.account', {
      ondelete: 'set null',
      label: 'Income account',
      help: 'Where its products’ sales post when they name none.',
    }),
    expenseAccount: f.many2one('account.account', {
      ondelete: 'set null',
      label: 'Expense account',
      help: 'Where its products’ purchases post when they name none.',
    }),
  },
});

/** The partner's own receivable and payable accounts, and its fiscal position. */
export const PartnerAccounts = extendModel('res.partner', {
  fields: {
    receivableAccount: f.many2one('account.account', {
      ondelete: 'set null',
      label: 'Receivable account',
      help: 'What they owe us posts here; empty: the company’s.',
    }),
    payableAccount: f.many2one('account.account', {
      ondelete: 'set null',
      label: 'Payable account',
      help: 'What we owe them posts here; empty: the company’s.',
    }),
    fiscalPosition: f.many2one('account.fiscal.position', {
      ondelete: 'set null',
      label: 'Fiscal position',
      help: 'Always used for their documents; empty: chosen by the positions that apply by themselves.',
    }),
  },
});

type Row = Record<string, unknown>;
type Rows = {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec: unknown): Promise<Rows>;
  read(keys: readonly string[]): Row[];
  write(values: unknown): Promise<void>;
};
const ref = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    browse(ids: readonly number[]): Rows;
    search(q: unknown): Promise<Rows>;
  };
const idOf = (value: unknown): number | null =>
  typeof value === 'number' ? value : ((value as { id?: number } | null)?.id ?? null);
const codes = (value: unknown) =>
  String(value ?? '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c !== '');

/** A fiscal position with its mappings. */
export interface Position {
  readonly id: number;
  readonly name: string;
  readonly taxes: ReadonlyMap<number, number | null>;
  readonly accounts: ReadonlyMap<number, number>;
}

async function positionById(env: Env, id: number): Promise<Position | null> {
  const [p] = (await ref(env, 'account.fiscal.position').browse([id]).load(['name'])).read([
    'id',
    'name',
  ]);
  if (p === undefined) return null;
  const taxes = (
    await ref(env, 'account.fiscal.position.tax').search({ where: { position: id } })
  ).read(['taxSrc', 'taxDest']);
  const accounts = (
    await ref(env, 'account.fiscal.position.account').search({ where: { position: id } })
  ).read(['accountSrc', 'accountDest']);
  return {
    id,
    name: String(p['name']),
    taxes: new Map(taxes.map((t) => [idOf(t['taxSrc']) as number, idOf(t['taxDest'])])),
    accounts: new Map(
      accounts.map((a) => [idOf(a['accountSrc']) as number, idOf(a['accountDest']) as number]),
    ),
  };
}

/** Whether an automatic position's conditions hold for a partner. */
function meets(position: Row, partner: Row): boolean {
  const country = String(partner['country'] ?? '').toUpperCase();
  const wanted = codes(position['countries']);
  const excluded = wanted.filter((c) => c.startsWith('!')).map((c) => c.slice(1));
  const included = wanted.filter((c) => !c.startsWith('!'));
  if (included.length > 0 && !included.includes(country)) return false;
  if (excluded.includes(country)) return false;
  const states = codes(position['states']);
  if (states.length > 0 && !states.includes(String(partner['state'] ?? '').toUpperCase()))
    return false;
  const vat = String(partner['taxId'] ?? '').trim() !== '';
  if (position['vatRequired'] === 'with' && !vat) return false;
  if (position['vatRequired'] === 'without' && vat) return false;
  return true;
}

/** A document's fiscal position and why: chosen on it, the partner's, or automatic. */
export async function positionOf(
  env: Env,
  move: { fiscalPosition: number | null; partner: number | null },
): Promise<{ position: Position | null; why: string }> {
  if (move.fiscalPosition !== null)
    return {
      position: await positionById(env, move.fiscalPosition),
      why: 'chosen on the document',
    };
  if (move.partner === null) return { position: null, why: 'no partner' };
  const [partner] = (
    await ref(env, 'res.partner')
      .browse([move.partner])
      .load(['country', 'state', 'taxId', 'fiscalPosition'])
  ).read(['country', 'state', 'taxId', 'fiscalPosition']);
  if (partner === undefined) return { position: null, why: 'no partner' };
  const own = idOf(partner['fiscalPosition']);
  if (own !== null) return { position: await positionById(env, own), why: 'the partner’s' };
  const auto = (
    await ref(env, 'account.fiscal.position').search({
      where: { autoApply: true },
      order: ['sequence asc', 'id asc'],
    })
  ).read(['id', 'countries', 'states', 'vatRequired']);
  const found = auto.find((p) => meets(p, partner));
  if (found === undefined) return { position: null, why: 'none applies' };
  return {
    position: await positionById(env, found['id'] as number),
    why: 'applied by itself (the partner’s country, state or tax number)',
  };
}

/** Taxes after the position: each replaced or removed, in order, without duplicates. */
export function mapTaxes(position: Position | null, taxes: readonly number[]): number[] {
  if (position === null) return [...taxes];
  const out: number[] = [];
  for (const t of taxes) {
    const to = position.taxes.has(t) ? position.taxes.get(t) : t;
    if (to !== null && to !== undefined && !out.includes(to)) out.push(to);
  }
  return out;
}

/** An account after the position. */
export const mapAccount = (position: Position | null, account: number | null): number | null =>
  account === null ? null : (position?.accounts.get(account) ?? account);

/** Why a line's account is what it is. */
export type AccountSource = 'line' | 'app' | 'product' | 'category' | 'journal' | 'none';

/** Each product line's account and where it came from, and the counterpart's, after the position. */
export interface Determined {
  readonly position: Position | null;
  readonly why: string;
  readonly lines: ReadonlyMap<
    number,
    { account: number | null; source: AccountSource; mapped: boolean }
  >;
  readonly counterpart: {
    account: number | null;
    source: 'partner' | 'company' | 'none';
    mapped: boolean;
  };
}

/** Determines a document's accounts (`proposed`: what an app proposes per line, `productLineAccounts`). */
export async function determineAccounts(
  env: Env,
  moveId: number,
  proposed: ReadonlyMap<number, number> = new Map(),
): Promise<Determined> {
  const [move] = (
    await ref(env, 'account.move')
      .browse([moveId])
      .load(['kind', 'partner', 'fiscalPosition', 'journal', 'company'])
  ).read(['kind', 'partner', 'fiscalPosition', 'journal', 'company']);
  if (move === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such entry.');
  const customer = String(move['kind']).startsWith('out_');
  const partner = idOf(move['partner']);
  const { position, why } = await positionOf(env, {
    fiscalPosition: idOf(move['fiscalPosition']),
    partner,
  });
  const [journal] = (
    await ref(env, 'account.journal')
      .browse([idOf(move['journal']) as number])
      .load(['defaultAccount'])
  ).read(['defaultAccount']);
  const journalAccount = idOf(journal?.['defaultAccount']);
  const company = idOf(move['company']);
  // Accounts of another company (products and categories are shared) are not used.
  const ofCompany = async (ids: (number | null)[]) => {
    const wanted = ids.filter((i): i is number => i !== null);
    if (wanted.length === 0) return new Set<number>();
    const rows = (await ref(env, 'account.account').browse(wanted).load(['company'])).read([
      'id',
      'company',
    ]);
    return new Set(
      rows.filter((r) => idOf(r['company']) === company).map((r) => r['id'] as number),
    );
  };
  const key = customer ? 'incomeAccount' : 'expenseAccount';
  const lines = (
    await ref(env, 'account.move.line').search({
      where: { move: moveId, lineKind: 'product' },
    })
  ).read(['id', 'account', 'product']);
  const productIds = [...new Set(lines.map((l) => idOf(l['product'])).filter((p) => p !== null))];
  const products = new Map(
    productIds.length === 0
      ? []
      : (
          await ref(env, 'product.product')
            .browse(productIds as number[])
            .load([key, 'category'])
        )
          .read(['id', key, 'category'])
          .map((p) => [p['id'] as number, p]),
  );
  const categoryIds = [
    ...new Set([...products.values()].map((p) => idOf(p['category'])).filter((c) => c !== null)),
  ];
  const categories = new Map(
    categoryIds.length === 0
      ? []
      : (
          await ref(env, 'product.category')
            .browse(categoryIds as number[])
            .load([key])
        )
          .read(['id', key])
          .map((c) => [c['id'] as number, idOf(c[key])]),
  );
  const valid = await ofCompany([
    ...[...products.values()].map((p) => idOf(p[key])),
    ...[...categories.values()],
  ]);
  const out = new Map<number, { account: number | null; source: AccountSource; mapped: boolean }>();
  for (const l of lines) {
    const id = l['id'] as number;
    const product = products.get(idOf(l['product']) ?? -1);
    const own = idOf(product?.[key]);
    const category = categories.get(idOf(product?.['category']) ?? -1) ?? null;
    const [account, source]: [number | null, AccountSource] =
      idOf(l['account']) !== null
        ? [idOf(l['account']), 'line']
        : proposed.has(id)
          ? [proposed.get(id) as number, 'app']
          : own !== null && valid.has(own)
            ? [own, 'product']
            : category !== null && valid.has(category)
              ? [category, 'category']
              : journalAccount !== null
                ? [journalAccount, 'journal']
                : [null, 'none'];
    // The line's own account is kept as typed; the others go through the position.
    const final = source === 'line' ? account : mapAccount(position, account);
    out.set(id, { account: final, source, mapped: final !== account });
  }
  // The counterpart: the partner's account, else the company's.
  let counterpart: Determined['counterpart'] = { account: null, source: 'none', mapped: false };
  if (partner !== null) {
    const pKey = customer ? 'receivableAccount' : 'payableAccount';
    const [p] = (await ref(env, 'res.partner').browse([partner]).load([pKey])).read([pKey]);
    const own = idOf(p?.[pKey]);
    const [c] = (
      await ref(env, 'res.company')
        .browse([company as number])
        .load(['accountReceivable', 'accountPayable'])
    ).read(['accountReceivable', 'accountPayable']);
    const fallback = idOf(c?.[customer ? 'accountReceivable' : 'accountPayable']);
    const valid2 = await ofCompany([own]);
    const [account, source]: [number | null, 'partner' | 'company' | 'none'] =
      own !== null && valid2.has(own)
        ? [own, 'partner']
        : fallback !== null
          ? [fallback, 'company']
          : [null, 'none'];
    const final = mapAccount(position, account);
    counterpart = { account: final, source, mapped: final !== account };
  }
  return { position, why, lines: out, counterpart };
}

/**
 * Before posting: each document's fiscal position written on it, and its product lines' taxes mapped (a tax
 * replaced or removed). Entries without a partner are left alone.
 */
export async function applyFiscalPositions(env: Env, moveIds: readonly number[]): Promise<void> {
  for (const moveId of moveIds) {
    const [move] = (
      await ref(env, 'account.move').browse([moveId]).load(['kind', 'partner', 'fiscalPosition'])
    ).read(['kind', 'partner', 'fiscalPosition']);
    if (move === undefined || move['kind'] === 'entry') continue;
    const { position } = await positionOf(env, {
      fiscalPosition: idOf(move['fiscalPosition']),
      partner: idOf(move['partner']),
    });
    if (position === null) continue;
    if (idOf(move['fiscalPosition']) !== position.id)
      await ref(env, 'account.move').browse([moveId]).write({ fiscalPosition: position.id });
    if (position.taxes.size === 0) continue;
    const lines = await (
      await ref(env, 'account.move.line').search({ where: { move: moveId, lineKind: 'product' } })
    ).load({ taxes: true });
    for (const l of lines.read(['id', 'taxes'])) {
      const before = [...((l['taxes'] ?? []) as Iterable<unknown>)].map((t) => idOf(t) as number);
      const after = mapTaxes(position, before);
      if (after.join(',') !== before.join(','))
        await ref(env, 'account.move.line')
          .browse([l['id'] as number])
          .write({ taxes: { set: after } });
    }
  }
}

/** What posting would do to a draft document's lines: taxes and accounts after the position, and why. */
export async function previewMove(env: Env, moveId: number) {
  const [move] = (
    await ref(env, 'account.move').browse([moveId]).load(['kind', 'partner', 'fiscalPosition'])
  ).read(['kind', 'partner', 'fiscalPosition']);
  if (move === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such entry.');
  const proposed = await (
    env.model('account.move').browse([moveId as never]) as unknown as {
      productLineAccounts(): Promise<Map<number, number>>;
    }
  ).productLineAccounts();
  const determined = await determineAccounts(env, moveId, proposed);
  const lines = await (
    await ref(env, 'account.move.line').search({
      where: { move: moveId, lineKind: 'product' },
      order: ['id asc'],
    })
  ).load({ taxes: true });
  const accountIds = new Set<number>();
  const taxIds = new Set<number>();
  const rows = lines.read(['id', 'name', 'taxes']).map((l) => {
    const before = [...((l['taxes'] ?? []) as Iterable<unknown>)].map((t) => idOf(t) as number);
    const after = mapTaxes(determined.position, before);
    for (const t of [...before, ...after]) taxIds.add(t);
    const d = determined.lines.get(l['id'] as number);
    if (d?.account != null) accountIds.add(d.account);
    return { id: l['id'] as number, name: String(l['name'] ?? ''), before, after, ...d };
  });
  if (determined.counterpart.account !== null) accountIds.add(determined.counterpart.account);
  const names = async (model: string, ids: Set<number>, keys: string[]) =>
    new Map(
      ids.size === 0
        ? []
        : (
            await ref(env, model)
              .browse([...ids])
              .load(keys)
          )
            .read(['id', ...keys])
            .map((r) => [
              r['id'] as number,
              keys
                .map((k) => String(r[k] ?? ''))
                .join(' ')
                .trim(),
            ]),
    );
  const accounts = await names('account.account', accountIds, ['code', 'name']);
  const taxes = await names('account.tax', taxIds, ['name']);
  return {
    position:
      determined.position === null
        ? null
        : { id: determined.position.id, name: determined.position.name },
    why: determined.why,
    lines: rows.map((r) => ({
      id: r.id,
      name: r.name,
      taxesBefore: r.before.map((t) => taxes.get(t) ?? String(t)),
      taxesAfter: r.after.map((t) => taxes.get(t) ?? String(t)),
      account: r.account == null ? null : (accounts.get(r.account) ?? String(r.account)),
      source: r.source ?? 'none',
      mapped: r.mapped === true,
    })),
    counterpart: {
      account:
        determined.counterpart.account === null
          ? null
          : (accounts.get(determined.counterpart.account) ?? null),
      source: determined.counterpart.source,
      mapped: determined.counterpart.mapped,
    },
  };
}
