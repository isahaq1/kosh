/**
 * The data layer of project billing (RFC 0034 §2.5), the bridge of Projects and Accounting for work sold to a
 * customer: **rate cards** (an hour's price by person, role and kind of task), timesheets that are **submitted and
 * approved** before anything is invoiced — the rate is frozen on the hour when it is approved —, **fixed-price
 * milestones** beside time and materials, and the **billing statement**: a document that gathers a project's
 * approved hours and reached milestones up to a day and makes one customer invoice of them, once.
 *
 * An hour or a milestone is on one statement at most; a statement is released only when its invoice is cancelled,
 * and what it held can then be billed again.
 */
import { accountingShutro } from '@kosh/accounting';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { projectShutro } from '@kosh/project';
import { projectAccountShutro } from '@kosh/project_account';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  type Records,
  records,
} from './.kosh/bindings.js';
import { type RateLine, rateFor } from './rates.js';

/**
 * Fields the server maintains: written by its own code (as the system) and by Administrators only. An empty list
 * would mean *everyone* — Shutro reads no groups as no restriction.
 */
const SYSTEM = ['base.admin'] as const;
/** What an hour is sold for: Projects managers and those who bill, not everyone who logs time. */
const RATES = ['project.manager', 'project_billing.manager'] as const;
/** A project's money: read by Projects managers, written by the server. */
const FIGURES = { read: ['project.manager'], write: [...SYSTEM] };

