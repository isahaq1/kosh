/**
 * Fleet in the books (RFC 0038 step 2, `fleet_account`): a fill, a service and a paper are **booked** on the
 * vehicle's **cost centre** — made with its plate the first time —, each to its expense account:
 *
 * - paid from a cash or bank journal (*Paid from*): one posted entry, the expense against the journal's account,
 *   on the day of the log;
 * - otherwise on account with the station, the workshop or the issuer: a line on that vendor's **draft bill** of
 *   fleet costs — one bill collects a vendor's logs until an accountant posts it.
 *
 * A booked log no longer changes. *Take out of the books* reverses the entry, or takes the line off the draft
 * bill; a posted bill is credited in Accounting first. Accounts are found by their codes and made when the chart
 * lacks them.
 */
import { accountingShutro, reverseMove } from '@kosh/accounting';
import { fleetShutro } from '@kosh/fleet';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { check, defineModule, type Env, extendModel, f, records } from './.kosh/bindings.js';

const ZERO: Decimal = orm.toDecimal(0);
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;
/** What marks a vendor's draft bill as the one that collects fleet costs. */
export const FLEET_ORIGIN = 'Fleet';

/** The accounts Fleet books to, by code, made when missing. */
export const FLEET_ACCOUNTS = {
  fuel: { code: '6410', name: 'Vehicle fuel', type: 'expense' },
  service: { code: '6420', name: 'Vehicle maintenance', type: 'expense' },
  papers: { code: '6430', name: 'Vehicle licences and insurance', type: 'expense' },
} as const;

type Accounts = Record<keyof typeof FLEET_ACCOUNTS, Id<'account.account'>>;
type Logs = 'fleet.fuel' | 'fleet.service' | 'fleet.document';

/** The log models, each with its expense account and the line field that points back at it. */
const KINDS = {
  'fleet.fuel': { account: 'fuel', link: 'fleetFuel' },
  'fleet.service': { account: 'service', link: 'fleetService' },
  'fleet.document': { account: 'papers', link: 'fleetDocument' },
} as const;

const iso = (v: unknown): string => {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};

/** The company's Fleet expense accounts; `null` without a chart. */
export async function fleetAccountsOf(
  env: Env,
  company: Id<'res.company'>,
): Promise<Accounts | null> {
  const chart = await env.model('account.account').search({ where: { company }, limit: 1 });
  if (chart.length === 0) return null;
  const out: Partial<Accounts> = {};
  for (const [key, spec] of Object.entries(FLEET_ACCOUNTS)) {
    const found = (
      await env.model('account.account').search({ where: { company, code: spec.code }, limit: 1 })
    ).ids[0];
    out[key as keyof typeof FLEET_ACCOUNTS] =
      found ??
      ((await env.model('account.account').create([{ ...spec, company } as never]))
        .ids[0] as Id<'account.account'>);
  }
  return out as Accounts;
}

/** The vehicle's cost centre: the one chosen, the one coded like its plate, or a new one. */
export async function costCentreOf(
  env: Env,
  vehicle: Id<'fleet.vehicle'>,
): Promise<Id<'account.analytic'>> {
  const [v] = await env.model('fleet.vehicle').browse([vehicle]).load({ company: true });
  if (v === undefined) throw new Error(`no vehicle ${vehicle}`);
  if (v.analytic !== null) return v.analytic.id;
  const code = v.plate.slice(0, 32);
  const analytic =
    (
      await env
        .model('account.analytic')
        .search({ where: { company: v.company.id, code }, limit: 1 })
    ).ids[0] ??
    ((await env.model('account.analytic').create([{ code, name: v.name, company: v.company.id }]))
      .ids[0] as Id<'account.analytic'>);
  await env.model('fleet.vehicle').browse([vehicle]).write({ analytic });
  return analytic;
}

/** What is booked of a log, whichever model it is. */
interface Cost {
  readonly id: number;
  readonly company: Id<'res.company'>;
  readonly vehicle: Id<'fleet.vehicle'>;
  readonly vendor: Id<'res.partner'> | null;
  readonly amount: Decimal;
  readonly date: string;
  readonly journal: Id<'account.journal'> | null;
  readonly entry: Id<'account.move'> | null;
  readonly text: string;
}

