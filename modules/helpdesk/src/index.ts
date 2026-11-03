/**
 * @packageDocumentation
 * `@kosh/helpdesk` (RFC 0024 §2.4): the **Helpdesk** app. Teams with business hours and assignment in turn or by
 * load; tickets from email (`helpdesk@`, the sender found or added as a contact; replies thread into the ticket) and
 * from the back-office; SLA policies by team, priority and customer, counted in business hours with the clock paused
 * while waiting on the customer, resumed when they write back; drafted replies from the chatter's assistant; canned
 * replies; merging; and the customer's rating of the help.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import type { ModuleContext } from '@kosh/server';
import { action, form, kanban, list, pivot, search, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { helpdeskDemo } from './demo.js';
import {
  HelpdeskCanned,
  HelpdeskSla,
  HelpdeskStage,
  HelpdeskTeam,
  HelpdeskTicket,
  HelpdeskType,
  helpdeskShutro,
} from './module.js';
import { registerHelpdeskRoutes } from './routes.js';

export { addBusinessMinutes, businessMinutesBetween, type Hours, WEEKENDS } from './hours.js';
export {
  HelpdeskCanned,
  HelpdeskSla,
  HelpdeskStage,
  HelpdeskTeam,
  HelpdeskTicket,
  HelpdeskType,
  helpdeskShutro,
  PRIORITIES,
} from './module.js';
export { askRating, hoursOf, pausedSince, rate, refreshSla, timeZoneOf } from './sla.js';

/** A ticket's values from an email to `helpdesk@`: the first team, the sender as the customer (added when new). */
export async function ticketFromEmail(
  raw: unknown,
  sender: { readonly address: string; readonly name: string | null },
): Promise<Record<string, unknown> | null> {
  const env = raw as Env;
  const team =
    (await env.model('helpdesk.team').search({ order: ['id asc'], limit: 1 })).ids[0] ?? null;
  const address = sender.address.trim().toLowerCase();
  if (address === '') return { team };
  const known = (
    await env.model('res.partner').search({ where: { email: { ilike: address } }, limit: 1 })
  ).ids[0];
  const partner =
    known ??
    (
      await env
        .model('res.partner')
        .create([{ name: sender.name ?? address, email: address } as never])
    ).ids[0];
  return { team, partner: partner ?? null, email: address };
}