const READ = ['read'] as const;
const WRITE = ['read', 'write'] as const;
const KEEP = ['read', 'write', 'create'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const ZERO: Decimal = orm.toDecimal(0);
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

const DECIDES =
  'Hours are approved or refused by a Projects manager, never one’s own; a refusal says why; on a billed project every hour needs a rate (the project’s rate card).';

export const RateCard = defineModel('project.rate.card', {
  label: 'Rate card',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: {
    'project.manager': READ,
    'project_billing.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, translate: true }),
    defaultRate: f.decimal({
      scale: 2,
      label: 'Rate for everyone else',
      help: 'An hour of anyone no line names; empty: such an hour has no rate and cannot be approved.',
    }),
    lines: f.one2many('project.rate.line', 'card'),
  },
  sqlConstraints: {
    rateNotNegative: {
      check: orm.sql`default_rate IS NULL OR default_rate >= 0`,
      message: 'A rate is not negative.',
    },
  },
});

export const RateCardLine = defineModel('project.rate.line', {
  label: 'Rate',
  order: ['card asc', 'sequence asc', 'id asc'],
  companyScoped: { required: true },
  access: { 'project.manager': READ, 'project_billing.manager': ALL },
  fields: {
    card: f.many2one('project.rate.card', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    sequence: f.integer({ required: true, default: 10 }),
    user: f.many2one('res.users', { ondelete: 'cascade', label: 'Person' }),
    role: f.many2one('project.role', { ondelete: 'cascade', checkCompany: true }),
    category: f.many2one('project.task.category', {
      ondelete: 'cascade',
      label: 'Kind of task',
    }),
    rate: f.decimal({
      scale: 2,
      required: true,
      label: 'Per hour',
      help: 'The most specific line wins: a person before a role, a role before a kind of task.',
    }),
  },
  sqlConstraints: {
    names: {
      check: orm.sql`user_id IS NOT NULL OR role_id IS NOT NULL OR category_id IS NOT NULL`,
      message:
        'A rate names a person, a role or a kind of task (the card has the rate for everyone else).',
    },
    rateNotNegative: { check: orm.sql`rate >= 0`, message: 'A rate is not negative.' },
  },
});

/** A project sold to its customer: by the hour at a rate card, by milestones, or both. */
export const ProjectBilling = extendModel('project.project', {
  fields: {
    billable: f.boolean({
      default: false,
      label: 'Billed to the customer',
      help: 'Its approved hours and reached milestones are invoiced through billing statements.',
    }),
    rateCard: f.many2one('project.rate.card', {
      ondelete: 'restrict',
      checkCompany: true,
      label: 'Rate card',
      help: 'What an hour is sold for; frozen on each hour when it is approved.',
    }),
    billingProduct: f.many2one('product.product', {
      ondelete: 'restrict',
      label: 'Invoiced as',
      help: 'The service on the invoice lines: its income account and its sales taxes.',
    }),
    billingMilestones: f.one2many('project.billing.milestone', 'project'),
    revenue: f.decimal({
      scale: 2,
      label: 'Invoiced revenue',
      groups: FIGURES,
      help: 'Posted customer invoices and credit notes on the project’s cost centre, before taxes.',
    }),
    unbilled: f.decimal({
      scale: 2,
      label: 'Work in progress',
      groups: FIGURES,
      help: 'Approved billable hours and reached milestones that are on no posted invoice yet, at what they sell for.',
    }),
    profit: f.decimal({
      scale: 2,
      label: 'Profit',
      groups: FIGURES,
      help: 'Invoiced revenue and work in progress, less labour and booked costs.',
    }),
    margin: f.decimal({
      scale: 1,
      label: 'Margin %',
      groups: FIGURES,
      help: 'Profit as a share of invoiced revenue and work in progress.',
    }),
  },
  overrides: {
    // With every refresh of a project's figures (hourly, and Refresh on the project): what it earned.
    moneyOf: async function (
      this: unknown,
      next: () => Promise<Map<number, { booked: string; committed: string }>>,
    ): Promise<Map<number, { booked: string; committed: string }>> {
      const out = await next();
      const projects = this as Records<'project.project'>;
      await refreshProfit(
        projects.env as unknown as Env,
        projects.ids.map(Number),
        new Map([...out].map(([id, money]) => [id, money.booked])),
      );
      return out;
    },
  },
});

/** What a phase cost in labour and earned, from the hours on its tasks and the milestones tied to them. */
export const PhaseProfit = extendModel('project.phase', {
  fields: {
    phaseCost: f.decimal({
      scale: 2,
      label: 'Labour cost',
      groups: FIGURES,
      help: 'The hours on the phase’s tasks at each person’s cost.',
    }),
    phaseEarned: f.decimal({
      scale: 2,
      label: 'Earned',
      groups: FIGURES,
      help: 'Approved billable hours on the phase’s tasks at their rate, and reached milestones tied to its tasks.',
    }),
    phaseProfit: f.decimal({
      scale: 2,
      label: 'Profit',
      groups: FIGURES,
      help: 'Earned less labour cost (costs booked in Accounting are the project’s, not a phase’s).',
    }),
  },
});

/** The timesheet lines among `ids` that are submitted or approved. */
async function submittedHours(env: Env, ids: readonly number[]): Promise<number[]> {
  const rows = await env.asSuperuser({ reason: 'submitted hours' }, async (su) =>
    (
      await su
        .model('project.timesheet')
        .browse([...ids] as never)
        .load(['approval'])
    ).read(['id', 'approval']),
  );
  return rows
    .filter((l) => l['approval'] === 'submitted' || l['approval'] === 'approved')
    .map((l) => Number(l['id']));
}

/** A timesheet line on its way to an invoice: submitted, approved at a rate, then on a statement. */
export const TimesheetBilling = extendModel('project.timesheet', {
  fields: {
    billable: f.boolean({
      default: true,
      label: 'Billable',
      help: 'Off: time the customer does not pay for (it still costs, and still needs approving).',
    }),
    approval: f.state({
      states: {
        draft: 'To submit',
        submitted: 'Submitted',
        approved: 'Approved',
        refused: 'Refused',
      },
      initial: 'draft',
      label: 'Approval',
      help: 'Submitted by the person, approved or refused by a Projects manager; only approved hours are invoiced.',
      transitions: {
        submit: { from: ['draft', 'refused'], to: 'submitted' },
        approve: {
          from: ['submitted'],
          to: 'approved',
          guard: records('project.timesheet', (lines) => undecidable(lines, false)),
          message: DECIDES,
          after: records('project.timesheet', async (lines) => {
            const env = lines.env as unknown as Env;
            const by = env.userId;
            await env.asSuperuser({ reason: 'hours approved' }, async (su) => {
              const prices = await pricing(su, lines.ids.map(Number));
              for (const [id, price] of prices)
                await su
                  .model('project.timesheet')
                  .browse([id as never])
                  .write({
                    billRate: price.rate,
                    billAmount: price.amount,
                    approvedBy: by,
                    refuseReason: null,
                  } as never);
              await su.flush();
            });
          }),
        },
        refuse: {
          from: ['submitted'],
          to: 'refused',
          guard: records('project.timesheet', (lines) => undecidable(lines, true)),
          message: DECIDES,
        },
        // Back to the person: what was approved only by who approves, and never once it is on a statement.
        reopen: {
          from: ['submitted', 'refused', 'approved'],
          to: 'draft',
          guard: records('project.timesheet', async (lines) => {
            const env = lines.env as unknown as Env;
            const decides = env.su || env.access.has('project_billing.approve');
            return (await lines.load(['approval', 'statement'])).filter(
              (l) => l.approval === 'approved' && (!decides || l.statement !== null),
            );
          }),
          message:
            'Approved hours are reopened by a Projects manager, and not once they are on a billing statement.',
          after: records('project.timesheet', async (lines) => {
            const env = lines.env as unknown as Env;
            await env.asSuperuser({ reason: 'hours reopened' }, async (su) => {
              await su
                .model('project.timesheet')
                .browse(lines.ids as never)
                .write({ billRate: null, billAmount: null, approvedBy: null } as never);
              await su.flush();
            });
          }),
        },
      },
    }),
    refuseReason: f.char({ label: 'Why refused' }),
    billRate: f.decimal({
      scale: 2,
      label: 'Billed per hour',
      groups: { read: [...RATES], write: [...SYSTEM] },
      help: 'From the project’s rate card on the day it was approved; a later change of the card does not move it.',
    }),
    billAmount: f.decimal({
      scale: 2,
      label: 'To bill',
      groups: { read: [...RATES], write: [...SYSTEM] },
    }),
    approvedBy: f.many2one('res.users', {
      ondelete: 'set null',
      label: 'Approved by',
      groups: { write: [...SYSTEM] },
    }),
    statement: f.many2one('project.statement', {
      ondelete: 'set null',
      label: 'Billing statement',
      groups: { write: [...SYSTEM] },
    }),
  },
  constraints: {
    // What was submitted is what is approved and billed: change it after reopening.
    lockedOnceSubmitted: {
      ...check('project.timesheet', ['hours', 'date', 'task', 'user', 'billable'], (lines) =>
        submittedHours(lines.env as unknown as Env, lines.ids as readonly number[]),
      ),
      message: 'Submitted and approved hours do not change: reopen them first.',
    },
  },
});

/** The milestones among `ids` that are on a billing statement. */
async function onStatement(env: Env, ids: readonly number[]): Promise<number[]> {
  const rows = await env.asSuperuser({ reason: 'billed milestones' }, async (su) =>
    (
      await su
        .model('project.billing.milestone')
        .browse([...ids] as never)
        .load(['statement'])
    ).read(['id', 'statement']),
  );
  return rows.filter((m) => m['statement'] !== null).map((m) => Number(m['id']));
}

/** The statements among `ids` whose invoice is not cancelled. */
async function invoiceStands(env: Env, ids: readonly number[]): Promise<number[]> {
  const rows = await env.asSuperuser({ reason: 'a statement’s invoice' }, async (su) =>
    (
      await su
        .model('account.move')
        .search({ where: { projectStatement: { in: [...ids] }, state: { ne: 'cancel' } } as never })
    ).read(['id', 'projectStatement']),
  );
  return [...new Set(rows.map((m) => Number(m['projectStatement'])))];
}

/** A fixed price for something delivered: invoiced, once, when it is reached. */
export const BillingMilestone = defineModel('project.billing.milestone', {
  label: 'Billing milestone',
  recName: 'name',
  order: ['project asc', 'sequence asc', 'id asc'],
  companyScoped: { required: true },
  tracking: ['state', 'amount'],
  access: {
    'project.manager': WRITE,
    'project_billing.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true }),
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    sequence: f.integer({ required: true, default: 10 }),
    amount: f.decimal({
      scale: 2,
      required: true,
      label: 'Price',
      help: 'Before taxes: one invoice line of this amount when the milestone is reached.',
    }),
    dateDue: f.date({ label: 'Expected' }),
    task: f.many2one('project.task', {
      ondelete: 'set null',
      checkCompany: true,
      label: 'Reached when this task is done',
      help: 'Optional: with a task, the milestone cannot be reached before the task is done.',
    }),
    product: f.many2one('product.product', {
      ondelete: 'restrict',
      label: 'Invoiced as',
      help: 'Empty: the project’s service.',
    }),
    reachedOn: f.date({ label: 'Reached on', groups: { write: [...SYSTEM] } }),
    statement: f.many2one('project.statement', {
      ondelete: 'set null',
      label: 'Billing statement',
      groups: { write: [...SYSTEM] },
    }),
    state: f.state({
      states: { pending: 'To reach', reached: 'Reached' },
      initial: 'pending',
      help: 'Reached: delivered, and on the project’s next billing statement.',
      transitions: {
        reach: emitting('project.billing.milestone.reached', {
          from: ['pending'],
          to: 'reached',
          guard: records('project.billing.milestone', async (milestones) =>
            (await milestones.load({ task: true })).filter(
              (m) => m.task !== null && m.task.done !== true,
            ),
          ),
          message: 'Its task is not done yet.',
          after: records('project.billing.milestone', async (milestones) => {
            const env = milestones.env as unknown as Env;
            await env.asSuperuser({ reason: 'a milestone reached' }, async (su) => {
              await su
                .model('project.billing.milestone')
                .browse(milestones.ids as never)
                .write({ reachedOn: su.today() } as never);
              await su.flush();
            });
          }),
        }),
        revert: {
          from: ['reached'],
          to: 'pending',
          guard: records('project.billing.milestone', async (milestones) =>
            (await milestones.load(['statement'])).filter((m) => m.statement !== null),
          ),
          message: 'It is on a billing statement: release the statement first.',
        },
      },
    }),
  },
  sqlConstraints: {
    amountPositive: { check: orm.sql`amount > 0`, message: 'A milestone has a price above zero.' },
  },
  constraints: {
    lockedOnceBilled: {
      ...check('project.billing.milestone', ['amount', 'project', 'product'], (milestones) =>
        onStatement(milestones.env as unknown as Env, milestones.ids as readonly number[]),
      ),
      message: 'A milestone on a billing statement does not change.',
    },
  },
});

/** What a project is invoiced for, up to a day: approved hours and reached milestones, and the invoice made. */
export const Statement = defineModel('project.statement', {
  label: 'Billing statement',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amount'],
  access: {
    'project.manager': READ,
    'project_billing.manager': [...KEEP, 'export'],
  },
  fields: {
    name: f.char({ required: true, sequence: 'project.statement', label: 'Reference' }),
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'restrict',
    }),
    partner: f.many2one('res.partner', {
      store: true,
      label: 'Customer',
      ...compute('project.statement', 'partner', ['project.partner'], (statements) => {
        for (const s of statements) s.partner = s.project.partner?.id ?? null;
      }),
    }),
    dateTo: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'Hours up to',
      help: 'Approved hours of this day and before; reached milestones whatever their day.',
    }),
    note: f.text({ label: 'Note' }),
    hours: f.decimal({ scale: 2, label: 'Hours', groups: { write: [...SYSTEM] } }),
    amountTime: f.decimal({ scale: 2, label: 'Time', groups: { write: [...SYSTEM] } }),
    amountMilestones: f.decimal({
      scale: 2,
      label: 'Milestones',
      groups: { write: [...SYSTEM] },
    }),
    amount: f.decimal({
      scale: 2,
      label: 'Total before taxes',
      groups: { write: [...SYSTEM] },
      help: 'Time and milestones together: what the invoice was made for.',
    }),
    invoice: f.many2one('account.move', {
      ondelete: 'set null',
      label: 'Invoice',
      groups: { write: [...SYSTEM] },
    }),
    timesheets: f.one2many('project.timesheet', 'statement'),
    milestones: f.one2many('project.billing.milestone', 'statement'),
    state: f.state({
      states: { draft: 'Draft', invoiced: 'Invoiced', cancelled: 'Cancelled' },
      initial: 'draft',
      help: 'Draft until it is invoiced; cancelled when it was discarded, or released after its invoice was cancelled.',
      transitions: {
        bill: emitting('project.statement.billed', {
          from: ['draft'],
          to: 'invoiced',
          guard: records('project.statement', async (statements) => {
            const env = statements.env as unknown as Env;
            const loaded = await statements.load(['project', 'dateTo']);
            return env.asSuperuser({ reason: 'what a statement bills' }, async (su) => {
              const empty: number[] = [];
              for (const s of loaded) {
                const found = await gather(su, s.project.id as number, iso(s.dateTo));
                if (found.timesheets.length + found.milestones.length === 0)
                  empty.push(s.id as number);
              }
              return empty;
            });
          }),
          message:
            'Nothing to invoice: no approved billable hours up to that day, and no reached milestone.',
          after: records('project.statement', async (statements) => {
            const env = statements.env as unknown as Env;
            for (const id of statements.ids) await invoiceStatement(env, id as number);
          }),
        }),
        // After its invoice was cancelled: its hours and milestones can be billed again.
        release: {
          from: ['invoiced'],
          to: 'cancelled',
          guard: records('project.statement', (statements) =>
            invoiceStands(statements.env as unknown as Env, statements.ids as readonly number[]),
          ),
          message: 'Cancel its invoice first (a posted invoice is corrected by a credit note).',
          after: records('project.statement', async (statements) => {
            const env = statements.env as unknown as Env;
            await env.asSuperuser({ reason: 'a statement released' }, async (su) => {
              for (const model of ['project.timesheet', 'project.billing.milestone'] as const) {
                const held = await su
                  .model(model)
                  .search({ where: { statement: { in: statements.ids } } as never });
                if (held.length > 0) await held.write({ statement: null } as never);
              }
              await su.flush();
            });
          }),
        },
        discard: { from: ['draft'], to: 'cancelled' },
      },
    }),
  },
  constraints: {
    lockedOnceBilled: {
      ...check('project.statement', ['project', 'dateTo'], async (statements) =>
        (await statements.load(['state'])).filter((s) => s.state !== 'draft'),
      ),
      message: 'An invoiced statement does not change.',
    },
  },
});