async function costsOf(env: Env, model: Logs, ids: readonly number[]): Promise<Cost[]> {
  const out: Cost[] = [];
  if (model === 'fleet.fuel')
    for (const l of await env
      .model('fleet.fuel')
      .browse(ids as never)
      .load({ vehicle: true, company: true }))
      out.push({
        id: l.id,
        company: l.company.id,
        vehicle: l.vehicle.id,
        vendor: l.station?.id ?? null,
        amount: l.amount,
        date: iso(l.date),
        journal: l.paymentJournal?.id ?? null,
        entry: l.entry?.id ?? null,
        text: `${l.vehicle.name}: fuel, ${l.litres.toString()} l on ${iso(l.date)}`,
      });
  else if (model === 'fleet.service')
    for (const l of await env
      .model('fleet.service')
      .browse(ids as never)
      .load({ vehicle: true, company: true }))
      out.push({
        id: l.id,
        company: l.company.id,
        vehicle: l.vehicle.id,
        vendor: l.vendor?.id ?? null,
        amount: l.amount,
        date: iso(l.date),
        journal: l.paymentJournal?.id ?? null,
        entry: l.entry?.id ?? null,
        text: `${l.vehicle.name}: ${l.description} on ${iso(l.date)}`,
      });
  else
    for (const l of await env
      .model('fleet.document')
      .browse(ids as never)
      .load({ vehicle: true, company: true }))
      out.push({
        id: l.id,
        company: l.company.id,
        vehicle: l.vehicle.id,
        vendor: l.issuer?.id ?? null,
        amount: l.cost ?? ZERO,
        date: iso(l.issuedOn ?? env.today()),
        journal: l.paymentJournal?.id ?? null,
        entry: l.entry?.id ?? null,
        text: `${l.vehicle.name}: ${l.kind.replace('_', ' ')} ${l.name}`,
      });
  return out;
}

const refused = (model: Logs, fields: string[], message: string, hint: string) =>
  new orm.ValidationError(model, fields, message, hint);

/** The cash or bank journal's account. @throws {ValidationError} when it is neither */
async function moneyAccount(
  env: Env,
  model: Logs,
  journal: Id<'account.journal'>,
): Promise<Id<'account.account'>> {
  const [j] = await env.model('account.journal').browse([journal]).load({});
  const account = j?.defaultAccount?.id;
  if (j === undefined || account === undefined || (j.type !== 'cash' && j.type !== 'bank'))
    throw refused(
      model,
      ['paymentJournal'],
      'Pay from a cash or bank journal with its account.',
      'Choose a cash or bank journal (Accounting › Configuration › Journals), or leave “Paid from” empty to have the vendor bill it.',
    );
  return account;
}

