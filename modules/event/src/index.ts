/**
 * @packageDocumentation
 * `@kosh/event` (RFC 0021): the **Event Hub** app. Events with sessions and ticket types, seats limited per event and
 * per ticket, registrations confirmed while seats remain or put on a waiting list that moves up in order, and check-in
 * by the code on the attendee's ticket.
 *
 * - `POST /api/v1/eventhub/checkin`   `{ code }`: the attendee checked in, once (a phone scanning the QR sends it)
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, calendar, form, kanban, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { eventDemo } from './demo.js';
import { EventEvent, EventRegistration, EventSession, EventTicket, eventShutro } from './module.js';

export {
  EventEvent,
  EventRegistration,
  EventSession,
  EventTicket,
  eventShutro,
  newCode,
} from './module.js';

function registerEventRoutes({ app }: ModuleContext): void {
  app.post('/api/v1/eventhub/checkin', async (request) => {
    const code = String((request.body as { code?: unknown } | null)?.code ?? '')
      .trim()
      .toUpperCase();
    if (code === '')
      throw new HttpProblem(400, 'invalid-code', 'No code', 'Send the code on the ticket.');
    return request.env(
      async (raw) => {
        const env = raw as Env;
        const [r] = await (
          await env.model('event.registration').search({ where: { code }, limit: 1 })
        ).load({ event: true, ticket: true });
        if (r === undefined)
          throw new HttpProblem(
            404,
            'unknown-code',
            'Unknown ticket',
            `No registration has the code ${code}.`,
          );
        if (r.state === 'attended')
          throw new HttpProblem(
            409,
            'already-checked-in',
            'Already checked in',
            `${r.name} was checked in at ${r.checkedInAt?.toISOString() ?? 'an earlier time'}.`,
          );
        if (r.state !== 'confirmed')
          throw new HttpProblem(
            409,
            'not-confirmed',
            'Not confirmed',
            `${r.name}'s registration is not confirmed.`,
          );
        await env.model('event.registration').browse([r.id]).attend();
        return {
          registration: r.id,
          name: r.name,
          event: r.event.name,
          ticket: r.ticket?.name ?? null,
        };
      },
      { write: true },
    );
  });
}

export const event: ReturnType<typeof defineModule> = defineModule({
  shutro: eventShutro,
  kosh: '^0.1.0',
  hooks: { demo: eventDemo },
  depends: [contacts, messaging, reporting],
  // The ticket and badge: the attendee, the event, and the QR the door scans.
  documents: [
    {
      key: 'ticket',
      name: 'Ticket and badge',
      model: 'event.registration',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        blocks: [
          { kind: 'heading', id: 'event_name', text: '{{event.name}}', level: 1 },
          { kind: 'heading', id: 'attendee', text: '{{name}}', level: 2 },
          {
            kind: 'fields',
            id: 'details',
            items: [
              { label: 'Ticket', bind: 'ticket.name' },
              { label: 'Starts', bind: 'event.dateBegin' },
              { label: 'Venue', bind: 'event.venue' },
              { label: 'Code', bind: 'code' },
            ],
          },
          { kind: 'qr', id: 'qr', bind: 'code', size: 45, label: 'Show this at the door' },
        ],
      },
    },
  ],
  app: {
    code: 'eventhub',
    label: 'Event Hub',
    icon: 'eventhub',
    sequence: 41,
    category: 'Marketing',
    summary: 'Events, tickets and seats, waiting lists, check-in by QR',
  },
  accessLevels: {
    user: { label: 'User (registrations, check-in)', groups: ['event.user'] },
    manager: {
      label: 'Manager (events, tickets, everything)',
      groups: ['event.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerEventRoutes(context),
  actions: {
    'eventhub.action_events': action(EventEvent, {
      label: 'Events',
      views: ['kanban', 'list', 'calendar', 'form'],
    }),
    'eventhub.action_registrations': action(EventRegistration, {
      label: 'Registrations',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'eventhub.root', label: 'Event Hub', app: 'eventhub' },
    {
      id: 'eventhub.events',
      parent: 'eventhub.root',
      label: 'Events',
      action: 'eventhub.action_events',
      sequence: 1,
    },
    {
      id: 'eventhub.registrations',
      parent: 'eventhub.root',
      label: 'Registrations',
      action: 'eventhub.action_registrations',
      sequence: 2,
    },
  ],
  views: {
    'event.event.kanban': kanban(EventEvent, {
      groupBy: 'state',
      card: { title: 'name', subtitle: 'venue', footer: ['dateBegin', 'seatsAvailable'] },
    }),
    'event.event.list': list(EventEvent, {
      columns: [
        'name',
        'dateBegin',
        'venue',
        'seatsMax',
        'seatsTaken',
        'attended',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'event.event.calendar': calendar(EventEvent, {
      dateStart: 'dateBegin',
      dateStop: 'dateEnd',
      title: 'name',
      mode: 'month',
    }),
    'event.event.form': form(EventEvent, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('publish', { primary: true, label: 'Open registrations' }),
          k.button('close', { label: 'End' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this event?' }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'dateBegin', 'dateEnd', 'venue', 'organizer']),
        k.group('seats', [
          'seatsMax',
          'seatsTaken',
          'seatsAvailable',
          'attended',
          'waitingList',
          'currency',
        ]),
        k.component('checkin', 'event.CheckIn'),
        k.lines('tickets', [
          { field: 'name', id: 'ticket_name' },
          { field: 'price', id: 'ticket_price' },
          { field: 'seatsMax', id: 'ticket_seats' },
          { field: 'saleEnd', id: 'ticket_sale_end' },
          { field: 'seatsTaken', id: 'ticket_sold' },
        ]),
        k.lines('sessions', [
          { field: 'name', id: 'session_name' },
          { field: 'dateBegin', id: 'session_begin' },
          { field: 'dateEnd', id: 'session_end' },
          { field: 'room', id: 'session_room' },
          { field: 'speaker', id: 'session_speaker' },
        ]),
        k.group('about', ['description'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'event.registration.list': list(EventRegistration, {
      columns: ['name', 'event', 'ticket', 'email', 'code', { field: 'state', widget: 'badge' }],
    }),
    'event.registration.form': form(EventRegistration, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('confirm', { primary: true, label: 'Confirm' }),
          k.button('wait', { label: 'Waiting list' }),
          k.button('attend', { primary: true, label: 'Check in' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      sheet: [
        k.group('main', ['event', 'ticket', 'name', 'email', 'phone', 'partner']),
        k.group('ticket_info', ['code', 'price', 'checkedInAt']),
      ],
      chatter: true,
    })),
    'event.ticket.list': list(EventTicket, {
      columns: ['event', 'name', 'price', 'seatsMax', 'seatsTaken'],
    }),
    'event.session.list': list(EventSession, {
      columns: ['event', 'name', 'dateBegin', 'dateEnd', 'room', 'speaker'],
    }),
  },
  search: {
    'event.event': search(EventEvent, {
      fields: ['name', 'venue'],
      filters: {
        open: { label: 'Open for registration', domain: { state: 'published' } },
      },
      groupBy: ['state', 'organizer'],
    }),
    'event.registration': search(EventRegistration, {
      fields: ['name', 'email', 'code', 'event.name'],
      filters: {
        confirmed: { label: 'Confirmed', domain: { state: 'confirmed' }, group: 'state' },
        waiting: { label: 'Waiting list', domain: { state: 'waiting' }, group: 'state' },
        attended: { label: 'Checked in', domain: { state: 'attended' }, group: 'state' },
      },
      groupBy: ['event', 'ticket', 'state'],
    }),
    'event.ticket': search(EventTicket, { fields: ['name', 'event.name'] }),
    'event.session': search(EventSession, { fields: ['name', 'speaker', 'event.name'] }),
  },
});