/** The statement an invoice was made for. */
export const MoveStatement = extendModel('account.move', {
  fields: {
    projectStatement: f.many2one('project.statement', {
      ondelete: 'set null',
      label: 'Billing statement',
    }),
    projectRecognition: f.many2one('project.recognition', {
      ondelete: 'set null',
      label: 'Revenue recognition',
    }),
  },
});

// ---- approving

/** What each timesheet line would be billed at now: its rate from the project's card, and the amount. */
async function pricing(
  su: Env,
  ids: readonly number[],
): Promise<Map<number, { billed: boolean; rate: Decimal | null; amount: Decimal | null }>> {
  const out = new Map<number, { billed: boolean; rate: Decimal | null; amount: Decimal | null }>();
  const lines = await su
    .model('project.timesheet')
    .browse([...ids] as never)
    .load({
      user: true,
      task: { category: true },
      project: { rateCard: { lines: true }, members: { role: true, user: true } },
    });
  for (const l of lines) {
    const project = l.project;
    if (l.billable !== true || project === null || project.billable !== true) {
      out.set(l.id as number, { billed: false, rate: null, amount: null });
      continue;
    }
    const card = project.rateCard;
    const day = iso(l.date);
    const member = [...project.members].find(
      (m) =>
        m.user.id === l.user.id &&
        (m.dateFrom === null || iso(m.dateFrom) <= day) &&
        (m.dateTo === null || iso(m.dateTo) >= day),
    );
    const found =
      card === null
        ? null
        : rateFor(
            [...card.lines]
              .sort((a, b) => a.sequence - b.sequence || (a.id as number) - (b.id as number))
              .map(
                (r): RateLine => ({
                  user: (r.user?.id as number | undefined) ?? null,
                  role: (r.role?.id as number | undefined) ?? null,
                  category: (r.category?.id as number | undefined) ?? null,
                  rate: r.rate.toFixed(2),
                }),
              ),
            {
              user: l.user.id as number,
              role: (member?.role?.id as number | undefined) ?? null,
              category: (l.task.category?.id as number | undefined) ?? null,
            },
            card.defaultRate === null ? null : card.defaultRate.toFixed(2),
          );
    const rate = found === null ? null : orm.toDecimal(found.rate);
    out.set(l.id as number, {
      billed: true,
      rate,
      amount: rate === null ? null : l.hours.times(rate).toDecimalPlaces(2),
    });
  }
  return out;
}