/** Books the logs: an entry for what was paid, a line on the vendor's draft bill for the rest. */
async function book(env: Env, model: Logs, ids: readonly number[]): Promise<void> {
  const kind = KINDS[model];
  for (const c of await costsOf(env, model, ids)) {
    const accounts = await fleetAccountsOf(env, c.company);
    if (accounts === null)
      throw refused(
        model,
        ['booking'],
        'The company has no chart of accounts yet.',
        'Install a chart in Accounting first.',
      );
    const analytic = await costCentreOf(env, c.vehicle);
    const account = accounts[kind.account];
    const [company] = await env.model('res.company').browse([c.company]).load({});
    const amount = c.amount.toDecimalPlaces(2).toString();
    let entry: Id<'account.move'>;
    if (c.journal !== null) {
      const money = await moneyAccount(env, model, c.journal);
      const made = await env.model('account.move').create([
        {
          kind: 'entry',
          journal: c.journal,
          company: c.company,
          currency: company?.currency.id,
          date: c.date,
          ref: c.text,
          lines: {
            create: [
              { account, analytic, name: c.text, debit: amount, credit: '0', [kind.link]: c.id },
              { account: money, name: c.text, debit: '0', credit: amount },
            ],
          },
        } as never,
      ]);
      await env.withGrants({ grants: ['account.post'], reason: `Fleet ${c.text}` }, (e) =>
        e.model('account.move').browse(made.ids).post(),
      );
      entry = made.ids[0] as Id<'account.move'>;
    } else {
      if (c.vendor === null) throw new Error('guarded: a log on account names its vendor');
      const line = {
        lineKind: 'product',
        account,
        analytic,
        name: c.text,
        quantity: '1',
        priceUnit: amount,
        debit: '0',
        credit: '0',
        [kind.link]: c.id,
      };
      const open = (
        await env.model('account.move').search({
          where: {
            company: c.company,
            kind: 'in_invoice',
            state: 'draft',
            partner: c.vendor,
            invoiceOrigin: FLEET_ORIGIN,
          },
          order: ['id asc'],
          limit: 1,
        })
      ).ids[0];
      if (open !== undefined) {
        await env
          .model('account.move')
          .browse([open])
          .write({ lines: { create: [line] } } as never);
        entry = open;
      } else {
        const journal = (
          await env
            .model('account.journal')
            .search({ where: { company: c.company, type: 'purchase' }, limit: 1 })
        ).ids[0];
        if (journal === undefined)
          throw refused(
            model,
            ['booking'],
            'The company has no purchases journal.',
            'Install a chart of accounts (Accounting › Configuration).',
          );
        entry = (
          await env.model('account.move').create([
            {
              kind: 'in_invoice',
              journal,
              partner: c.vendor,
              company: c.company,
              currency: company?.currency.id,
              date: env.today(),
              invoiceOrigin: FLEET_ORIGIN,
              lines: { create: [line] },
            } as never,
          ])
        ).ids[0] as Id<'account.move'>;
      }
    }
    await env
      .model(model)
      .browse([c.id] as never)
      .write({ entry } as never);
  }
  await env.flush();
}

/** Takes the logs out of the books: the entry reversed, or the line off the vendor's draft bill. */
async function unbook(env: Env, model: Logs, ids: readonly number[]): Promise<void> {
  const kind = KINDS[model];
  for (const c of await costsOf(env, model, ids)) {
    if (c.entry !== null) {
      const [move] = await env.model('account.move').browse([c.entry]).load({});
      if (move !== undefined && move.kind === 'entry') {
        if (move.state === 'posted' && move.reversedBy === null)
          await env.withGrants({ grants: ['account.post'], reason: `Fleet ${c.text}` }, (e) =>
            reverseMove(e as never, c.entry as number, { date: iso(env.today()), post: true }),
          );
      } else if (move !== undefined && move.state === 'draft') {
        const lines = await env
          .model('account.move.line')
          .search({ where: { move: c.entry, [kind.link]: c.id } as never });
        await lines.unlink();
        await env.flush();
        const left = await env
          .model('account.move.line')
          .search({ where: { move: c.entry, lineKind: 'product' }, limit: 1 });
        if (left.length === 0) await env.model('account.move').browse([c.entry]).cancel();
      } else if (move !== undefined && move.state !== 'cancel' && move.reversedBy === null)
        throw refused(
          model,
          ['booking'],
          `Its vendor bill ${move.name} is no longer a draft.`,
          'Credit the bill in Accounting first, then take the log out of the books.',
        );
    }
    await env
      .model(model)
      .browse([c.id] as never)
      .write({ entry: null } as never);
  }
  await env.flush();
}

/** The ids among `rows` that have nothing to book, or nobody to book it against. */
const unbookable = (
  rows: Iterable<{
    id: number;
    amount: Decimal | null;
    journal: { id: number } | null;
    vendor: { id: number } | null;
  }>,
): number[] =>
  [...rows]
    .filter(
      (r) => r.amount === null || r.amount.lte(0) || (r.journal === null && r.vendor === null),
    )
    .map((r) => r.id);

const NOTHING =
  'Nothing to book: the amount is zero, or it says neither what it was paid from nor who will bill it.';
