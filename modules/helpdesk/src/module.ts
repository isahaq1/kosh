/**
 * The data layer of Helpdesk (RFC 0024 §2.4): teams with their members, business hours and how tickets are
 * assigned; stages for each team's board; ticket types; SLA policies (a first reply and a resolution, in business
 * hours, by team, priority and customer); canned replies; and tickets — open, waiting on the customer (the SLA clock
 * paused), solved, closed — with their SLA deadlines and status, the customer's rating, and merging.
 *
 * Agents see their teams' tickets; Helpdesk managers every ticket; customers their own through the portal later.
 * The SLA is refreshed by `sla.ts` (every few minutes on the server, and on request).
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { orm } from '@kosh/server/orm';
import { defineModel, defineModule, type Env, f, record, records } from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const HHMM = orm.sql`~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`;

export const PRIORITIES = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' } as const;

/** A priority's rank, for “this priority or higher”. */
export const RANK: Readonly<Record<string, number>> = { low: 0, normal: 1, high: 2, urgent: 3 };

export const HelpdeskTeam = defineModel('helpdesk.team', {
  label: 'Helpdesk team',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'helpdesk.user': READ, 'helpdesk.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    members: f.many2many('res.users', { relation: 'helpdesk_team_member', label: 'Agents' }),
    assignment: f.selection(
      { manual: 'By hand', round_robin: 'In turn', load: 'To the least busy' },
      {
        required: true,
        default: 'round_robin',
        help: 'How new tickets get their agent: in turn among the agents, or to the one with the fewest open tickets.',
      },
    ),
    open: f.char({ size: 5, required: true, default: '09:00', label: 'Opens (HH:MM)' }),
    close: f.char({ size: 5, required: true, default: '18:00', label: 'Closes (HH:MM)' }),
    weekend: f.selection(
      {
        fri_sat: 'Friday and Saturday',
        sat_sun: 'Saturday and Sunday',
        fri: 'Friday only',
        none: 'None (every day)',
      },
      {
        required: true,
        default: 'fri_sat',
        help: 'SLA targets count working hours only: from opening to closing, outside the weekend.',
      },
    ),
    rating: f.boolean({
      default: true,
      label: 'Ask for a rating',
      help: 'When a ticket is solved, its customer is asked to rate the help (one to five).',
    }),
  },
  sqlConstraints: {
    hours: {
      check: orm.sql`open ${HHMM} AND close ${HHMM} AND close > open`,
      message: 'Hours are written HH:MM, the closing after the opening.',
    },
  },
});

export const HelpdeskStage = defineModel('helpdesk.stage', {
  label: 'Ticket stage',
  recName: 'name',
  order: ['sequence asc', 'id asc'],
  archivable: true,
  access: { 'helpdesk.user': READ, 'helpdesk.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    sequence: f.integer({ required: true, default: 10 }),
    fold: f.boolean({ default: false, label: 'Folded on the board' }),
  },
});

export const HelpdeskType = defineModel('helpdesk.type', {
  label: 'Ticket type',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'helpdesk.user': READ, 'helpdesk.manager': [...ALL, 'export', 'import'] },
  fields: { name: f.char({ required: true, translate: true }) },
});

export const HelpdeskSla = defineModel('helpdesk.sla', {
  label: 'SLA policy',
  recName: 'name',
  order: ['sequence asc', 'id asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['firstReplyHours', 'resolveHours'],
  access: { 'helpdesk.user': READ, 'helpdesk.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    sequence: f.integer({
      required: true,
      default: 10,
      help: 'The first policy that matches a ticket applies.',
    }),
    team: f.many2one('helpdesk.team', { ondelete: 'cascade', help: 'Empty: every team.' }),
    priority: f.selection(PRIORITIES, {
      label: 'From priority',
      help: 'Tickets of this priority or higher; empty: every priority.',
    }),
    partner: f.many2one('res.partner', {
      ondelete: 'cascade',
      label: 'Customer',
      help: 'Empty: every customer.',
    }),
    firstReplyHours: f.decimal({
      scale: 2,
      required: true,
      default: '4',
      label: 'First reply within (hours)',
    }),
    resolveHours: f.decimal({
      scale: 2,
      required: true,
      default: '24',
      label: 'Solved within (hours)',
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`first_reply_hours > 0 AND resolve_hours >= first_reply_hours`,
      message: 'Targets are positive, the resolution no sooner than the first reply.',
    },
  },
});