/**
 * The lines among `records` the acting user may not decide: all of them without the permission, their own
 * (unless as the system), those without a reason when refusing, and — when approving — billed hours without a rate.
 */
async function undecidable(lines: unknown, refusing: boolean): Promise<number[]> {
  const { env, ids } = lines as { env: Env; ids: readonly number[] };
  if (!env.su && !env.access.has('project_billing.approve')) return [...ids];
  const me = env.userId;
  const system = env.su;
  return env.asSuperuser({ reason: 'who approves hours' }, async (su) => {
    const failing = new Set<number>();
    const loaded = await su
      .model('project.timesheet')
      .browse([...ids] as never)
      .load(['user', 'refuseReason']);
    for (const l of loaded) {
      if (!system && l.user.id === me) failing.add(l.id as number);
      if (refusing && (l.refuseReason === null || l.refuseReason.trim() === ''))
        failing.add(l.id as number);
    }
    if (!refusing)
      for (const [id, price] of await pricing(su, ids))
        if (price.billed && price.rate === null) failing.add(id);
    return [...failing];
  });
}

// ---- invoicing

interface Gathered {
  readonly timesheets: readonly {
    readonly id: number;
    readonly user: number;
    readonly who: string;
    readonly date: string;
    readonly hours: Decimal;
    readonly rate: Decimal;
  }[];
  readonly milestones: readonly {
    readonly id: number;
    readonly name: string;
    readonly amount: Decimal;
    readonly product: number | null;
  }[];
}