const LOCKED = 'A booked log no longer changes: take it out of the books first.';

const BOOKING_STATES = { open: 'Not booked', booked: 'Booked' } as const;
const BOOKING_HELP =
  'Booked: its cost is in Accounting, on the vehicle’s cost centre — a posted entry when it was paid from a cash or bank journal, a line on the vendor’s draft bill otherwise.';
const PAID_FROM_HELP =
  'The cash or bank journal it was paid from. Empty: on account — it goes on the vendor’s bill.';

const booked = async (env: Env, model: Logs, ids: readonly number[]): Promise<number[]> => {
  const rows = await env.asSuperuser({ reason: 'booked fleet logs' }, async (su) =>
    (
      await su
        .model(model)
        .browse([...ids] as never)
        .load(['booking'] as never)
    ).read(['id', 'booking'] as never),
  );
  return (rows as Record<string, unknown>[])
    .filter((r) => r['booking'] === 'booked')
    .map((r) => Number(r['id']));
};

const bookingFields = {
  paymentJournal: () =>
    f.many2one('account.journal', {
      ondelete: 'restrict',
      label: 'Paid from',
      help: PAID_FROM_HELP,
    }),
  entry: () =>
    f.many2one('account.move', {
      ondelete: 'restrict',
      label: 'In the books as',
      groups: { write: [...SYSTEM] },
    }),
};

export const FuelBooked = extendModel('fleet.fuel', {
  fields: {
    paymentJournal: bookingFields.paymentJournal(),
    entry: bookingFields.entry(),
    booking: f.state({
      states: BOOKING_STATES,
      initial: 'open',
      label: 'Books',
      help: BOOKING_HELP,
      transitions: {
        book: {
          from: ['open'],
          to: 'booked',
          requires: 'fleet_account.book',
          guard: records('fleet.fuel', async (logs) =>
            unbookable(
              [...(await logs.load({ station: true }))].map((l) => ({
                id: l.id,
                amount: l.amount,
                journal: l.paymentJournal,
                vendor: l.station,
              })),
            ),
          ),
          message: NOTHING,
          after: records('fleet.fuel', async (logs) => {
            const env = logs.env as unknown as Env;
            await env.flush();
            await env.asSuperuser({ reason: 'book fuel' }, (su) =>
              book(su, 'fleet.fuel', logs.ids as readonly number[]),
            );
          }),
        },
        unbook: {
          from: ['booked'],
          to: 'open',
          requires: 'fleet_account.book',
          before: records('fleet.fuel', async (logs) => {
            const env = logs.env as unknown as Env;
            await env.asSuperuser({ reason: 'fuel out of the books' }, (su) =>
              unbook(su, 'fleet.fuel', logs.ids as readonly number[]),
            );
          }),
        },
      },
    }),
  },
  constraints: {
    lockedOnceBooked: {
      ...check('fleet.fuel', ['vehicle', 'date', 'amount', 'station', 'paymentJournal'], (logs) =>
        booked(logs.env as unknown as Env, 'fleet.fuel', logs.ids as readonly number[]),
      ),
      message: LOCKED,
    },
  },
});

export const ServiceBooked = extendModel('fleet.service', {
  fields: {
    paymentJournal: bookingFields.paymentJournal(),
    entry: bookingFields.entry(),
    booking: f.state({
      states: BOOKING_STATES,
      initial: 'open',
      label: 'Books',
      help: BOOKING_HELP,
      transitions: {
        book: {
          from: ['open'],
          to: 'booked',
          requires: 'fleet_account.book',
          guard: records('fleet.service', async (logs) =>
            unbookable(
              [...(await logs.load({ vendor: true }))].map((l) => ({
                id: l.id,
                amount: l.amount,
                journal: l.paymentJournal,
                vendor: l.vendor,
              })),
            ),
          ),
          message: NOTHING,
          after: records('fleet.service', async (logs) => {
            const env = logs.env as unknown as Env;
            await env.flush();
            await env.asSuperuser({ reason: 'book services' }, (su) =>
              book(su, 'fleet.service', logs.ids as readonly number[]),
            );
          }),
        },
        unbook: {
          from: ['booked'],
          to: 'open',
          requires: 'fleet_account.book',
          before: records('fleet.service', async (logs) => {
            const env = logs.env as unknown as Env;
            await env.asSuperuser({ reason: 'services out of the books' }, (su) =>
              unbook(su, 'fleet.service', logs.ids as readonly number[]),
            );
          }),
        },
      },
    }),
  },
  constraints: {
    lockedOnceBooked: {
      ...check('fleet.service', ['vehicle', 'date', 'amount', 'vendor', 'paymentJournal'], (logs) =>
        booked(logs.env as unknown as Env, 'fleet.service', logs.ids as readonly number[]),
      ),
      message: LOCKED,
    },
  },
});

