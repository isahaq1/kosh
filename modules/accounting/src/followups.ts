/**
 * Payment follow-ups (RFC 0029 §3.4). Levels say how late an invoice must be (days past its due date), how the
 * customer is reminded (email, SMS, WhatsApp), with what text, and whether sales to them stop. Once a day — and on
 * Send now — each customer's overdue invoices are found, the highest level reached and not sent yet is picked, and
 * one reminder goes out with every overdue invoice and its portal link (when the portal is installed); it is noted
 * on each invoice's chatter and logged. A customer is paused until a date (a promise to pay); once nothing is
 * overdue, their follow-up starts over.
 */
import type { Mailer } from '@kosh/mail';
import { layout } from '@kosh/mail';
import { renderBody } from '@kosh/messaging';
import type { Messenger } from '@kosh/notify';
import { audit, HttpProblem } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { defineModel, type Env, f } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** A follow-up level: how late, how the customer is reminded, whether sales stop. */
export const AccountFollowupLevel = defineModel('account.followup.level', {
  label: 'Follow-up level',
  archivable: true,
  companyScoped: { required: true },
  order: ['days asc', 'id asc'],
  access: { 'account.user': ['read'], 'account.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true, label: 'Level' }),
    days: f.integer({
      required: true,
      default: 15,
      label: 'Days overdue',
      help: 'Reached when an invoice is this many days past its due date.',
    }),
    sendEmail: f.boolean({ default: true, label: 'Email' }),
    sendSms: f.boolean({ default: false, label: 'SMS' }),
    sendWhatsapp: f.boolean({ default: false, label: 'WhatsApp' }),
    subject: f.char({ required: true, translate: true, label: 'Subject' }),
    body: f.text({
      required: true,
      translate: true,
      label: 'Email',
      help: 'Placeholders: {{partner}}, {{company}}, {{amount}} (all that is overdue), {{days}} (the oldest), {{invoices}} (one line each, with its link).',
    }),
    shortText: f.char({
      size: 480,
      translate: true,
      label: 'Text message',
      help: 'For SMS and WhatsApp: {{company}}, {{amount}}, {{count}} and {{link}}.',
    }),
    blockSales: f.boolean({
      default: false,
      label: 'Stop sales',
      help: 'Sales orders for the customer cannot be confirmed while they are at this level.',
    }),
  },
  constraints: {
    days: {
      depends: ['days'],
      check: async (records: never) =>
        [...(records as Iterable<{ id: number; days: number }>)]
          .filter((r) => r.days < 1)
          .map((r) => r.id),
      message: 'A level starts at least one day after the due date.',
    },
  },
});

/** Where a customer is in their follow-up, per company. */
export const AccountFollowup = defineModel('account.followup', {
  label: 'Follow-up',
  companyScoped: { required: true },
  order: ['id desc'],
  access: { 'account.user': ['read', 'write', 'create'], 'account.manager': ALL },
  indexes: [{ fields: ['partner', 'company'], unique: true }],
  fields: {
    partner: f.many2one('res.partner', { required: true, ondelete: 'cascade', label: 'Customer' }),
    level: f.many2one('account.followup.level', {
      ondelete: 'set null',
      label: 'Last level sent',
    }),
    sentAt: f.datetime({ label: 'Last sent' }),
    pausedUntil: f.date({
      label: 'Paused until',
      help: 'No reminder before this date: the customer promised to pay.',
    }),
    pauseNote: f.char({ label: 'Promise' }),
  },
});

/** One reminder sent. */
export const AccountFollowupSent = defineModel('account.followup.sent', {
  label: 'Follow-up sent',
  companyScoped: { required: true },
  order: ['id desc'],
  access: { 'account.user': ['read'], 'account.manager': ['read', 'export'] },
  fields: {
    partner: f.many2one('res.partner', { required: true, ondelete: 'cascade', label: 'Customer' }),
    level: f.many2one('account.followup.level', { ondelete: 'set null', label: 'Level' }),
    amount: f.char({ label: 'Overdue' }),
    invoices: f.many2many('account.move', {
      relation: 'account_followup_sent_move_rel',
      label: 'Invoices',
    }),
    channels: f.char({ label: 'Sent by' }),
    automatic: f.boolean({ default: false, label: 'Automatic' }),
  },
});