/** What a project has to invoice up to a day: approved billable hours and reached milestones on no statement. */
async function gather(su: Env, project: number, dateTo: string): Promise<Gathered> {
  const hours = await su
    .model('project.timesheet')
    .search({
      where: {
        project: project as never,
        approval: 'approved',
        billable: true,
        statement: { isNull: true },
        date: { lte: dateTo },
      } as never,
      order: ['date asc', 'id asc'],
    })
    .then((found) => found.load({ user: true }));
  const reached = await su
    .model('project.billing.milestone')
    .search({
      where: { project: project as never, state: 'reached', statement: { isNull: true } } as never,
      order: ['sequence asc', 'id asc'],
    })
    .then((found) => found.load({ product: true }));
  return {
    timesheets: [...hours]
      .filter((l) => l.billRate !== null)
      .map((l) => ({
        id: l.id as number,
        user: l.user.id as number,
        who: l.user.name,
        date: iso(l.date),
        hours: l.hours,
        rate: l.billRate as Decimal,
      })),
    milestones: [...reached].map((m) => ({
      id: m.id as number,
      name: m.name,
      amount: m.amount,
      product: (m.product?.id as number | undefined) ?? null,
    })),
  };
}

/** A project's cost centre (Projects ↔ Accounting): the one it has, else made with its code, as a refresh would. */
async function costCentreOf(su: Env, project: number): Promise<number> {
  const [p] = await su
    .model('project.project')
    .browse([project as never])
    .load({ analytic: true, company: true });
  if (p === undefined) throw new Error(`No project ${project}.`);
  if (p.analytic !== null) return p.analytic.id as number;
  const made = (
    await su
      .model('account.analytic')
      .create([{ code: p.code ?? `PRJ-${p.id}`, name: p.name, company: p.company.id }])
  ).ids[0] as number;
  await su
    .model('project.project')
    .browse([p.id])
    .write({ analytic: made } as never);
  return made;
}

const refuse = (message: string, hint: string): never => {
  throw new orm.ValidationError('project.statement', ['state'], message, hint);
};

/**
 * Makes the invoice of a statement (RFC 0034 §2.5): one line per person and rate for the hours, one per milestone,
 * on the project's cost centre when it has one; the hours and milestones are then on the statement, and on no other.
 * Returns the invoice.
 */
export async function invoiceStatement(env: Env, id: number): Promise<number> {
  return env.asSuperuser({ reason: 'a billing statement invoiced' }, async (su) => {
    const [s] = await su
      .model('project.statement')
      .browse([id as never])
      .load({
        project: {
          partner: true,
          company: { currency: true },
          billingProduct: { taxes: true },
          analytic: true,
        },
      });
    if (s === undefined) return refuse('The statement is gone.', 'Make a new one.');
    if (s.invoice !== null) return s.invoice.id as number;
    const project = s.project;
    if (project.billable !== true)
      return refuse(
        'The project is not billed to a customer.',
        'Switch on Billed to the customer on the project.',
      );
    if (project.partner === null)
      return refuse('The project has no customer.', 'Choose the customer on the project.');
    const service = project.billingProduct;
    if (service === null)
      return refuse(
        'The project does not say what it is invoiced as.',
        'Choose the service under Invoiced as on the project.',
      );
    const found = await gather(su, project.id as number, iso(s.dateTo));
    const journal = (
      await su
        .model('account.journal')
        .search({ where: { company: project.company.id, type: 'sale' } as never, limit: 1 })
    ).ids[0];
    if (journal === undefined)
      return refuse(
        'The company has no sales journal.',
        'Install a chart of accounts (Accounting › Configuration).',
      );
    // Its cost centre, made now when the project's figures were never refreshed: revenue is the project's.
    const analytic = { analytic: await costCentreOf(su, project.id as number) };
    const taxes = { set: [...service.taxes].map((t) => t.id) };
    // Hours: one line per person and rate, with the days it covers.
    const groups = new Map<
      string,
      { who: string; rate: Decimal; hours: Decimal; from: string; to: string }
    >();
    for (const t of found.timesheets) {
      const key = `${t.user}@${t.rate.toFixed(2)}`;
      const g = groups.get(key);
      if (g === undefined)
        groups.set(key, { who: t.who, rate: t.rate, hours: t.hours, from: t.date, to: t.date });
      else {
        g.hours = g.hours.plus(t.hours);
        if (t.date < g.from) g.from = t.date;
        if (t.date > g.to) g.to = t.date;
      }
    }
    const lines: Record<string, unknown>[] = [];
    let hours = ZERO;
    let amountTime = ZERO;
    for (const g of groups.values()) {
      hours = hours.plus(g.hours);
      amountTime = amountTime.plus(g.hours.times(g.rate).toDecimalPlaces(2));
      lines.push({
        lineKind: 'product',
        product: service.id,
        name: `${project.name}: ${g.who}, ${g.from === g.to ? g.from : `${g.from} – ${g.to}`}`,
        quantity: g.hours,
        priceUnit: g.rate,
        taxes,
        ...analytic,
      });
    }
    let amountMilestones = ZERO;
    for (const m of found.milestones) {
      amountMilestones = amountMilestones.plus(m.amount);
      lines.push({
        lineKind: 'product',
        product: m.product ?? service.id,
        name: `${project.name}: ${m.name}`,
        quantity: orm.toDecimal(1),
        priceUnit: m.amount,
        taxes,
        ...analytic,
      });
    }
    if (lines.length === 0)
      return refuse(
        'Nothing to invoice.',
        'Approve billable hours, or mark a milestone as reached.',
      );
    const invoice = await su.model('account.move').create([
      {
        kind: 'out_invoice',
        journal,
        partner: project.partner.id,
        currency: project.company.currency.id,
        company: project.company.id,
        date: su.today(),
        invoiceOrigin: s.name,
        ref: `${s.name}: ${project.name}`,
        projectStatement: s.id,
        lines: { create: lines },
      } as never,
    ]);
    const invoiceId = invoice.ids[0] as number;
    if (found.timesheets.length > 0)
      await su
        .model('project.timesheet')
        .browse(found.timesheets.map((t) => t.id) as never)
        .write({ statement: s.id } as never);
    if (found.milestones.length > 0)
      await su
        .model('project.billing.milestone')
        .browse(found.milestones.map((m) => m.id) as never)
        .write({ statement: s.id } as never);
    await su
      .model('project.statement')
      .browse([s.id])
      .write({
        invoice: invoiceId,
        hours,
        amountTime,
        amountMilestones,
        amount: amountTime.plus(amountMilestones),
      } as never);
    await su.flush();
    return invoiceId;
  });
}

