/**
 * The data layer of Agenda (RFC 0021): events with their attendees — people of the company or contacts from outside,
 * each with their answer — rooms that are never double-booked, and privacy: public events are seen by every Agenda
 * user, private ones by their organizer and attendees only. Only the organizer (and Agenda managers) change an event;
 * an attendee changes their own answer.
 */

import { randomBytes } from 'node:crypto';
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { emitting, installationSetting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  addDays,
  dateIn,
  instantOf,
  isWorkingDay,
  scheduleOf,
  worktimeShutro,
} from '@kosh/worktime';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  onchange,
  records,
} from './.kosh/bindings.js';
import {
  describeRule,
  type MonthlyOn,
  type OnDayOff,
  occurrences,
  type Rule,
} from './recurrence.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;

/** A meeting room (or any bookable place): booked with its events, never twice at once. */
export const CalendarRoom = defineModel('calendar.room', {
  label: 'Room',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'calendar.user': ['read'], 'calendar.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    capacity: f.integer({ label: 'Seats' }),
    location: f.char(),
  },
});

export const CalendarEvent = defineModel('calendar.event', {
  label: 'Event',
  recName: 'name',
  order: ['start desc', 'id desc'],
  tracking: ['start', 'stop', 'room', 'state'],
  access: { 'calendar.user': ALL, 'calendar.manager': ALL },
  rules: {
    // Public events for everyone; private ones for their organizer and attendees.
    see: {
      groups: ['calendar.user'],
      perms: ['read'],
      domain: {
        or: [{ privacy: 'public' }, { organizer: me }, { attendees: { any: { user: me } } }],
      },
    },
    organize: {
      groups: ['calendar.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { organizer: me },
    },
    all: { groups: ['calendar.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Title' }),
    start: f.datetime({ required: true }),
    stop: f.datetime({ required: true, label: 'End' }),
    allDay: f.boolean({ default: false, label: 'All day' }),
    organizer: f.many2one('res.users', { required: true, default: (env: Env) => env.userId }),
    attendees: f.one2many('calendar.attendee', 'event'),
    room: f.many2one('calendar.room', { ondelete: 'restrict' }),
    location: f.char(),
    videoUrl: f.char({ label: 'Video call link' }),
    privacy: f.selection(
      { public: 'Public', private: 'Private (busy for others)' },
      {
        required: true,
        default: 'public',
        help: 'Public events are seen by everyone in Agenda; private ones show only as busy to people not invited.',
      },
    ),
    state: f.state({
      states: { confirmed: 'Confirmed', cancelled: 'Cancelled' },
      initial: 'confirmed',
      help: 'A confirmed event takes place and holds its room; a cancelled one frees the room and can be restored.',
      transitions: {
        cancel: emitting('calendar.event.cancelled', { from: ['confirmed'], to: 'cancelled' }),
        restore: { from: ['cancelled'], to: 'confirmed' },
        // Emails the attendees an invitation their mail client and calendar read (again after a change).
        invite: emitting('calendar.event.invited', { from: ['confirmed'], to: 'confirmed' }),
      },
    }),
    description: f.html(),
    /** The record of another app it is about (`sale.order`, 42), if any. */
    resModel: f.char({ label: 'About (model)' }),
    resId: f.integer({ label: 'About (id)' }),
    /** The repeating series it is an occurrence of, and the date of the series it stands for. */
    recurrence: f.many2one('calendar.recurrence', {
      ondelete: 'set null',
      label: 'Repeats as',
      groups: { write: [] },
    }),
    recurrenceDate: f.date({ label: 'Date in the series', groups: { write: [] } }),
    /** Raised at each invitation sent: a mail client keeps the latest version of the event. */
    inviteSequence: f.integer({ default: 0, label: 'Invitation version', groups: { write: [] } }),
    invitedAt: f.datetime({ label: 'Invitations sent', groups: { write: [] } }),
    detached: f.boolean({
      default: false,
      label: 'Keep as it is',
      help: 'An occurrence of a series that the series no longer changes: tick it after moving or rewording this one meeting.',
    }),
  },
  sqlConstraints: {
    endsAfterStart: { check: orm.sql`stop > start`, message: 'An event ends after it starts.' },
  },
  constraints: {
    // Across everyone's events, private ones too: the check reads as the system, not as the user.
    roomFree: {
      ...check('calendar.event', ['room', 'start', 'stop', 'state'], async (events) =>
        events.env.asSuperuser({ reason: 'room bookings' }, async (su) => {
          const failing: number[] = [];
          for (const e of events) {
            if (e.room === null || e.state === 'cancelled') continue;
            const clash = await su.model('calendar.event').search({
              where: {
                room: e.room.id,
                state: 'confirmed',
                id: { ne: e.id },
                start: { lt: e.stop },
                stop: { gt: e.start },
              },
              limit: 1,
            });
            if (clash.length > 0) failing.push(e.id);
          }
          return failing;
        }),
      ),
      message: 'The room is already booked at that time.',
    },
  },
  onchange: {
    // The end follows the start by the default length (Settings › App settings › Agenda).
    start: onchange('calendar.event', async (d, env) => {
      const start = d.get('start');
      const at = start instanceof Date ? start.getTime() : Date.parse(String(start ?? ''));
      if (Number.isNaN(at)) return;
      const minutes = await installationSetting(env, 'calendar.defaultMinutes', 60);
      d.set('stop', new Date(at + Number(minutes) * 60_000));
    }),
  },
});

const WEEKDAY_FIELDS = ['onSun', 'onMon', 'onTue', 'onWed', 'onThu', 'onFri', 'onSat'] as const;

/**
 * A repeating series (RFC 0034 §2.4): a meeting that happens again by a rule — every week on Tuesday, the second
 * Tuesday of the month, the last working day — until a date or for so many times. *Generate* makes its occurrences
 * as events of their own, so each holds its room, has its attendees' answers and can be moved or cancelled alone;
 * generating again after a change redoes the occurrences still to come, and leaves the past and the ones kept as
 * they are. Days off come from the company's working calendar.
 */
export const CalendarRecurrence = defineModel('calendar.recurrence', {
  label: 'Repeating event',
  recName: 'name',
  order: ['start desc', 'id desc'],
  tracking: ['state', 'start', 'freq', 'interval', 'until', 'count'],
  access: { 'calendar.user': ALL, 'calendar.manager': ALL },
  rules: {
    see: {
      groups: ['calendar.user'],
      perms: ['read'],
      domain: { or: [{ privacy: 'public' }, { organizer: me }, { people: { any: { id: me } } }] },
    },
    organize: {
      groups: ['calendar.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { organizer: me },
    },
    all: { groups: ['calendar.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Title' }),
    start: f.datetime({ required: true, label: 'First starts' }),
    stop: f.datetime({ required: true, label: 'First ends' }),
    organizer: f.many2one('res.users', { required: true, default: (env: Env) => env.userId }),
    people: f.many2many('res.users', { label: 'People invited' }),
    contacts: f.many2many('res.partner', { label: 'Contacts invited' }),
    room: f.many2one('calendar.room', { ondelete: 'restrict' }),
    location: f.char(),
    videoUrl: f.char({ label: 'Video call link' }),
    privacy: f.selection(
      { public: 'Public', private: 'Private (busy for others)' },
      {
        required: true,
        default: 'public',
        help: 'As on an event: public for everyone in Agenda, or private to the organizer and the people invited.',
      },
    ),
    description: f.html(),
    freq: f.selection(
      { daily: 'Day', weekly: 'Week', monthly: 'Month', yearly: 'Year' },
      {
        required: true,
        default: 'weekly',
        label: 'Repeats every',
        help: 'The unit the series repeats by.',
      },
    ),
    interval: f.integer({
      required: true,
      default: 1,
      label: 'Every',
      help: '1: every week; 2: every second week; and so on.',
    }),
    onSun: f.boolean({ default: false, label: 'Sunday' }),
    onMon: f.boolean({ default: false, label: 'Monday' }),
    onTue: f.boolean({ default: false, label: 'Tuesday' }),
    onWed: f.boolean({ default: false, label: 'Wednesday' }),
    onThu: f.boolean({ default: false, label: 'Thursday' }),
    onFri: f.boolean({ default: false, label: 'Friday' }),
    onSat: f.boolean({ default: false, label: 'Saturday' }),
    monthlyOn: f.selection(
      {
        day: 'The same day of the month',
        weekday: 'The same weekday (the second Tuesday)',
        last_weekday: 'The last such weekday (the last Friday)',
        first_working: 'The first working day',
        last_working: 'The last working day',
      },
      {
        required: true,
        default: 'day',
        label: 'In the month, on',
        help: 'For a series by month or by year: which day it falls on, counted from the first meeting’s date.',
      },
    ),
    onDayOff: f.selection(
      {
        keep: 'Keep it that day',
        skip: 'Skip it',
        before: 'Move it to the working day before',
        after: 'Move it to the working day after',
      },
      {
        required: true,
        default: 'keep',
        label: 'On a weekend or a holiday',
        help: 'What becomes of an occurrence that falls on a day off of the company’s working calendar.',
      },
    ),
    count: f.integer({ label: 'Times', help: 'Ends after this many occurrences.' }),
    until: f.date({ label: 'Until', help: 'Ends on this date (included).' }),
    summary: f.char({
      store: true,
      label: 'In words',
      help: 'The rule as a sentence.',
      ...compute(
        'calendar.recurrence',
        'summary',
        ['start', 'freq', 'interval', 'monthlyOn', 'onDayOff', 'count', 'until', ...WEEKDAY_FIELDS],
        (series) => {
          for (const r of series) {
            try {
              r.summary =
                r.start === null
                  ? ''
                  : describeRule(ruleOf(r as never), r.start.toISOString().slice(0, 10));
            } catch {
              r.summary = '';
            }
          }
        },
      ),
    }),
    events: f.one2many('calendar.event', 'recurrence', { label: 'Occurrences' }),
    state: f.state({
      states: { draft: 'Draft', active: 'Running', stopped: 'Stopped' },
      initial: 'draft',
      help: 'Drafted until its occurrences are generated; running while it has some to come; stopped once its future occurrences are removed.',
      transitions: {
        generate: {
          from: ['draft', 'active', 'stopped'],
          to: 'active',
          after: records('calendar.recurrence', async (series) => {
            for (const id of series.ids) {
              await generateSeries(series.env, id as number);
              await series.env.emit('calendar.recurrence.generated', { id });
            }
          }),
        },
        // Not `stop`: a transition is a method of the record, and the series has a field of that name.
        halt: {
          from: ['active'],
          to: 'stopped',
          after: records('calendar.recurrence', async (series) => {
            for (const id of series.ids) await generateSeries(series.env, id as number, true);
          }),
        },
      },
    }),
  },
  sqlConstraints: {
    endsAfterStart: { check: orm.sql`stop > start`, message: 'An event ends after it starts.' },
    everyOne: { check: orm.sql`"interval" >= 1`, message: 'A series repeats every 1 or more.' },
    ends: {
      check: orm.sql`(count IS NOT NULL AND count >= 1) OR until IS NOT NULL`,
      message: 'A series ends: after a number of times, or on a date.',
    },
  },
});

/** The rule of a series, from its fields. */
function ruleOf(r: {
  freq: string;
  interval: number;
  monthlyOn: string;
  onDayOff: string;
  count: number | null;
  until: unknown;
  [day: string]: unknown;
}): Rule {
  return {
    freq: r.freq as Rule['freq'],
    interval: r.interval,
    weekdays: WEEKDAY_FIELDS.map((key, day) => (r[key] === true ? day : -1)).filter((d) => d >= 0),
    monthlyOn: r.monthlyOn as MonthlyOn,
    onDayOff: r.onDayOff as OnDayOff,
    count: r.count,
    until: r.until == null ? null : String(r.until).slice(0, 10),
  };
}

/**
 * Makes a series' occurrences as events, or — `stopping` — removes the ones still to come. The past is never
 * touched, nor an occurrence marked *Keep as it is* or moved to another time by hand. Occurrences keep the first
 * meeting's time of day in the company's time zone, whatever daylight saving does. A room taken on one of the
 * dates refuses the whole series, naming the date.
 */
export async function generateSeries(env: Env, id: number, stopping = false): Promise<number> {
  return env.asSuperuser({ reason: 'the occurrences of a repeating event' }, async (su) => {
    const [r] = await (
      await su.model('calendar.recurrence').search({ where: { id: id as never }, limit: 1 })
    ).load({ people: true, contacts: true, events: true });
    if (r === undefined) return 0;
    const first = r.start.toISOString().slice(0, 10);
    const schedule = await scheduleOf(su as never, { from: first, to: addDays(first, 3660) });
    const tz = schedule.tz;
    // The first meeting's local date, time of day and length: what every occurrence keeps.
    const day0 = dateIn(r.start, tz);
    const minutes = Math.round((r.start.getTime() - instantOf(day0, 0, tz)) / 60_000);
    const length = r.stop.getTime() - r.start.getTime();
    const startOn = (date: string) => new Date(instantOf(date, minutes, tz));
    const dates = stopping
      ? []
      : occurrences(ruleOf(r as never), day0, (date) => isWorkingDay(schedule, date));
    const wanted = new Set(dates);
    const now = Date.now();
    const firstTime = r.events.length === 0;

    type Occurrence = {
      id: number;
      start: Date;
      detached: boolean;
      recurrenceDate: unknown;
    };
    const have = new Map<string, Occurrence>();
    const gone: number[] = [];
    for (const e of [...r.events] as unknown as Occurrence[]) {
      const date = e.recurrenceDate === null ? null : String(e.recurrenceDate).slice(0, 10);
      if (date === null) continue;
      // The past stands; so does an occurrence kept as it is, or moved by hand to another time.
      const own = e.detached || e.start.getTime() !== startOn(date).getTime();
      if (e.start.getTime() < now || own) {
        have.set(date, e);
        continue;
      }
      if (wanted.has(date)) have.set(date, e);
      else gone.push(e.id);
    }
    if (gone.length > 0)
      await su
        .model('calendar.event')
        .browse(gone as never)
        .unlink();

    const values = {
      name: r.name,
      organizer: r.organizer.id,
      room: r.room?.id ?? null,
      location: r.location,
      videoUrl: r.videoUrl,
      privacy: r.privacy,
      description: r.description,
    };
    const fresh: Record<string, unknown>[] = [];
    for (const date of dates) {
      const start = startOn(date);
      const stop = new Date(start.getTime() + length);
      const existing = have.get(date);
      if (existing !== undefined) {
        // Redone only when still to come and still the series' own.
        if (
          existing.start.getTime() >= now &&
          !existing.detached &&
          existing.start.getTime() === start.getTime()
        )
          await su
            .model('calendar.event')
            .browse([existing.id as never])
            .write({ ...values, stop } as never);
        continue;
      }
      if (!firstTime && start.getTime() < now) continue; // a changed rule does not rewrite the past
      if (r.room !== null) {
        const clash = await su.model('calendar.event').search({
          where: { room: r.room.id, state: 'confirmed', start: { lt: stop }, stop: { gt: start } },
          limit: 1,
        });
        if (clash.length > 0)
          throw new orm.ValidationError(
            'calendar.recurrence',
            ['room'],
            `The room is already booked on ${date}.`,
            'Choose another room or another time, or free the room on that day, then generate again.',
          );
      }
      fresh.push({
        ...values,
        start,
        stop,
        recurrence: r.id,
        recurrenceDate: date,
        attendees: {
          create: [
            ...[...r.people].map((u) => ({ user: u.id })),
            ...[...r.contacts].map((c) => ({ partner: c.id })),
          ],
        },
      });
    }
    if (fresh.length > 0) await su.model('calendar.event').create(fresh as never);
    await su.flush();
    return fresh.length;
  });
}

/** An attendee: a person of the company (`user`) or a contact from outside (`partner`), with their answer. */
export const CalendarAttendee = defineModel('calendar.attendee', {
  label: 'Attendee',
  order: ['id asc'],
  access: { 'calendar.user': ALL, 'calendar.manager': ALL },
  rules: {
    see: {
      groups: ['calendar.user'],
      perms: ['read'],
      domain: {
        or: [
          { 'event.privacy': 'public' },
          { 'event.organizer': me },
          { user: me },
          { 'event.attendees': { any: { user: me } } },
        ],
      },
    },
    // The organizer manages the list; each attendee answers for themself.
    answer: {
      groups: ['calendar.user'],
      perms: ['write'],
      domain: { or: [{ 'event.organizer': me }, { user: me }] },
    },
    organize: {
      groups: ['calendar.user'],
      perms: ['create', 'unlink'],
      domain: { 'event.organizer': me },
    },
    all: { groups: ['calendar.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    event: f.many2one('calendar.event', { required: true, ondelete: 'cascade' }),
    user: f.many2one('res.users', { label: 'Person' }),
    partner: f.many2one('res.partner', { label: 'Contact' }),
    invitedAt: f.datetime({ label: 'Invited by email', groups: { write: [] } }),
    response: f.selection(
      {
        needs_action: 'Not answered',
        accepted: 'Accepted',
        tentative: 'Maybe',
        declined: 'Declined',
      },
      {
        required: true,
        default: 'needs_action',
        label: 'Answer',
        help: 'Whether this person will come: not answered yet, accepted, maybe or declined.',
      },
    ),
  },
  sqlConstraints: {
    someone: {
      check: orm.sql`user_id IS NOT NULL OR partner_id IS NOT NULL`,
      message: 'An attendee is a person or a contact.',
    },
  },
});

/**
 * A person's calendar address (RFC 0034 §2.4): a secret link another calendar — Google, Outlook, a phone — reads
 * their events from. Theirs alone: nobody else, managers included, sees it. Deleting it closes the address; a new
 * one has a new secret.
 */
export const CalendarFeed = defineModel('calendar.feed', {
  label: 'Calendar address',
  recName: 'name',
  order: ['id asc'],
  access: { 'calendar.user': ALL, 'calendar.manager': ALL },
  rules: {
    own: { groups: ['calendar.user'], perms: [...ALL], domain: { user: me } },
  },
  fields: {
    name: f.char({
      required: true,
      default: 'My calendar',
      help: 'What you call it (where you subscribed: Phone, Outlook).',
    }),
    user: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.userId,
      ondelete: 'cascade',
      groups: { write: [] },
    }),
    token: f.char({
      size: 64,
      required: true,
      index: 'unique',
      default: () => randomBytes(24).toString('base64url'),
      groups: { write: [] },
    }),
    address: f.char({
      label: 'Address to subscribe to',
      help: 'Paste it into your calendar as a subscription by URL. Anyone who has it reads your events: do not share it.',
      ...compute('calendar.feed', 'address', ['token'], (feeds) => {
        const base = (process.env['KOSH_BASE_URL'] ?? 'http://localhost:5173').replace(/\/$/, '');
        for (const feed of feeds) feed.address = `${base}/api/v1/agenda/feed/${feed.token}.ics`;
      }),
      store: true,
    }),
    lastReadAt: f.datetime({ label: 'Last read', groups: { write: [] } }),
  },
});

export const calendarShutro = defineModule({
  name: 'calendar',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro, worktimeShutro],
  groups: [
    orm.defineGroup({
      code: 'calendar.user',
      label: 'Agenda user',
      implies: ['contacts.user', 'messaging.user', 'worktime.user'],
    }),
    orm.defineGroup({
      code: 'calendar.manager',
      label: 'Agenda manager',
      implies: ['calendar.user'],
    }),
  ],
  models: [CalendarRoom, CalendarEvent, CalendarAttendee, CalendarRecurrence, CalendarFeed],
});