export const PaperBooked = extendModel('fleet.document', {
  fields: {
    paymentJournal: bookingFields.paymentJournal(),
    entry: bookingFields.entry(),
    booking: f.state({
      states: BOOKING_STATES,
      initial: 'open',
      label: 'Books',
      help: BOOKING_HELP,
      transitions: {
        book: {
          from: ['open'],
          to: 'booked',
          requires: 'fleet_account.book',
          guard: records('fleet.document', async (papers) =>
            unbookable(
              [...(await papers.load({ issuer: true }))].map((p) => ({
                id: p.id,
                amount: p.cost,
                journal: p.paymentJournal,
                vendor: p.issuer,
              })),
            ),
          ),
          message: NOTHING,
          after: records('fleet.document', async (papers) => {
            const env = papers.env as unknown as Env;
            await env.flush();
            await env.asSuperuser({ reason: 'book vehicle papers' }, (su) =>
              book(su, 'fleet.document', papers.ids as readonly number[]),
            );
          }),
        },
        unbook: {
          from: ['booked'],
          to: 'open',
          requires: 'fleet_account.book',
          before: records('fleet.document', async (papers) => {
            const env = papers.env as unknown as Env;
            await env.asSuperuser({ reason: 'vehicle papers out of the books' }, (su) =>
              unbook(su, 'fleet.document', papers.ids as readonly number[]),
            );
          }),
        },
      },
    }),
  },
  constraints: {
    lockedOnceBooked: {
      ...check(
        'fleet.document',
        ['vehicle', 'issuedOn', 'cost', 'issuer', 'paymentJournal'],
        (papers) =>
          booked(papers.env as unknown as Env, 'fleet.document', papers.ids as readonly number[]),
      ),
      message: LOCKED,
    },
  },
});

export const VehicleCostCentre = extendModel('fleet.vehicle', {
  fields: {
    analytic: f.many2one('account.analytic', {
      ondelete: 'restrict',
      label: 'Cost centre',
      help: 'Where its fuel, services and papers are booked. Empty: made with the plate the first time something is booked.',
    }),
  },
});

/** A journal line of a fleet cost points at its log: a log that is in the books is not deleted. */
export const LineOfFleet = extendModel('account.move.line', {
  fields: {
    fleetFuel: f.many2one('fleet.fuel', { ondelete: 'restrict', index: true, label: 'Fuel log' }),
    fleetService: f.many2one('fleet.service', {
      ondelete: 'restrict',
      index: true,
      label: 'Service log',
    }),
    fleetDocument: f.many2one('fleet.document', {
      ondelete: 'restrict',
      index: true,
      label: 'Vehicle paper',
    }),
  },
});

export const fleetAccountShutro = defineModule({
  name: 'fleet_account',
  version: '0.1.0',
  depends: [fleetShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'fleet_account.user',
      label: 'Fleet costs in the books',
      implies: ['fleet.user', 'account.invoicing'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'fleet_account.book',
      label: 'Book fleet costs and take them out of the books',
      groups: ['fleet_account.user'],
    }),
  ],
  models: [],
  extensions: [FuelBooked, ServiceBooked, PaperBooked, VehicleCostCentre, LineOfFleet],
});