/** How reminders leave: set by the module's routes from the environment, or by tests. */
let channels: {
  mailer: Mailer | undefined;
  messenger: Messenger | undefined;
  portalUrl: string | null;
} = { mailer: undefined, messenger: undefined, portalUrl: null };

/** Sets the mailer, the text messenger and the portal address (null: no links). */
export function configureFollowups(next: {
  mailer: Mailer | undefined;
  messenger: Messenger | undefined;
  portalUrl: string | null;
}): void {
  channels = next;
}

type Row = Record<string, unknown>;
type Money = { amount: string; currency: string };
type Rows = {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec: unknown): Promise<Rows>;
  read(keys: readonly string[]): Row[];
  write(values: unknown): Promise<void>;
} & Iterable<Row>;
const ref = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    browse(ids: readonly number[]): Rows;
    search(q: unknown): Promise<Rows>;
    create(rows: unknown[]): Promise<{ ids: readonly number[] }>;
  };

const DAY = 86_400_000;
/** A many-to-one as read: its id, whether read gives the id or the record. */
const idOf = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : ((value as { id?: number } | null)?.id ?? undefined);
const dayOf = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
const moneyOf = (value: unknown): Money => {
  const json =
    value !== null && typeof value === 'object' && 'toJSON' in value
      ? (value as { toJSON(): unknown }).toJSON()
      : value;
  const m = (json ?? {}) as Partial<Money>;
  return { amount: String(m.amount ?? '0'), currency: String(m.currency ?? '') };
};

/** A customer's overdue invoices, oldest first. */
export interface Overdue {
  readonly partner: number;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly invoices: readonly {
    readonly id: number;
    readonly name: string;
    readonly dateDue: string;
    readonly days: number;
    readonly residual: Money;
  }[];
  /** Days the oldest is late. */
  readonly days: number;
  /** What is overdue, by currency (`1,200.00 BDT + 50.00 USD`). */
  readonly amount: string;
}

/** Customers with posted invoices past their due date in the environment's company, by partner. */
export async function overdueCustomers(env: Env, only?: number): Promise<Overdue[]> {
  const today = env.today();
  const todayStr = dayOf(today);
  const found = await ref(env, 'account.move').search({
    where: {
      kind: 'out_invoice',
      state: 'posted',
      paymentState: { in: ['not_paid', 'partial'] },
      dateDue: { lt: todayStr },
      ...(only === undefined ? {} : { partner: only }),
    },
    order: ['dateDue asc', 'id asc'],
    limit: 5000,
  });
  const rows = (await found.load({ partner: true })).read([
    'id',
    'name',
    'partner',
    'dateDue',
    'amountResidual',
  ]);
  const byPartner = new Map<number, Row[]>();
  for (const r of rows) {
    const p = idOf(r['partner']);
    if (p === undefined) continue;
    if (moneyOf(r['amountResidual']).amount.replace(/[-0.]/g, '') === '') continue;
    byPartner.set(p, [...(byPartner.get(p) ?? []), r]);
  }
  if (byPartner.size === 0) return [];
  const partners = new Map(
    (
      await ref(env, 'res.partner')
        .browse([...byPartner.keys()])
        .load(['name', 'email', 'mobile', 'phone'])
    )
      .read(['id', 'name', 'email', 'mobile', 'phone'])
      .map((p) => [p['id'] as number, p]),
  );
  const now = Date.parse(`${todayStr}T00:00:00Z`);
  return [...byPartner].map(([partner, list]) => {
    const p = partners.get(partner) ?? {};
    const invoices = list.map((r) => {
      const due = dayOf(r['dateDue']);
      return {
        id: r['id'] as number,
        name: String(r['name']),
        dateDue: due,
        days: Math.round((now - Date.parse(`${due}T00:00:00Z`)) / DAY),
        residual: moneyOf(r['amountResidual']),
      };
    });
    const sums = new Map<string, ReturnType<typeof orm.toDecimal>>();
    for (const i of invoices)
      sums.set(
        i.residual.currency,
        (sums.get(i.residual.currency) ?? orm.toDecimal('0')).plus(
          orm.toDecimal(i.residual.amount),
        ),
      );
    return {
      partner,
      name: String(p['name'] ?? ''),
      email: (p['email'] as string | null) ?? null,
      phone: ((p['mobile'] ?? p['phone']) as string | null) ?? null,
      invoices,
      days: Math.max(...invoices.map((i) => i.days)),
      amount: [...sums]
        .map(
          ([currency, sum]) =>
            `${sum.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${currency}`,
        )
        .join(' + '),
    };
  });
}

