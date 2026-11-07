/**
 * Bank statements (RFC 0029 §3.1): a statement of a bank or cash journal holds lines — date, label, reference,
 * amount — imported from CSV (a column mapping), OFX or CAMT.053, or pulled from a bank feed (an adapter, like the
 * payment providers). Each line is matched from the reconciliation workspace: the server proposes the open invoices,
 * bills and credit notes it may pay, each with why (the amount, the document's number in the label, the partner);
 * matching registers the payment from the statement's journal, which posts and reconciles it. A line that pays no
 * document is written off to a counterpart account (bank fees, interest). A line not matched yet stays open.
 */
import { emitting, HttpProblem } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { defineModel, type Env, f, records } from './.kosh/bindings.js';
import { registerPayment } from './payments.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const zero = orm.toDecimal('0');

export const AccountBankStatement = defineModel('account.bank.statement', {
  label: 'Bank statement',
  companyScoped: { required: true },
  order: ['date desc', 'id desc'],
  tracking: ['state', 'balanceEnd'],
  access: { 'account.user': ALL, 'account.manager': ALL },
  fields: {
    name: f.char({ required: true, label: 'Statement' }),
    journal: f.many2one('account.journal', {
      required: true,
      checkCompany: true,
      ondelete: 'restrict',
      label: 'Journal',
    }),
    date: f.date({ required: true, label: 'Date' }),
    balanceStart: f.decimal({ scale: 2, default: '0', label: 'Opening balance' }),
    balanceEnd: f.decimal({ scale: 2, default: '0', label: 'Closing balance' }),
    lines: f.one2many('account.bank.statement.line', 'statement', { label: 'Lines' }),
    state: f.state({
      help: 'Open while lines wait to be matched; done once every line is matched and the closing balance agrees.',
      states: { open: 'Open', done: 'Done' },
      initial: 'open',
      transitions: {
        close: emitting('account.bank.statement.closed', {
          from: ['open'],
          to: 'done',
          guard: records('account.bank.statement', async (statements) => {
            const failing: number[] = [];
            for (const s of await statements.load({ lines: true })) {
              const lines = [...s.lines];
              const total = lines.reduce((sum, l) => sum.plus(l.amount ?? zero), zero);
              const agrees = (s.balanceStart ?? zero).plus(total).eq(s.balanceEnd ?? zero);
              if (!agrees || lines.some((l) => l.state !== 'matched')) failing.push(s.id as number);
            }
            return failing as never;
          }),
          message:
            'A statement is done when every line is matched and the opening balance plus its lines is the closing balance.',
        }),
        reopen: { from: ['done'], to: 'open' },
      },
    }),
  },
});