// ---- work in progress, profit, revenue recognition

const INCOME = ['income', 'income_other'];
const dayAfter = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

interface Unbilled {
  readonly hours: Decimal;
  readonly time: Decimal;
  readonly milestones: Decimal;
}

/**
 * A project's work in progress on a day (RFC 0034 §2.5), as the books stand now: approved billable hours up to
 * that day and milestones reached by then that are on no **posted** invoice — on no statement, or on one whose
 * invoice is still a draft —, at what they sell for.
 */
export async function unbilledOf(su: Env, project: number, date: string): Promise<Unbilled> {
  const open = (statement: { invoice: { state: string } | null } | null): boolean =>
    statement === null || statement.invoice === null || statement.invoice.state !== 'posted';
  let hours = ZERO;
  let time = ZERO;
  for (const l of await su
    .model('project.timesheet')
    .search({
      where: {
        project: project as never,
        approval: 'approved',
        billable: true,
        date: { lte: date },
      } as never,
    })
    .then((found) => found.load({ statement: { invoice: true } }))) {
    if (l.billAmount === null || !open(l.statement)) continue;
    hours = hours.plus(l.hours);
    time = time.plus(l.billAmount);
  }
  let milestones = ZERO;
  for (const m of await su
    .model('project.billing.milestone')
    .search({ where: { project: project as never, state: 'reached' } as never })
    .then((found) => found.load({ statement: { invoice: true } }))) {
    if (m.reachedOn !== null && iso(m.reachedOn) > date) continue;
    if (open(m.statement)) milestones = milestones.plus(m.amount);
  }
  return { hours, time, milestones };
}

/**
 * Writes what each project earned (RFC 0034 §2.5): invoiced revenue from the books — the income lines of posted
 * entries on its cost centre, recognition entries left out —, work in progress, the profit after labour and the
 * costs booked (`booked`, as this refresh found them), the margin; and each phase's labour, earnings and profit.
 */
async function refreshProfit(
  su: Env,
  ids: readonly number[],
  booked: ReadonlyMap<number, string>,
): Promise<void> {
  if (ids.length === 0) return;
  const projects = await su
    .model('project.project')
    .browse([...ids] as never)
    .load({ analytic: true });
  for (const p of projects) {
    let revenue = ZERO;
    if (p.analytic !== null) {
      const lines = await su
        .model('account.move.line')
        .search({
          where: {
            posted: true,
            analytic: p.analytic.id,
            accountType: { in: INCOME },
          } as never,
        })
        .then((found) => found.load({ move: true }));
      for (const l of lines) {
        if (l.move.projectRecognition !== null) continue;
        revenue = revenue.plus(l.credit.amount).minus(l.debit.amount);
      }
    }
    // Everything approved, whatever its day: the figure says what is still to invoice.
    const wip = await unbilledOf(su, p.id as number, '9999-12-31');
    const unbilled = wip.time.plus(wip.milestones);
    const earned = revenue.plus(unbilled);
    const profit = earned
      .minus(p.labourCost ?? ZERO)
      .minus(orm.toDecimal(booked.get(p.id as number) ?? '0'));
    await su
      .model('project.project')
      .browse([p.id])
      .write({
        revenue,
        unbilled,
        profit,
        margin: earned.isZero() ? null : profit.times(100).dividedBy(earned).toDecimalPlaces(1),
      } as never);
  }
  // Phases: the hours on their tasks, and the milestones tied to their tasks.
  const phases = await su
    .model('project.phase')
    .search({ where: { project: { in: [...ids] } } as never });
  if (phases.length === 0) return;
  const cost = new Map<number, Decimal>();
  const earned = new Map<number, Decimal>();
  const add = (map: Map<number, Decimal>, phase: number, amount: Decimal): void => {
    map.set(phase, (map.get(phase) ?? ZERO).plus(amount));
  };
  for (const l of await su
    .model('project.timesheet')
    .search({ where: { project: { in: [...ids] } } as never })
    .then((found) => found.load({ task: { phase: true } }))) {
    const phase = l.task.phase?.id as number | undefined;
    if (phase === undefined) continue;
    add(cost, phase, l.cost ?? ZERO);
    if (l.approval === 'approved' && l.billable === true && l.billAmount !== null)
      add(earned, phase, l.billAmount);
  }
  for (const m of await su
    .model('project.billing.milestone')
    .search({ where: { project: { in: [...ids] }, state: 'reached' } as never })
    .then((found) => found.load({ task: { phase: true } }))) {
    const phase = m.task?.phase?.id as number | undefined;
    if (phase !== undefined) add(earned, phase, m.amount);
  }
  for (const id of phases.ids.map(Number)) {
    const c = cost.get(id) ?? ZERO;
    const e = earned.get(id) ?? ZERO;
    await su
      .model('project.phase')
      .browse([id as never])
      .write({ phaseCost: c, phaseEarned: e, phaseProfit: e.minus(c) } as never);
  }
  await su.flush();
}

/** The accrued income account of revenue recognition: found by its code, made the first time. */
export const ACCRUED_INCOME = {
  code: '1180',
  name: 'Accrued income (work not yet invoiced)',
  type: 'asset_current',
} as const;

