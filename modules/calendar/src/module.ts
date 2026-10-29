/**
 * The data layer of Agenda (RFC 0021): events with their attendees — people of the company or contacts from outside,
 * each with their answer — rooms that are never double-booked, and privacy: public events are seen by every Agenda
 * user, private ones by their organizer and attendees only. Only the organizer (and Agenda managers) change an event;
 * an attendee changes their own answer.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { installationSetting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { check, defineModel, defineModule, type Env, f, onchange } from './.kosh/bindings.js';

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
      { required: true, default: 'public' },
    ),
    state: f.state({
      states: { confirmed: 'Confirmed', cancelled: 'Cancelled' },
      initial: 'confirmed',
      transitions: {
        cancel: { from: ['confirmed'], to: 'cancelled' },
        restore: { from: ['cancelled'], to: 'confirmed' },
      },
    }),
    description: f.text(),
    /** The record of another app it is about (`sale.order`, 42), if any. */
    resModel: f.char({ label: 'About (model)' }),
    resId: f.integer({ label: 'About (id)' }),
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
    response: f.selection(
      {
        needs_action: 'Not answered',
        accepted: 'Accepted',
        tentative: 'Maybe',
        declined: 'Declined',
      },
      { required: true, default: 'needs_action', label: 'Answer' },
    ),
  },
  sqlConstraints: {
    someone: {
      check: orm.sql`user_id IS NOT NULL OR partner_id IS NOT NULL`,
      message: 'An attendee is a person or a contact.',
    },
  },
});

export const calendarShutro = defineModule({
  name: 'calendar',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'calendar.user',
      label: 'Agenda user',
      implies: ['contacts.user', 'messaging.user'],
    }),
    orm.defineGroup({
      code: 'calendar.manager',
      label: 'Agenda manager',
      implies: ['calendar.user'],
    }),
  ],
  models: [CalendarRoom, CalendarEvent, CalendarAttendee],
});