export const AccountBankStatementLine = defineModel('account.bank.statement.line', {
  label: 'Statement line',
  order: ['date asc', 'id asc'],
  access: { 'account.user': ALL, 'account.manager': ALL },
  fields: {
    statement: f.many2one('account.bank.statement', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true, label: 'Date' }),
    label: f.char({ required: true, label: 'Label' }),
    reference: f.char({ label: 'Reference' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Partner' }),
    /** Money in is positive, money out negative. */
    amount: f.decimal({ scale: 2, required: true, label: 'Amount' }),
    /** The journal, date, amount and reference: a line imported twice is refused. */
    uniqueKey: f.char({ index: 'unique', label: 'Import key' }),
    payment: f.many2one('account.payment', { ondelete: 'set null', label: 'Payment' }),
    move: f.many2one('account.move', { ondelete: 'set null', label: 'Entry' }),
    state: f.selection(
      { open: 'Open', matched: 'Matched' },
      {
        required: true,
        default: 'open',
        label: 'Status',
        help: 'Open until matched to documents (a payment) or written off to an account.',
      },
    ),
  },
});

/** A statement line as imported. */
export interface StatementRow {
  readonly date: string;
  readonly label: string;
  readonly amount: string;
  readonly reference?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const bad = (problem: string, hint: string) =>
  new HttpProblem(422, 'invalid-statement', 'Invalid statement', problem, hint);

/** A date in ISO, from `YYYY-MM-DD`, `DD/MM/YYYY` or `YYYYMMDD…` (OFX). */
function isoDate(text: string): string {
  const t = text.trim();
  if (ISO.test(t)) return t;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (dmy !== null)
    return `${dmy[3]}-${(dmy[2] as string).padStart(2, '0')}-${(dmy[1] as string).padStart(2, '0')}`;
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(t);
  if (compact !== null) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  throw bad(`“${t}” is not a date.`, 'Dates are YYYY-MM-DD or DD/MM/YYYY.');
}

/** An amount as a decimal string: thousands separators dropped, `(12.50)` and `12.50-` negative. */
function amountOf(text: string): string {
  let t = text.trim().replace(/[\s,]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith('-')) {
    negative = true;
    t = t.slice(0, -1);
  }
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw bad(`“${text}” is not an amount.`, 'Amounts are numbers.');
  return negative ? `-${t.replace(/^-/, '')}` : t;
}

/** Splits one CSV line (quotes and doubled quotes understood). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] as string;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') {
      out.push(cell);
      cell = '';
    } else cell += c;
  }
  out.push(cell);
  return out.map((v) => v.trim());
}

/** How a CSV's columns map to a line: headers by name; `debit` / `credit` columns instead of `amount`. */
export interface CsvMapping {
  readonly date: string;
  readonly label: string;
  readonly amount?: string;
  readonly debit?: string;
  readonly credit?: string;
  readonly reference?: string;
}

/** Lines of a CSV statement with a header row. */
export function parseCsv(text: string, mapping: CsvMapping): StatementRow[] {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = csvCells(rows[0] ?? '');
  const at = (name: string | undefined) => (name === undefined ? -1 : header.indexOf(name));
  const [iDate, iLabel, iAmount, iDebit, iCredit, iRef] = [
    at(mapping.date),
    at(mapping.label),
    at(mapping.amount),
    at(mapping.debit),
    at(mapping.credit),
    at(mapping.reference),
  ];
  if (iDate < 0 || iLabel < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0))
    throw bad(
      'The mapping names columns the file does not have.',
      `Columns: ${header.join(', ')}.`,
    );
  return rows.slice(1).map((line) => {
    const cells = csvCells(line);
    const money =
      iAmount >= 0
        ? amountOf(cells[iAmount] ?? '0')
        : orm
            .toDecimal(amountOf(cells[iCredit] || '0'))
            .minus(orm.toDecimal(amountOf(cells[iDebit] || '0')))
            .toString();
    return {
      date: isoDate(cells[iDate] ?? ''),
      label: cells[iLabel] ?? '',
      amount: money,
      ...(iRef >= 0 && (cells[iRef] ?? '') !== '' ? { reference: cells[iRef] as string } : {}),
    };
  });
}

/** Lines of an OFX statement (`<STMTTRN>` blocks, SGML or XML). */
export function parseOfx(text: string): StatementRow[] {
  const tag = (block: string, name: string) =>
    new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block)?.[1]?.trim() ?? '';
  return [
    ...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>)/gi),
  ].map((m) => {
    const block = m[1] as string;
    const fitid = tag(block, 'FITID');
    return {
      date: isoDate(tag(block, 'DTPOSTED')),
      label: tag(block, 'NAME') || tag(block, 'MEMO') || fitid,
      amount: amountOf(tag(block, 'TRNAMT')),
      ...(fitid === '' ? {} : { reference: fitid }),
    };
  });
}

/** Lines of a CAMT.053 statement (`<Ntry>` entries). */
export function parseCamt(xml: string): StatementRow[] {
  const inner = (block: string, name: string) =>
    new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block)?.[1]?.trim() ?? '';
  return [...xml.matchAll(/<Ntry>([\s\S]*?)<\/Ntry>/g)].map((m) => {
    const block = m[1] as string;
    const amount = amountOf(inner(block, 'Amt'));
    const out = inner(block, 'CdtDbtInd') === 'DBIT';
    const date = inner(inner(block, 'BookgDt'), 'Dt') || inner(inner(block, 'ValDt'), 'Dt');
    const reference = inner(block, 'AcctSvcrRef') || inner(block, 'EndToEndId');
    return {
      date: isoDate(date),
      label: inner(block, 'Ustrd') || inner(block, 'AddtlNtryInf') || reference,
      amount: out ? `-${amount.replace(/^-/, '')}` : amount,
      ...(reference === '' ? {} : { reference }),
    };
  });
}

/**
 * A new statement of `journal` from `rows`; lines already imported (the same journal, date, amount and reference
 * or label) are skipped. Returns the statement and how many lines were made and skipped.
 */