const refuseRecognition = (message: string, hint: string): never => {
  throw new orm.ValidationError('project.recognition', ['state'], message, hint);
};

/**
 * Posts a revenue recognition (RFC 0034 §2.5): for every billed project of the company, its work in progress on
 * the day — debit accrued income, credit revenue on the project's cost centre —, in one entry dated that day,
 * and the same entry reversed the day after: the period shows what was earned, and the invoices that follow are
 * not counted twice. Returns the entry.
 */
export async function postRecognition(env: Env, id: number): Promise<number> {
  return env.asSuperuser({ reason: 'revenue recognised' }, async (su) => {
    const [r] = await su
      .model('project.recognition')
      .browse([id as never])
      .load({ company: { currency: true } });
    if (r === undefined) return refuseRecognition('The recognition is gone.', 'Make a new one.');
    if (r.move !== null) return r.move.id as number;
    const company = r.company.id as number;
    const date = iso(r.date);
    const chart = await su
      .model('account.account')
      .search({ where: { company: company as never }, limit: 1 });
    if (chart.length === 0)
      return refuseRecognition(
        'The company has no chart of accounts yet.',
        'Install a chart in Accounting first.',
      );
    const [sales] = await su
      .model('account.journal')
      .search({ where: { company: company as never, type: 'sale' } as never, limit: 1 })
      .then((found) => found.load({ defaultAccount: true }));
    if (sales === undefined || sales.defaultAccount === null)
      return refuseRecognition(
        'The sales journal has no default income account.',
        'Choose it on the journal (Accounting › Configuration › Journals).',
      );
    const accrued =
      (
        await su.model('account.account').search({
          where: { company: company as never, code: ACCRUED_INCOME.code } as never,
          limit: 1,
        })
      ).ids[0] ??
      (await su.model('account.account').create([{ ...ACCRUED_INCOME, company } as never])).ids[0];
    const journal =
      (
        await su.model('account.journal').search({
          where: { company: company as never, code: 'REVR' } as never,
          limit: 1,
        })
      ).ids[0] ??
      (
        await su
          .model('account.journal')
          .create([
            { company, code: 'REVR', name: 'Revenue recognition', type: 'general' } as never,
          ])
      ).ids[0];
    const projects = await su
      .model('project.project')
      .search({ where: { company: company as never, billable: true, active: true } as never })
      .then((found) => found.load({ analytic: true }));
    const rows: Record<string, unknown>[] = [];
    const entry: Record<string, unknown>[] = [];
    const back: Record<string, unknown>[] = [];
    let total = ZERO;
    for (const p of projects) {
      const wip = await unbilledOf(su, p.id as number, date);
      const amount = wip.time.plus(wip.milestones);
      if (amount.lte(0)) continue;
      total = total.plus(amount);
      rows.push({
        recognition: r.id,
        project: p.id,
        company,
        hours: wip.hours,
        amountTime: wip.time,
        amountMilestones: wip.milestones,
        amount,
      });
      const name = `${p.name}: work not yet invoiced on ${date}`;
      const analytic = p.analytic === null ? {} : { analytic: p.analytic.id };
      const value = amount.toFixed(2);
      entry.push(
        { account: accrued, name, debit: value, credit: '0' },
        { account: sales.defaultAccount.id, name, debit: '0', credit: value, ...analytic },
      );
      back.push(
        { account: accrued, name, debit: '0', credit: value },
        { account: sales.defaultAccount.id, name, debit: value, credit: '0', ...analytic },
      );
    }
    if (rows.length === 0)
      return refuseRecognition(
        'Nothing to recognise: no billed project has work that is not on a posted invoice on that day.',
        'Approve the hours and mark the milestones reached first.',
      );
    await su.model('project.recognition.line').create(rows as never);
    const moves = su.model('account.move');
    const base = {
      kind: 'entry',
      journal,
      company,
      currency: r.company.currency.id,
      projectRecognition: r.id,
    };
    const made = (
      await moves.create([
        { ...base, date, ref: `${r.name}: work in progress`, lines: { create: entry } } as never,
      ])
    ).ids[0] as number;
    await moves.browse([made as never]).post();
    const reversal = (
      await moves.create([
        {
          ...base,
          date: dayAfter(date),
          ref: `${r.name}: reversal`,
          reversalOf: made,
          lines: { create: back },
        } as never,
      ])
    ).ids[0] as number;
    await moves.browse([reversal as never]).post();
    await moves.browse([made as never]).write({ reversedBy: reversal } as never);
    await su
      .model('project.recognition')
      .browse([r.id])
      .write({ move: made, reversal, amount: total } as never);
    await su.flush();
    return made;
  });
}

/** The recognitions among `ids` whose day another posted recognition of the company already has. */
async function recognisedAlready(env: Env, ids: readonly number[]): Promise<number[]> {
  return env.asSuperuser({ reason: 'one recognition a day' }, async (su) => {
    const out: number[] = [];
    const rows = (
      await su
        .model('project.recognition')
        .browse([...ids] as never)
        .load(['date', 'company'])
    ).read(['id', 'date', 'company']);
    for (const row of rows) {
      const others = await su.model('project.recognition').search({
        where: {
          company: row['company'] as never,
          date: iso(row['date']),
          state: 'posted',
          id: { ne: row['id'] as never },
        } as never,
        limit: 1,
      });
      if (others.length > 0) out.push(Number(row['id']));
    }
    return out;
  });
}

/** The recognitions among `ids` that are not drafts. */
async function recognitionsPosted(env: Env, ids: readonly number[]): Promise<number[]> {
  const rows = (
    await env
      .model('project.recognition')
      .browse([...ids] as never)
      .load(['state'])
  ).read(['id', 'state']);
  return rows.filter((r) => r['state'] !== 'draft').map((r) => Number(r['id']));
}