/** The levels of the environment's company, by days. */
async function levelsOf(env: Env): Promise<Row[]> {
  return (await ref(env, 'account.followup.level').search({ order: ['days asc'] })).read([
    'id',
    'name',
    'days',
    'sendEmail',
    'sendSms',
    'sendWhatsapp',
    'subject',
    'body',
    'shortText',
    'blockSales',
  ]);
}

/** The follow-up row of a customer (created when missing). */
async function stateOf(env: Env, partner: number): Promise<Row & { id: number }> {
  const found = await ref(env, 'account.followup').search({ where: { partner }, limit: 1 });
  if (found.length > 0)
    return (await found.load({ level: true })).read([
      'id',
      'level',
      'sentAt',
      'pausedUntil',
      'pauseNote',
    ])[0] as Row & { id: number };
  const made = await ref(env, 'account.followup').create([{ partner, company: env.companyId }]);
  return { id: made.ids[0] as number, level: null, sentAt: null, pausedUntil: null };
}

const fill = (text: string, values: Readonly<Record<string, string>>) =>
  text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, key: string) => values[key] ?? all);

/** One line per row of the follow-ups screen. */
export interface FollowupRow extends Overdue {
  readonly due: { readonly id: number; readonly name: string } | null;
  readonly sent: { readonly id: number; readonly name: string } | null;
  readonly sentAt: string | null;
  readonly pausedUntil: string | null;
  readonly pauseNote: string | null;
}

/** Who is late, the level they reached, the last one sent, and whether they are paused. */
export async function followupRows(env: Env): Promise<FollowupRow[]> {
  const levels = await levelsOf(env);
  const late = await overdueCustomers(env);
  const states = new Map(
    (
      await (
        await ref(env, 'account.followup').search({
          where: { partner: { in: late.map((l) => l.partner) } },
        })
      ).load({ partner: true, level: true })
    )
      .read(['partner', 'level', 'sentAt', 'pausedUntil', 'pauseNote'])
      .map((s) => [idOf(s['partner']) as number, s]),
  );
  return late.map((l) => {
    const reached = [...levels].reverse().find((v) => (v['days'] as number) <= l.days);
    const s = states.get(l.partner);
    const levelId = idOf(s?.['level']);
    const level = levels.find((v) => v['id'] === levelId);
    const sentAt = s?.['sentAt'];
    return {
      ...l,
      due:
        reached === undefined
          ? null
          : { id: reached['id'] as number, name: String(reached['name']) },
      sent: level === undefined ? null : { id: level['id'] as number, name: String(level['name']) },
      sentAt: sentAt instanceof Date ? sentAt.toISOString() : null,
      pausedUntil: s?.['pausedUntil'] == null ? null : dayOf(s['pausedUntil']),
      pauseNote: (s?.['pauseNote'] as string | null | undefined) ?? null,
    };
  });
}

/**
 * Sends a customer the reminder of the highest level they reached (`force`: even when it was sent, or they are
 * paused — Send now). Returns the channels used, or null when nothing was due.
 */