export async function importStatement(
  env: Env,
  input: {
    readonly journal: number;
    readonly rows: readonly StatementRow[];
    readonly name?: string;
    readonly balanceStart?: string;
    readonly balanceEnd?: string;
  },
): Promise<{ statement: number | null; created: number; skipped: number }> {
  const [journal] = await env
    .model('account.journal')
    .browse([input.journal as never])
    .load(['type', 'code']);
  if (journal === undefined || (journal.type !== 'bank' && journal.type !== 'cash'))
    throw bad('Statements are for bank and cash journals.', 'Choose a bank or cash journal.');
  const keyOf = (r: StatementRow) =>
    `${input.journal}|${r.date}|${orm.toDecimal(r.amount).toFixed(2)}|${(r.reference ?? r.label).trim()}`;
  const keys = input.rows.map(keyOf);
  const existing = new Set(
    (
      await (
        await env.model('account.bank.statement.line').search({
          where: { uniqueKey: { in: keys } } as never,
        })
      ).load(['uniqueKey'])
    ).map((l) => String(l.uniqueKey)),
  );
  const fresh = input.rows.filter((_r, i) => !existing.has(keys[i] as string));
  const unique = new Map(fresh.map((r) => [keyOf(r), r]));
  if (unique.size === 0) return { statement: null, created: 0, skipped: input.rows.length };
  const dates = [...unique.values()].map((r) => r.date).sort();
  const total = [...unique.values()].reduce((s, r) => s.plus(orm.toDecimal(r.amount)), zero);
  const start = orm.toDecimal(input.balanceStart ?? '0');
  const made = await env.model('account.bank.statement').create([
    {
      name: input.name ?? `${String(journal.code)} ${dates.at(-1)}`,
      journal: input.journal,
      date: dates.at(-1),
      balanceStart: start.toString(),
      balanceEnd: (input.balanceEnd === undefined
        ? start.plus(total)
        : orm.toDecimal(input.balanceEnd)
      ).toString(),
      lines: {
        create: [...unique.entries()].map(([key, r]) => ({
          date: r.date,
          label: r.label,
          reference: r.reference ?? null,
          amount: r.amount,
          uniqueKey: key,
        })),
      },
    } as never,
  ]);
  return {
    statement: made.ids[0] as number,
    created: unique.size,
    skipped: input.rows.length - unique.size,
  };
}

