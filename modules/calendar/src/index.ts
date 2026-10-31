/**
 * @packageDocumentation
 * `@kosh/calendar` (RFC 0021): the **Agenda** app. Meetings with attendees from the company and outside, rooms that
 * are never double-booked, private events that others see as *busy*, answers in one click, and free / busy for
 * several people and rooms at once. The end follows the start by the default length set in App settings.
 *
 * - `POST /api/v1/agenda/events/:id/respond`   `{ response: 'accepted' | 'tentative' | 'declined' }`: your answer
 * - `GET  /api/v1/agenda/busy?users=1,2&rooms=3&from=…&to=…`   busy blocks per person and room (titles of the
 *   events the caller may see; others are only *busy*)
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { action, calendar, form, list, search } from '@kosh/views';
import { calendarDemo } from './demo.js';
import { CalendarEvent, CalendarRoom, calendarShutro } from './module.js';

export { CalendarAttendee, CalendarEvent, CalendarRoom, calendarShutro } from './module.js';

const RESPONSES = new Set(['accepted', 'tentative', 'declined']);
type Row = Record<string, unknown>;
interface Records {
  readonly length: number;
  readonly ids: readonly number[];
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
}
const search$ = (env: Env, model: string, where: unknown) =>
  (env.model(model as never) as unknown as { search(q: unknown): Promise<Records> }).search({
    where,
  });
const rows = async (set: Records, keys: readonly string[]) =>
  set.length === 0 ? [] : (await set.load(keys)).read(['id', ...keys]);
const ids = (text: unknown) =>
  String(text ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);

function registerAgendaRoutes({ app }: ModuleContext): void {
  app.post('/api/v1/agenda/events/:id/respond', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    const response = (request.body as Row | null)?.['response'];
    if (typeof response !== 'string' || !RESPONSES.has(response))
      throw new HttpProblem(
        422,
        'invalid-response',
        'Invalid answer',
        'Answer accepted, tentative or declined.',
      );
    return request.env(async (env) => {
      // As the user: the attendee rule lets them change their own answer only.
      const mine = await search$(env, 'calendar.attendee', { event: id, user: env.uid });
      if (mine.length === 0)
        throw new HttpProblem(
          404,
          'missing-record',
          'Not invited',
          'You are not an attendee of this event.',
        );
      await mine.write({ response });
      return { event: id, response };
    });
  });

  app.get('/api/v1/agenda/busy', async (request) => {
    const q = (request.query ?? {}) as Row;
    const from = new Date(String(q['from'] ?? ''));
    const to = new Date(String(q['to'] ?? ''));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from)
      throw new HttpProblem(
        400,
        'invalid-range',
        'Invalid range',
        'from and to are ISO times, to after from.',
      );
    if (to.getTime() - from.getTime() > 62 * 86_400_000)
      throw new HttpProblem(400, 'invalid-range', 'Invalid range', 'At most two months at once.');
    const users = ids(q['users']);
    const rooms = ids(q['rooms']);
    return request.env(
      async (env) => {
        if (!env.administrator && !env.groups.has('calendar.user'))
          throw new HttpProblem(403, 'access', 'Agenda', 'Free / busy needs the Agenda access.');
        if (users.length === 0 && rooms.length === 0) return { users: {}, rooms: {} };
        // Everyone's events are read to know who is busy; only what the caller may see is named.
        return env.asSuperuser({ reason: 'free / busy' }, async (su) => {
          const overlap = { state: 'confirmed', start: { lt: to }, stop: { gt: from } };
          const attended =
            users.length === 0
              ? []
              : await rows(await search$(su, 'calendar.attendee', { user: { in: users } }), [
                  'event',
                  'user',
                  'response',
                ]);
          const eventIds = [
            ...new Set(
              attended.filter((a) => a['response'] !== 'declined').map((a) => a['event'] as number),
            ),
          ];
          const events = await rows(
            await search$(su, 'calendar.event', {
              ...overlap,
              or: [
                ...(eventIds.length === 0 ? [] : [{ id: { in: eventIds } }]),
                ...(users.length === 0 ? [] : [{ organizer: { in: users } }]),
                ...(rooms.length === 0 ? [] : [{ room: { in: rooms } }]),
              ] as unknown[],
            }),
            ['name', 'start', 'stop', 'organizer', 'room', 'privacy'],
          );
          const visible = new Set(
            (await search$(env, 'calendar.event', { id: { in: events.map((e) => e['id']) } })).ids,
          );
          const iso = (v: unknown) => new Date(v instanceof Date ? v : String(v)).toISOString();
          const block = (e: Row) => ({
            start: iso(e['start']),
            stop: iso(e['stop']),
            title: visible.has(e['id'] as number) ? String(e['name']) : null,
          });
          return {
            users: Object.fromEntries(
              users.map((u) => [
                u,
                events
                  .filter(
                    (e) =>
                      e['organizer'] === u ||
                      attended.some(
                        (a) =>
                          a['user'] === u && a['event'] === e['id'] && a['response'] !== 'declined',
                      ),
                  )
                  .map(block),
              ]),
            ),
            rooms: Object.fromEntries(
              rooms.map((r) => [r, events.filter((e) => e['room'] === r).map(block)]),
            ),
          };
        });
      },
      { write: true }, // the superuser read is audited
    );
  });
}

export const calendarApp: ReturnType<typeof defineModule> = defineModule({
  shutro: calendarShutro,
  kosh: '^0.1.0',
  hooks: { demo: calendarDemo },
  depends: [contacts, messaging, reporting],
  app: {
    code: 'agenda',
    label: 'Agenda',
    icon: 'agenda',
    sequence: 6,
    category: 'Productivity',
    summary: 'Meetings, rooms and who is free when',
  },
  accessLevels: {
    user: { label: 'User (own and public events)', groups: ['calendar.user'] },
    manager: {
      label: 'Manager (every event, rooms)',
      groups: ['calendar.manager'],
      implies: ['user'],
    },
  },
  settings: {
    sections: [
      {
        key: 'events',
        label: 'Events',
        description: 'How new events start out.',
        keywords: 'meeting duration length calendar',
        scope: 'installation',
        editors: ['calendar.manager'],
        fields: [
          {
            key: 'defaultMinutes',
            type: 'integer',
            label: 'Default length (minutes)',
            default: 60,
            min: 5,
            max: 1440,
            help: 'A new event ends this long after it starts; each can still be changed.',
          },
        ],
      },
    ],
  },
  routes: (context: ModuleContext) => registerAgendaRoutes(context),
  // The Overview (RFC 0022 step 2).
  overview: {
    cards: [
      {
        id: 'month',
        title: 'Meetings this month',
        kind: 'kpi',
        model: 'calendar.event',
        measure: 'count',
        filter: { state: 'confirmed' },
        comparison: { field: 'start', mode: 'previous' },
        w: 3,
      },
      {
        id: 'cancelled_month',
        title: 'Cancelled this month',
        kind: 'kpi',
        model: 'calendar.event',
        measure: 'count',
        filter: { state: 'cancelled' },
        comparison: { field: 'start', mode: 'previous' },
        w: 3,
      },
      { id: 'rooms', title: 'Rooms', kind: 'kpi', model: 'calendar.room', measure: 'count', w: 3 },
      {
        id: 'attendees',
        title: 'Attendee answers',
        kind: 'kpi',
        model: 'calendar.attendee',
        measure: 'count',
        w: 3,
      },
      {
        id: 'by_room',
        title: 'Meetings by room',
        kind: 'chart',
        model: 'calendar.event',
        measure: 'count',
        groupBy: 'room',
        filter: { state: 'confirmed' },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_organizer',
        title: 'By organiser',
        kind: 'chart',
        model: 'calendar.event',
        measure: 'count',
        groupBy: 'organizer',
        filter: { state: 'confirmed' },
        chart: 'pie',
        w: 6,
      },
    ],
  },
  actions: {
    'agenda.action_events': action(CalendarEvent, {
      label: 'Calendar',
      views: ['calendar', 'list', 'form'],
    }),
    'agenda.action_rooms': action(CalendarRoom, { label: 'Rooms', views: ['list', 'form'] }),
  },
  menus: [
    { id: 'agenda.root', label: 'Agenda', app: 'agenda' },
    {
      id: 'agenda.events',
      parent: 'agenda.root',
      label: 'Calendar',
      action: 'agenda.action_events',
      sequence: 1,
    },
    { id: 'agenda.configuration', parent: 'agenda.root', label: 'Configuration', sequence: 9 },
    {
      id: 'agenda.rooms',
      parent: 'agenda.configuration',
      label: 'Rooms',
      action: 'agenda.action_rooms',
      sequence: 1,
    },
  ],
  views: {
    'calendar.event.calendar': calendar(CalendarEvent, {
      dateStart: 'start',
      dateStop: 'stop',
      title: 'name',
      color: 'organizer',
      mode: 'week',
    }),
    'calendar.event.list': list(CalendarEvent, {
      columns: [
        'name',
        'start',
        'stop',
        'organizer',
        'room',
        { field: 'privacy', widget: 'badge' },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['start desc'],
    }),
    'calendar.event.form': form(CalendarEvent, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('cancel', {
            label: 'Cancel the event',
            confirm: 'Cancel this event? Its room is freed.',
          }),
          k.button('restore', { label: 'Restore' }),
        ],
      },
      sheet: [
        k.group('when', ['name', 'start', 'stop', 'allDay', 'organizer', 'privacy']),
        k.group('where', ['room', 'location', 'videoUrl']),
        k.lines('attendees', ['user', 'partner', 'response']),
        k.group('about', ['description'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'calendar.room.list': list(CalendarRoom, {
      columns: ['name', 'capacity', 'location'],
      inlineEdit: ['name', 'capacity', 'location'],
    }),
    'calendar.room.form': form(CalendarRoom, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'capacity', 'location'])],
    })),
  },
  search: {
    'calendar.event': search(CalendarEvent, {
      fields: ['name', 'location', 'room.name'],
      filters: {
        mine: { label: 'I organize', domain: { organizer: { $env: 'uid' } } },
        invited: {
          label: 'I am invited',
          domain: { attendees: { any: { user: { $env: 'uid' } } } },
        },
        confirmed: { label: 'Confirmed', domain: { state: 'confirmed' }, group: 'state' },
        cancelled: { label: 'Cancelled', domain: { state: 'cancelled' }, group: 'state' },
      },
      groupBy: ['organizer', 'room', 'start:week'],
    }),
    'calendar.room': search(CalendarRoom, { fields: ['name', 'location'] }),
  },
});