export async function followUp(
  env: Env,
  partner: number,
  options: { force?: boolean; automatic?: boolean } = {},
): Promise<{ level: string; channels: string[] } | null> {
  const [late] = await overdueCustomers(env, partner);
  const state = await stateOf(env, partner);
  if (late === undefined) {
    if (state['level'] != null)
      await ref(env, 'account.followup').browse([state.id]).write({ level: null });
    if (options.force === true)
      throw new HttpProblem(
        409,
        'nothing-overdue',
        'Nothing overdue',
        'This customer owes nothing late.',
      );
    return null;
  }
  const levels = await levelsOf(env);
  const level = [...levels].reverse().find((v) => (v['days'] as number) <= late.days);
  if (level === undefined) {
    if (options.force === true)
      throw new HttpProblem(
        409,
        'no-level',
        'No level reached',
        `The oldest invoice is ${late.days} days late; the first level starts later.`,
      );
    return null;
  }
  const today = dayOf(env.today());
  const paused = state['pausedUntil'] != null && dayOf(state['pausedUntil']) >= today;
  const sentLevel = idOf(state['level']);
  const sentDays =
    (levels.find((v) => v['id'] === sentLevel)?.['days'] as number | undefined) ?? -1;
  if (options.force !== true && (paused || sentDays >= (level['days'] as number))) return null;

  const [company] = (await ref(env, 'res.company').browse([env.companyId]).load(['name'])).read([
    'name',
  ]);
  const link = (id: number) =>
    channels.portalUrl === null ? '' : ` ${channels.portalUrl}/d/invoices/${id}`;
  const lines = late.invoices.map(
    (i) =>
      `${i.name}: ${i.residual.amount} ${i.residual.currency}, due ${i.dateDue} (${i.days} days late)${link(i.id)}`,
  );
  const values = {
    partner: late.name,
    company: String(company?.['name'] ?? ''),
    amount: late.amount,
    days: String(late.days),
    count: String(late.invoices.length),
    invoices: lines.join('\n'),
    link: channels.portalUrl === null ? '' : `${channels.portalUrl}/d/invoices`,
  };
  const sent: string[] = [];
  if (level['sendEmail'] === true && late.email !== null && late.email !== '' && channels.mailer) {
    const subject = fill(String(level['subject']), values);
    const body = fill(String(level['body']), values);
    const paragraphs = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const mail = layout({ title: subject, paragraphs, lang: env.lang.slice(0, 2) });
    await channels.mailer.send({ to: late.email, subject, text: body, html: mail.html });
    sent.push('email');
  }
  const short = fill(
    String(level['shortText'] ?? '') || '{{company}}: {{amount}} overdue. {{link}}',
    values,
  );
  for (const [flag, channel] of [
    ['sendSms', 'sms'],
    ['sendWhatsapp', 'whatsapp'],
  ] as const)
    if (
      level[flag] === true &&
      late.phone !== null &&
      late.phone !== '' &&
      channels.messenger?.channels.includes(channel) === true
    ) {
      await channels.messenger.send({ channel, to: late.phone, text: short.trim() });
      sent.push(channel);
    }
  if (sent.length === 0) {
    if (options.force === true)
      throw new HttpProblem(
        409,
        'no-channel',
        'Nothing to send with',
        `${late.name} has no address for this level's channels, or email and texts are not set up.`,
      );
    return null;
  }
  await ref(env, 'account.followup')
    .browse([state.id])
    .write({ level: level['id'], sentAt: new Date() });
  // The log is written by the system: accountants read it, nobody edits it.
  await env.asSuperuser({ reason: 'payment reminder logged' }, (su) =>
    ref(su, 'account.followup.sent').create([
      {
        partner,
        company: env.companyId,
        level: level['id'],
        amount: late.amount,
        invoices: { set: late.invoices.map((i) => i.id) },
        channels: sent.join(', '),
        automatic: options.automatic === true,
      },
    ]),
  );
  // Noted on each invoice's chatter, where accountants look.
  const note = `Payment reminder "${String(level['name'])}" sent by ${sent.join(', ')}: ${late.amount} overdue.`;
  await env.asSuperuser({ reason: 'payment reminder noted on invoices' }, (su) =>
    ref(su, 'mail.message').create(
      late.invoices.map((i) => ({
        resModel: 'account.move',
        resId: i.id,
        kind: 'note',
        ...(env.uid === orm.SYSTEM_UID
          ? { author: null, authorName: 'Payment follow-ups' }
          : { author: env.uid }),
        text: note,
        body: renderBody(note, new Map()),
      })),
    ),
  );
  await audit(env as never, {
    kind: 'account.followup',
    summary: `${late.name}: ${note}`,
    targetModel: 'res.partner',
    targetId: partner,
    details: { level: level['id'], channels: sent },
  });
  return { level: String(level['name']), channels: sent };
}