/** A document a statement line may pay, and why it is proposed. */
export interface Proposal {
  readonly move: number;
  readonly name: string;
  readonly partner: string | null;
  readonly residual: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

/**
 * The open documents a line may pay (RFC 0029 §3.1), best first, each with why: money in pays customer invoices
 * (and vendor credit notes), money out vendor bills (and customer credit notes); the exact amount, the document's
 * number or reference in the label, the line's partner.
 */
export async function proposalsFor(env: Env, lineId: number, limit = 5): Promise<Proposal[]> {
  const [line] = await env
    .model('account.bank.statement.line')
    .browse([lineId as never])
    .load({ statement: { journal: true }, partner: true });
  if (line === undefined) throw new HttpProblem(404, 'not-found', 'Not found', 'No such line.');
  const amount = (line.amount ?? zero).abs();
  const incoming = (line.amount ?? zero).gt(0);
  const kinds = incoming
    ? ['out_invoice', 'out_debit', 'in_refund']
    : ['in_invoice', 'in_debit', 'out_refund'];
  const docs = await (
    await env.model('account.move').search({
      where: {
        state: 'posted',
        kind: { in: kinds },
        company: line.statement.company.id,
      } as never,
      limit: 500,
    })
  ).load({ partner: true });
  const label = `${line.label ?? ''} ${line.reference ?? ''}`.toLowerCase();
  const out: Proposal[] = [];
  for (const d of docs) {
    const residual = orm.toDecimal(String(d.amountResidual?.amount ?? '0'));
    if (residual.lte(0)) continue;
    const reasons: string[] = [];
    let score = 0;
    if (residual.eq(amount)) {
      score += 50;
      reasons.push('the same amount');
    }
    const name = String(d.name ?? '');
    const ref = String(d.ref ?? '');
    if (name !== '' && name !== '/' && label.includes(name.toLowerCase())) {
      score += 40;
      reasons.push(`${name} in the label`);
    } else if (ref !== '' && label.includes(ref.toLowerCase())) {
      score += 30;
      reasons.push(`its reference ${ref} in the label`);
    }
    if (line.partner !== null && d.partner?.id === line.partner.id) {
      score += 20;
      reasons.push('the same partner');
    } else if (
      d.partner !== null &&
      d.partner !== undefined &&
      label.includes(String(d.partner.name).toLowerCase())
    ) {
      score += 15;
      reasons.push(`${String(d.partner.name)} in the label`);
    }
    if (score === 0) continue;
    out.push({
      move: d.id as number,
      name,
      partner: d.partner === null || d.partner === undefined ? null : String(d.partner.name),
      residual: residual.toFixed(2),
      score,
      reasons,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.move - b.move).slice(0, limit);
}

/** Opens a line to be matched, or refuses: it must be open and the caller may reconcile. */
async function openLine(env: Env, lineId: number) {
  if (!env.su && !env.access.has('account.reconcile'))
    throw new HttpProblem(
      403,
      'access',
      'Reconciliation',
      'Matching needs the reconcile permission.',
    );
  const [line] = await env
    .model('account.bank.statement.line')
    .browse([lineId as never])
    .load({ statement: { journal: true } });
  if (line === undefined) throw new HttpProblem(404, 'not-found', 'Not found', 'No such line.');
  if (line.state !== 'open')
    throw new HttpProblem(409, 'matched', 'Matched already', 'This line is matched already.');
  return line;
}

/** Matches a line with the documents it pays: the payment from the statement's journal, posted and reconciled. */
export async function matchLine(
  env: Env,
  lineId: number,
  moves: readonly number[],
): Promise<{ payment: number }> {
  const line = await openLine(env, lineId);
  const amount = (line.amount ?? zero).abs();
  const paid = await registerPayment(env, {
    moves,
    journal: line.statement.journal.id as number,
    date: String(line.date).slice(0, 10),
    amount: amount.toFixed(2),
    memo: String(line.label ?? ''),
  });
  const [payment] = await env
    .model('account.payment')
    .browse([paid.id as never])
    .load({ partner: true });
  await env
    .model('account.bank.statement.line')
    .browse([lineId as never])
    .write({
      state: 'matched',
      payment: paid.id as never,
      ...(payment?.partner ? { partner: payment.partner.id } : {}),
    });
  return { payment: paid.id };
}

/** Writes a line off to a counterpart account (fees, interest): an entry in the statement's journal, posted. */
export async function writeOffLine(
  env: Env,
  lineId: number,
  input: { readonly account: number; readonly label?: string },
): Promise<{ move: number }> {
  const line = await openLine(env, lineId);
  const journal = line.statement.journal;
  if (journal.defaultAccount === null)
    throw new HttpProblem(
      409,
      'no-account',
      'No bank account',
      `${String(journal.name)} has no default account.`,
      'Set the journal’s account first.',
    );
  const amount = line.amount ?? zero;
  const money = amount.abs().toFixed(2);
  const name = input.label ?? String(line.label ?? '');
  const [company] = await env
    .model('res.company')
    .browse([line.statement.company.id])
    .load({ currency: true });
  const made = await env.model('account.move').create([
    {
      kind: 'entry',
      journal: journal.id,
      currency: company?.currency.id,
      date: String(line.date).slice(0, 10),
      ref: name,
      company: line.statement.company.id,
      lines: {
        create: [
          {
            account: journal.defaultAccount.id,
            name,
            debit: amount.gt(0) ? money : '0',
            credit: amount.gt(0) ? '0' : money,
          },
          {
            account: input.account,
            name,
            debit: amount.gt(0) ? '0' : money,
            credit: amount.gt(0) ? money : '0',
          },
        ],
      },
    } as never,
  ]);
  await env.model('account.move').browse(made.ids).post();
  await env
    .model('account.bank.statement.line')
    .browse([lineId as never])
    .write({ state: 'matched', move: made.ids[0] as never });
  return { move: made.ids[0] as number };
}

/** A bank feed (RFC 0029 §3.1): the lines since a cursor, and the new cursor. Real banks are adapters like this. */
export interface BankFeed {
  readonly name: string;
  fetch(journal: number, cursor: string | null): Promise<{ rows: StatementRow[]; cursor: string }>;
}

const feeds = new Map<string, BankFeed>();
/** Makes a feed available to journals that name it (`account.journal.bankFeed`). */
export function registerBankFeed(feed: BankFeed): void {
  feeds.set(feed.name, feed);
}
/** The feed of a name, or undefined. */
export function bankFeed(name: string): BankFeed | undefined {
  return feeds.get(name);
}

/** A feed for tests and demos: the rows it is given, once each. */
export function testBankFeed(rows: readonly StatementRow[]): BankFeed {
  return {
    name: 'test',
    fetch: async (_journal, cursor) => {
      const from = cursor === null ? 0 : Number(cursor);
      return { rows: rows.slice(from), cursor: String(rows.length) };
    },
  };
}

/** Pulls a journal's feed into a new statement; its cursor moves on. */
export async function pullFeed(
  env: Env,
  journalId: number,
): Promise<{ statement: number | null; created: number; skipped: number }> {
  const [journal] = await env
    .model('account.journal')
    .browse([journalId as never])
    .load(['bankFeed', 'bankFeedCursor']);
  const name = journal?.bankFeed ?? null;
  const feed = name === null ? undefined : feeds.get(String(name));
  if (feed === undefined)
    throw new HttpProblem(409, 'no-feed', 'No bank feed', 'This journal has no bank feed.');
  const { rows, cursor } = await feed.fetch(journalId, journal?.bankFeedCursor ?? null);
  const result = await importStatement(env, { journal: journalId, rows });
  // The cursor is the journal's: kept as the system (accountants do not edit journals).
  await env.asSuperuser({ reason: 'bank feed cursor' }, (su) =>
    su
      .model('account.journal')
      .browse([journalId as never])
      .write({ bankFeedCursor: cursor }),
  );
  return result;
}