export const helpdesk: ReturnType<typeof defineModule> = defineModule({
  shutro: helpdeskShutro,
  kosh: '^0.1.0',
  hooks: { demo: helpdeskDemo },
  depends: [contacts, messaging, reporting],
  app: {
    code: 'helpdesk',
    label: 'Helpdesk',
    icon: 'helpdesk',
    sequence: 12,
    category: 'Services',
    summary: 'Tickets from email, SLAs in business hours, assignment, ratings',
  },
  accessLevels: {
    user: { label: 'Agent (the tickets of their teams)', groups: ['helpdesk.user'] },
    manager: {
      label: 'Helpdesk manager (teams, SLAs, every ticket)',
      groups: ['helpdesk.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerHelpdeskRoutes(context),
  // helpdesk@<inbound domain>: a ticket for the sender (RFC 0006 §7.1); replies thread in through the reply address.
  inboundAliases: [
    {
      alias: 'helpdesk',
      model: 'helpdesk.ticket',
      subjectField: 'subject',
      bodyField: 'description',
      defaults: ticketFromEmail,
    },
  ],
  // Automation rules can act on a ticket's fields (an SLA breached, a priority raised).
  changeEvents: ['helpdesk.ticket'],
  settings: {
    sections: [
      {
        key: 'clock',
        label: 'Time zone',
        description: 'The teams’ business hours are read in this time zone.',
        keywords: 'timezone time zone sla business hours',
        scope: 'installation',
        editors: ['helpdesk.manager'],
        fields: [
          {
            key: 'timezone',
            type: 'char',
            label: 'Time zone',
            default: 'Asia/Dhaka',
            help: 'An IANA name such as Asia/Dhaka or Asia/Kolkata.',
          },
        ],
      },
    ],
  },
  events: [{ topic: 'helpdesk.ticket.solved', model: 'helpdesk.ticket', label: 'Ticket solved' }],
  documents: [
    {
      key: 'ticket',
      name: 'Ticket',
      model: 'helpdesk.ticket',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}} — {{subject}}', level: 1 },
          {
            kind: 'fields',
            id: 'ticket',
            items: [
              { label: 'Customer', bind: 'partner.name' },
              { label: 'Team', bind: 'team.name' },
              { label: 'Agent', bind: 'assignee.name' },
              { label: 'Priority', bind: 'priority' },
              { label: 'Status', bind: 'state' },
              { label: 'SLA', bind: 'slaStatus' },
              { label: 'Solved by', bind: 'resolveDeadline' },
            ],
          },
          { kind: 'text', id: 'description', text: '{{description}}' },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'tickets',
      model: 'helpdesk.ticket',
      label: 'Tickets',
      columns: [
        { header: 'Subject', field: 'subject' },
        { header: 'Description', field: 'description' },
        { header: 'Customer', field: 'partner' },
        { header: 'Team', field: 'team' },
        { header: 'Priority', field: 'priority' },
      ],
    },
    {
      key: 'teams',
      model: 'helpdesk.team',
      label: 'Teams',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Opens', field: 'open' },
        { header: 'Closes', field: 'close' },
        { header: 'Weekend', field: 'weekend' },
      ],
    },
    {
      key: 'slas',
      model: 'helpdesk.sla',
      label: 'SLA policies',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Team', field: 'team' },
        { header: 'From priority', field: 'priority' },
        { header: 'First reply within (hours)', field: 'firstReplyHours' },
        { header: 'Solved within (hours)', field: 'resolveHours' },
      ],
    },
    {
      key: 'types',
      model: 'helpdesk.type',
      label: 'Ticket types',
      columns: [{ header: 'Name', field: 'name' }],
    },
    {
      key: 'stages',
      model: 'helpdesk.stage',
      label: 'Stages',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Sequence', field: 'sequence' },
      ],
    },
  ],
  overview: {
    cards: [
      {
        id: 'open',
        title: 'Open tickets',
        kind: 'kpi',
        model: 'helpdesk.ticket',
        measure: 'count',
        filter: { state: { in: ['open', 'waiting'] } },
        w: 3,
      },
      {
        id: 'breached',
        title: 'SLA breached',
        kind: 'kpi',
        model: 'helpdesk.ticket',
        measure: 'count',
        filter: { slaStatus: 'breached', state: { in: ['open', 'waiting'] } },
        w: 3,
      },
      {
        id: 'solved_month',
        title: 'Solved this month',
        kind: 'kpi',
        model: 'helpdesk.ticket',
        measure: 'count',
        filter: { state: { in: ['solved', 'closed'] } },
        comparison: { field: 'solvedAt', mode: 'previous' },
        w: 3,
      },
      {
        id: 'rating',
        title: 'Average rating',
        kind: 'kpi',
        model: 'helpdesk.ticket',
        measure: 'avg:rating',
        filter: { rating: { isNull: false } },
        w: 3,
      },
      {
        id: 'by_sla',
        title: 'Tickets by SLA',
        kind: 'chart',
        model: 'helpdesk.ticket',
        measure: 'count',
        groupBy: 'slaStatus',
        chart: 'pie',
        filter: { state: { in: ['open', 'waiting'] } },
        w: 6,
      },
      {
        id: 'by_agent',
        title: 'Open by agent',
        kind: 'pivot',
        model: 'helpdesk.ticket',
        measure: 'count',
        groupBy: 'assignee',
        filter: { state: { in: ['open', 'waiting'] } },
        w: 6,
      },
    ],
  },
  actions: {
    'helpdesk.action_tickets': action(HelpdeskTicket, {
      label: 'Tickets',
      views: ['kanban', 'list', 'form', 'pivot'],
    }),
    'helpdesk.action_teams': action(HelpdeskTeam, { label: 'Teams', views: ['list', 'form'] }),
    'helpdesk.action_slas': action(HelpdeskSla, { label: 'SLA policies', views: ['list', 'form'] }),
    'helpdesk.action_canned': action(HelpdeskCanned, {
      label: 'Canned replies',
      views: ['list', 'form'],
    }),
    'helpdesk.action_stages': action(HelpdeskStage, { label: 'Stages', views: ['list', 'form'] }),
    'helpdesk.action_types': action(HelpdeskType, {
      label: 'Ticket types',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'helpdesk.root', label: 'Helpdesk', app: 'helpdesk' },
    {
      id: 'helpdesk.tickets',
      parent: 'helpdesk.root',
      label: 'Tickets',
      action: 'helpdesk.action_tickets',
      sequence: 1,
    },
    {
      id: 'helpdesk.canned',
      parent: 'helpdesk.root',
      label: 'Canned replies',
      action: 'helpdesk.action_canned',
      sequence: 2,
    },
    { id: 'helpdesk.configuration', parent: 'helpdesk.root', label: 'Configuration', sequence: 9 },
    {
      id: 'helpdesk.teams',
      parent: 'helpdesk.configuration',
      label: 'Teams',
      action: 'helpdesk.action_teams',
      sequence: 1,
    },
    {
      id: 'helpdesk.slas',
      parent: 'helpdesk.configuration',
      label: 'SLA policies',
      action: 'helpdesk.action_slas',
      sequence: 2,
    },
    {
      id: 'helpdesk.stages',
      parent: 'helpdesk.configuration',
      label: 'Stages',
      action: 'helpdesk.action_stages',
      sequence: 3,
    },
    {
      id: 'helpdesk.types',
      parent: 'helpdesk.configuration',
      label: 'Ticket types',
      action: 'helpdesk.action_types',
      sequence: 4,
    },
  ],
  views: {
    'helpdesk.ticket.kanban': kanban(HelpdeskTicket, {
      groupBy: 'stage',
      card: {
        title: 'subject',
        subtitle: 'partner',
        avatar: 'assignee',
        footer: [{ field: 'resolveDeadline', widget: 'daysLeft' }, 'name'],
        badges: [{ field: 'slaStatus', widget: 'badge' }],
      },
    }),
    'helpdesk.ticket.list': list(HelpdeskTicket, {
      columns: [
        'name',
        'subject',
        'partner',
        'team',
        'assignee',
        'priority',
        'state',
        'slaStatus',
        'resolveDeadline',
      ],
      defaultOrder: ['id desc'],
      decorations: { danger: { slaStatus: 'breached' }, warning: { slaStatus: 'at_risk' } },
    }),
    'helpdesk.ticket.pivot': pivot(HelpdeskTicket, {
      rows: ['team'],
      cols: ['slaStatus'],
      measures: ['count'],
    }),
    'helpdesk.ticket.form': form(HelpdeskTicket, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('solve', { primary: true, label: 'Solved' }),
          k.button('wait', { label: 'Waiting on the customer' }),
          k.button('resume', { label: 'Resume' }),
          k.button('reopen', { label: 'Reopen' }),
          k.button('close', { label: 'Close' }),
        ],
      },
      sheet: [
        k.group('main', [
          'name',
          'subject',
          'partner',
          'email',
          'team',
          'assignee',
          'type',
          'priority',
          'stage',
        ]),
        k.group('details', ['description'], { label: 'Description' }),
        k.group(
          'service_level',
          [
            'sla',
            'slaStatus',
            'firstReplyDeadline',
            'firstRepliedAt',
            'resolveDeadline',
            'pausedMinutes',
          ],
          {
            label: 'SLA',
            description:
              'In the team’s business hours; waiting on the customer pauses the resolution target.',
          },
        ),
        k.group('outcome', ['solvedAt', 'rating', 'ratingComment', 'mergedInto'], {
          label: 'Outcome',
        }),
      ],
      chatter: true,
    })),
    'helpdesk.team.list': list(HelpdeskTeam, {
      columns: ['name', 'assignment', 'open', 'close', 'weekend'],
    }),
    'helpdesk.team.form': form(HelpdeskTeam, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.stats('related', [
          stat({
            id: 'team_open',
            label: 'Open tickets',
            model: 'helpdesk.ticket',
            where: { team: { $record: 'id' }, state: { in: ['open', 'waiting'] } },
            action: 'helpdesk.action_tickets',
          }),
        ]),
        k.group('main', ['name', 'members', 'assignment', 'rating']),
        k.group('hours', ['open', 'close', 'weekend'], { label: 'Business hours' }),
      ],
    })),
    'helpdesk.sla.list': list(HelpdeskSla, {
      columns: [
        'sequence',
        'name',
        'team',
        'priority',
        'partner',
        'firstReplyHours',
        'resolveHours',
      ],
    }),
    'helpdesk.sla.form': form(HelpdeskSla, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'sequence', 'team', 'priority', 'partner'], {
          description: 'The first policy, by sequence, that matches a ticket applies to it.',
        }),
        k.group('targets', ['firstReplyHours', 'resolveHours'], {
          label: 'Targets (business hours)',
        }),
      ],
    })),
    'helpdesk.canned.list': list(HelpdeskCanned, { columns: ['name'] }),
    'helpdesk.canned.form': form(HelpdeskCanned, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'body'])],
    })),
    'helpdesk.stage.list': list(HelpdeskStage, { columns: ['sequence', 'name', 'fold'] }),
    'helpdesk.stage.form': form(HelpdeskStage, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'sequence', 'fold'])],
    })),
    'helpdesk.type.list': list(HelpdeskType, { columns: ['name'] }),
    'helpdesk.type.form': form(HelpdeskType, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name'])],
    })),
  },
  viewExtensions: [
    {
      view: 'res.partner.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'partner_tickets',
              label: 'Tickets',
              model: 'helpdesk.ticket',
              where: { partner: { $record: 'id' } },
              action: 'helpdesk.action_tickets',
            }),
          ],
        },
      ],
    },
  ],
  search: {
    'helpdesk.ticket': search(HelpdeskTicket, {
      fields: ['name', 'subject', 'partner.name', 'email'],
      filters: {
        mine: { label: 'Mine', domain: { assignee: { $env: 'uid' } }, group: 'who' },
        unassigned: { label: 'Unassigned', domain: { assignee: { isNull: true } }, group: 'who' },
        open: { label: 'Open', domain: { state: { in: ['open', 'waiting'] } }, group: 'state' },
        breached: { label: 'SLA breached', domain: { slaStatus: 'breached' }, group: 'sla' },
        at_risk: { label: 'SLA at risk', domain: { slaStatus: 'at_risk' }, group: 'sla' },
      },
      groupBy: ['team', 'assignee', 'stage', 'priority', 'slaStatus', 'partner'],
    }),
    'helpdesk.team': search(HelpdeskTeam, { fields: ['name'] }),
    'helpdesk.sla': search(HelpdeskSla, { fields: ['name'], groupBy: ['team', 'priority'] }),
    'helpdesk.canned': search(HelpdeskCanned, { fields: ['name', 'body'] }),
    'helpdesk.stage': search(HelpdeskStage, { fields: ['name'] }),
    'helpdesk.type': search(HelpdeskType, { fields: ['name'] }),
  },
});