/** Pauses a customer's reminders until a date (null: resumes them). */
export async function pauseFollowup(
  env: Env,
  partner: number,
  until: string | null,
  note: string | null,
): Promise<void> {
  if (until !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < dayOf(env.today())))
    throw new HttpProblem(400, 'invalid-body', 'Invalid date', 'Pause until a date from today on.');
  const state = await stateOf(env, partner);
  await ref(env, 'account.followup')
    .browse([state.id])
    .write({ pausedUntil: until, pauseNote: until === null ? null : note });
}

/** The daily run for the environment's company (as the system): each late customer, once per level. */
export async function runFollowups(env: Env): Promise<number> {
  let sent = 0;
  for (const late of await overdueCustomers(env))
    if ((await followUp(env, late.partner, { automatic: true })) !== null) sent++;
  // Customers who paid: their follow-up starts over.
  const lateIds = new Set((await overdueCustomers(env)).map((l) => l.partner));
  const done = (
    await (
      await ref(env, 'account.followup').search({ where: { level: { ne: null } } })
    ).load({
      partner: true,
    })
  )
    .read(['id', 'partner'])
    .filter((s) => !lateIds.has(idOf(s['partner']) as number))
    .map((s) => s['id'] as number);
  if (done.length > 0) await ref(env, 'account.followup').browse(done).write({ level: null });
  return sent;
}

/** Whether sales to a customer are stopped by the level they are at (RFC 0028 credit control's companion). */
export async function salesStopped(env: Env, partner: number): Promise<{ level: string } | null> {
  const found = await env.asSuperuser({ reason: 'follow-up sales stop' }, async (su) => {
    const rows = await (
      await ref(su, 'account.followup').search({
        where: { partner, company: env.companyId, level: { ne: null } },
        limit: 1,
      })
    ).load({ level: true });
    const level = idOf(rows.read(['level'])[0]?.['level']);
    if (level === undefined) return null;
    const [l] = (
      await ref(su, 'account.followup.level').browse([level]).load(['name', 'blockSales'])
    ).read(['name', 'blockSales']);
    return l?.['blockSales'] === true ? { level: String(l['name']) } : null;
  });
  return found;
}

/** The levels a company starts with: a reminder at 15 days, a firmer one with a text at 30, sales stopped at 60. */
export async function installFollowupLevels(env: Env): Promise<void> {
  const any = await env
    .withFlags({ activeTest: false })
    .model('account.followup.level' as never)
    .search({ limit: 1 } as never);
  if ((any as unknown as { length: number }).length > 0) return;
  const body = (opening: string) => ({
    en_US: `Dear {{partner}},\n\n${opening}\n\n{{invoices}}\n\nIn all: {{amount}}. If you have paid already, please ignore this message.\n\n{{company}}`,
  });
  await ref(env, 'account.followup.level').create([
    {
      name: { en_US: 'First reminder', bn_BD: 'প্রথম অনুস্মারক' },
      days: 15,
      subject: { en_US: '{{company}}: a friendly reminder', bn_BD: '{{company}}: একটি অনুস্মারক' },
      body: body('These invoices are past their due date:'),
      shortText: { en_US: '{{company}}: {{amount}} is overdue on {{count}} invoice(s). {{link}}' },
    },
    {
      name: { en_US: 'Second reminder', bn_BD: 'দ্বিতীয় অনুস্মারক' },
      days: 30,
      sendSms: true,
      subject: { en_US: '{{company}}: overdue invoices', bn_BD: '{{company}}: বকেয়া ইনভয়েস' },
      body: body('These invoices are now a month late; please settle them this week:'),
      shortText: { en_US: '{{company}}: {{amount}} is a month overdue. Please pay: {{link}}' },
    },
    {
      name: { en_US: 'Final notice', bn_BD: 'চূড়ান্ত নোটিশ' },
      days: 60,
      sendSms: true,
      blockSales: true,
      subject: { en_US: '{{company}}: final notice', bn_BD: '{{company}}: চূড়ান্ত নোটিশ' },
      body: body('These invoices are two months late. New orders are on hold until they are paid:'),
      shortText: { en_US: '{{company}}: {{amount}} two months overdue; orders on hold. {{link}}' },
    },
  ]);
}