/**
 * Revenue recognised at a period's end (RFC 0034 §2.5): work done and approved that is not invoiced yet, booked
 * as revenue on the day and reversed the day after.
 */
export const Recognition = defineModel('project.recognition', {
  label: 'Revenue recognition',
  recName: 'name',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amount'],
  access: { 'project_billing.manager': [...KEEP, 'export'] },
  fields: {
    name: f.char({ required: true, sequence: 'project.recognition', label: 'Reference' }),
    date: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'On',
      help: 'Usually the last day of a month: work approved up to this day and not on a posted invoice.',
    }),
    note: f.text({ label: 'Note' }),
    amount: f.decimal({
      scale: 2,
      label: 'Recognised',
      groups: { write: [...SYSTEM] },
      help: 'The work in progress of every billed project on that day, booked as revenue.',
    }),
    move: f.many2one('account.move', {
      ondelete: 'set null',
      label: 'Entry',
      groups: { write: [...SYSTEM] },
    }),
    reversal: f.many2one('account.move', {
      ondelete: 'set null',
      label: 'Reversed by',
      groups: { write: [...SYSTEM] },
    }),
    lines: f.one2many('project.recognition.line', 'recognition'),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted', cancelled: 'Cancelled' },
      initial: 'draft',
      help: 'Posted: its entry is in the books on the day, and reversed the day after.',
      transitions: {
        recognise: emitting('project.recognition.posted', {
          from: ['draft'],
          to: 'posted',
          guard: records('project.recognition', (runs) =>
            recognisedAlready(runs.env as unknown as Env, runs.ids as readonly number[]),
          ),
          message: 'Revenue is already recognised on that day.',
          after: records('project.recognition', async (runs) => {
            const env = runs.env as unknown as Env;
            for (const id of runs.ids) await postRecognition(env, id as number);
          }),
        }),
        discard: { from: ['draft'], to: 'cancelled' },
      },
    }),
  },
  constraints: {
    lockedOncePosted: {
      ...check('project.recognition', ['date'], (runs) =>
        recognitionsPosted(runs.env as unknown as Env, runs.ids as readonly number[]),
      ),
      message: 'A posted recognition does not change.',
    },
  },
});

export const RecognitionLine = defineModel('project.recognition.line', {
  label: 'Recognised work',
  order: ['recognition desc', 'id asc'],
  companyScoped: { required: true },
  access: { 'project_billing.manager': READ },
  fields: {
    recognition: f.many2one('project.recognition', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'restrict',
    }),
    hours: f.decimal({ scale: 2, label: 'Hours' }),
    amountTime: f.decimal({ scale: 2, label: 'Time' }),
    amountMilestones: f.decimal({ scale: 2, label: 'Milestones' }),
    amount: f.decimal({ scale: 2, label: 'Recognised' }),
  },
});

/**
 * Submitted and approved hours, and milestones on a statement, are not deleted — by their author, with their task
 * or with their project —: at the database too, as nothing in the models runs before a delete. Idempotent.
 */
export async function installBillingGuards(env: Env): Promise<void> {
  await env.sql`
    CREATE OR REPLACE FUNCTION project_billing_keep() RETURNS trigger AS $$
    BEGIN
      IF TG_TABLE_NAME = 'project_timesheet' AND OLD.approval IN ('submitted', 'approved') THEN
        RAISE EXCEPTION 'Submitted and approved hours are not deleted: reopen them first.' USING ERRCODE = 'P0001';
      END IF;
      IF TG_TABLE_NAME = 'project_billing_milestone' AND OLD.statement_id IS NOT NULL THEN
        RAISE EXCEPTION 'A milestone on a billing statement is not deleted.' USING ERRCODE = 'P0001';
      END IF;
      RETURN OLD;
    END $$ LANGUAGE plpgsql`;
  await env.sql`DROP TRIGGER IF EXISTS project_billing_keep ON project_timesheet`;
  await env.sql`CREATE TRIGGER project_billing_keep BEFORE DELETE ON project_timesheet
    FOR EACH ROW EXECUTE FUNCTION project_billing_keep()`;
  await env.sql`DROP TRIGGER IF EXISTS project_billing_keep ON project_billing_milestone`;
  await env.sql`CREATE TRIGGER project_billing_keep BEFORE DELETE ON project_billing_milestone
    FOR EACH ROW EXECUTE FUNCTION project_billing_keep()`;
}

/** Before the module goes: its guards read columns that go with it. */
export async function removeBillingGuards(env: Env): Promise<void> {
  await env.sql`DROP TRIGGER IF EXISTS project_billing_keep ON project_timesheet`;
  await env.sql`DROP TRIGGER IF EXISTS project_billing_keep ON project_billing_milestone`;
  await env.sql`DROP FUNCTION IF EXISTS project_billing_keep()`;
}

export const projectBillingShutro = defineModule({
  name: 'project_billing',
  version: '0.1.0',
  depends: [projectShutro, projectAccountShutro, accountingShutro, productShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'project_billing.manager',
      label: 'Project billing',
      implies: ['project.manager', 'account.invoicing'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'project_billing.approve',
      label: 'Approve and refuse hours',
      groups: ['project.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'project.statement',
      prefix: 'PBS/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
    orm.defineSequence({
      code: 'project.recognition',
      prefix: 'REV/{year}/',
      padding: 4,
      reset: 'yearly',
    }),
  ],
  models: [RateCard, RateCardLine, BillingMilestone, Statement, Recognition, RecognitionLine],
  extensions: [ProjectBilling, PhaseProfit, TimesheetBilling, MoveStatement],
});