export const HelpdeskCanned = defineModel('helpdesk.canned', {
  label: 'Canned reply',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'helpdesk.user': READ, 'helpdesk.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    body: f.text({
      required: true,
      translate: true,
      help: 'Placeholders: {{customer}}, {{ticket}}, {{agent}} — filled in when used.',
    }),
  },
});

const TICKET_STATES = {
  open: 'Open',
  waiting: 'Waiting on the customer',
  solved: 'Solved',
  closed: 'Closed',
  merged: 'Merged',
} as const;

/** Writes `values` on the tickets as the system: the SLA bookkeeping of a transition. */
async function stamp(tickets: unknown, values: Record<string, unknown>): Promise<void> {
  const { env, ids } = tickets as { env: Env; ids: readonly number[] };
  await env.flush();
  await env.asSuperuser({ reason: 'helpdesk ticket clock' }, async (su) => {
    await su
      .model('helpdesk.ticket')
      .browse([...ids] as never)
      .write(values as never);
    await su.flush();
  });
}

export const HelpdeskTicket = defineModel('helpdesk.ticket', {
  label: 'Ticket',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'stage', 'assignee', 'priority', 'team'],
  access: {
    'helpdesk.user': [...ALL, 'export'],
    'helpdesk.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    // Agents: the tickets of their teams, and the ones given to them.
    teams: {
      groups: ['helpdesk.user'],
      perms: ['read', 'write', 'create'],
      domain: {
        or: [{ 'team.members': { any: { id: me } } }, { assignee: me }, { team: { isNull: true } }],
      },
    },
    all: { groups: ['helpdesk.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'helpdesk.ticket', label: 'Reference' }),
    subject: f.char({ required: true }),
    description: f.text(),
    team: f.many2one('helpdesk.team', { ondelete: 'restrict' }),
    stage: f.many2one('helpdesk.stage', { ondelete: 'restrict' }),
    type: f.many2one('helpdesk.type', { ondelete: 'set null' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Customer' }),
    email: f.char({
      label: 'Customer email',
      help: 'Where replies go when the customer is not a contact yet.',
    }),
    assignee: f.many2one('res.users', { ondelete: 'set null', label: 'Agent' }),
    priority: f.selection(PRIORITIES, {
      required: true,
      default: 'normal',
      help: 'Decides the SLA policy: a policy from a priority covers that one and the ones above.',
    }),
    sla: f.many2one('helpdesk.sla', { ondelete: 'set null', label: 'SLA policy' }),
    firstReplyDeadline: f.datetime({ label: 'First reply by' }),
    resolveDeadline: f.datetime({ label: 'Solved by' }),
    firstRepliedAt: f.datetime({ label: 'First replied' }),
    solvedAt: f.datetime({ label: 'Solved' }),
    waitingSince: f.datetime({ label: 'Waiting since' }),
    pausedMinutes: f.integer({
      required: true,
      default: 0,
      label: 'Paused (working minutes)',
      help: 'Time waiting on the customer: added to the resolution target.',
    }),
    slaStatus: f.selection(
      {
        none: 'No SLA',
        on_track: 'On track',
        at_risk: 'At risk',
        breached: 'Breached',
        met: 'Met',
      },
      {
        required: true,
        default: 'none',
        label: 'SLA',
        help: 'At risk: less than a fifth of the time left; breached: a target passed; met: solved in time.',
      },
    ),
    mergedInto: f.many2one('helpdesk.ticket', { ondelete: 'set null', label: 'Merged into' }),
    rating: f.integer({ label: 'Rating (1–5)' }),
    ratingComment: f.text({ label: 'The customer’s comment' }),
    ratingToken: f.char({
      size: 64,
      label: 'Rating link',
      groups: { read: ['helpdesk.manager'], write: [] },
    }),
    state: f.state({
      states: TICKET_STATES,
      initial: 'open',
      help: 'Waiting on the customer pauses the resolution clock; a customer’s reply resumes it.',
      transitions: {
        wait: {
          from: ['open'],
          to: 'waiting',
          after: records('helpdesk.ticket', (tickets) =>
            stamp(tickets, { waitingSince: new Date() }),
          ),
        },
        resume: {
          from: ['waiting'],
          to: 'open',
          after: records('helpdesk.ticket', (tickets) => closePause(tickets)),
        },
        solve: {
          from: ['open', 'waiting'],
          to: 'solved',
          after: records('helpdesk.ticket', async (tickets) => {
            await closePause(tickets);
            await stamp(tickets, { solvedAt: new Date() });
            const env = tickets.env as unknown as Env;
            const { askRating } = await import('./sla.js');
            await env.asSuperuser({ reason: 'helpdesk rating' }, (su) =>
              askRating(su, tickets.ids as readonly number[]),
            );
            for (const id of tickets.ids) await env.emit('helpdesk.ticket.solved', { id });
          }),
        },
        reopen: { from: ['solved'], to: 'open' },
        close: { from: ['solved'], to: 'closed' },
        merge: { from: ['open', 'waiting'], to: 'merged' },
      },
    }),
  },
  sqlConstraints: {
    rating: {
      check: orm.sql`rating IS NULL OR rating BETWEEN 1 AND 5`,
      message: 'A rating is from one to five.',
    },
  },
});

/** Ends a waiting interval: its working minutes added to the pause. */
async function closePause(tickets: unknown): Promise<void> {
  const { env, ids } = tickets as { env: Env; ids: readonly number[] };
  await env.flush();
  await env.asSuperuser({ reason: 'helpdesk ticket clock' }, async (su) => {
    const { pausedSince } = await import('./sla.js');
    for (const t of await su
      .model('helpdesk.ticket')
      .browse([...ids] as never)
      .load({ team: true })) {
      if (t.waitingSince === null) continue;
      const minutes = await pausedSince(su, t, new Date());
      await su
        .model('helpdesk.ticket')
        .browse([t.id])
        .write({ waitingSince: null, pausedMinutes: t.pausedMinutes + minutes } as never);
    }
    await su.flush();
  });
}

export const helpdeskShutro = defineModule({
  name: 'helpdesk',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'helpdesk.user',
      label: 'Helpdesk agent',
      implies: ['contacts.user', 'messaging.user'],
    }),
    orm.defineGroup({
      code: 'helpdesk.manager',
      label: 'Helpdesk manager',
      implies: ['helpdesk.user'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'helpdesk.ticket',
      prefix: 'HD/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [HelpdeskTeam, HelpdeskStage, HelpdeskType, HelpdeskSla, HelpdeskCanned, HelpdeskTicket],
  data: [
    record('helpdesk.stage', 'stage_new', { name: 'New', sequence: 1 }, { noupdate: true }),
    record(
      'helpdesk.stage',
      'stage_progress',
      { name: 'In progress', sequence: 2 },
      { noupdate: true },
    ),
    record(
      'helpdesk.stage',
      'stage_done',
      { name: 'Done', sequence: 9, fold: true },
      { noupdate: true },
    ),
    record('helpdesk.type', 'type_question', { name: 'Question' }, { noupdate: true }),
    record('helpdesk.type', 'type_problem', { name: 'Problem' }, { noupdate: true }),
    record('helpdesk.type', 'type_request', { name: 'Request' }, { noupdate: true }),
  ],
});
