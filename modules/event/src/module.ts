/**
 * The data layer of Event Hub (RFC 0021): events with their sessions and ticket types, seats limited per event and
 * per ticket, registrations confirmed while seats remain — else on a waiting list, promoted in order when a seat
 * frees — and checked in once by their code (the QR on the ticket).
 */
import { randomBytes } from 'node:crypto';
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { type Id, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  records,
} from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const HOLDS = ['confirmed', 'attended'] as const;

/** A registration's code: what its QR carries (unguessable, short enough to type). */
export const newCode = (): string => randomBytes(6).toString('hex').toUpperCase();

export const EventEvent = defineModel('event.event', {
  label: 'Event',
  recName: 'name',
  order: ['dateBegin desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'dateBegin', 'seatsMax'],
  access: {
    'event.user': ['read', 'write', 'create'],
    'event.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true }),
    dateBegin: f.datetime({ required: true, label: 'Starts' }),
    dateEnd: f.datetime({ required: true, label: 'Ends' }),
    venue: f.char(),
    organizer: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      ondelete: 'set null',
      label: 'Organiser',
    }),
    /** 0: no limit. */
    seatsMax: f.integer({ required: true, default: 0, label: 'Seats (0: no limit)' }),
    waitingList: f.boolean({ default: true, label: 'Waiting list when full' }),
    currency: f.many2one('res.currency', { ondelete: 'restrict' }),
    tickets: f.one2many('event.ticket', 'event', { label: 'Tickets' }),
    sessions: f.one2many('event.session', 'event'),
    registrations: f.one2many('event.registration', 'event'),
    seatsTaken: f.integer({
      store: true,
      label: 'Seats taken',
      ...compute('event.event', 'seatsTaken', ['registrations.state'], (events) => {
        for (const e of events)
          e.seatsTaken = [...e.registrations].filter((r) =>
            (HOLDS as readonly string[]).includes(r.state),
          ).length;
      }),
    }),
    seatsAvailable: f.integer({
      store: true,
      label: 'Seats left',
      ...compute('event.event', 'seatsAvailable', ['seatsMax', 'seatsTaken'], (events) => {
        for (const e of events)
          e.seatsAvailable = e.seatsMax > 0 ? Math.max(0, e.seatsMax - (e.seatsTaken ?? 0)) : null;
      }),
    }),
    attended: f.integer({
      store: true,
      label: 'Checked in',
      ...compute('event.event', 'attended', ['registrations.state'], (events) => {
        for (const e of events)
          e.attended = [...e.registrations].filter((r) => r.state === 'attended').length;
      }),
    }),
    description: f.text(),
    state: f.state({
      states: {
        draft: 'Draft',
        published: 'Open for registration',
        done: 'Ended',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        publish: { from: ['draft'], to: 'published' },
        close: {
          from: ['published'],
          to: 'done',
          // Those who came are thanked (the outbox: Event Hub's emails).
          after: records('event.event', async (events): Promise<void> => {
            for (const id of events.ids) await events.env.emit('event.event.ended', { id });
          }),
        },
        cancel: { from: ['draft', 'published'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
  sqlConstraints: {
    seats: { check: orm.sql`seats_max >= 0`, message: 'Seats are a number, 0 for no limit.' },
    dates: { check: orm.sql`date_end >= date_begin`, message: 'An event ends after it starts.' },
  },
});

export const EventTicket = defineModel('event.ticket', {
  label: 'Ticket type',
  recName: 'name',
  order: ['id asc'],
  access: { 'event.user': ['read'], 'event.manager': ALL },
  fields: {
    event: f.many2one('event.event', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    price: f.decimal({ scale: 2, required: true, default: '0' }),
    /** 0: no limit of its own. */
    seatsMax: f.integer({ required: true, default: 0, label: 'Seats (0: no limit)' }),
    /** The last day it is sold (empty: until the event). */
    saleEnd: f.date({ label: 'Sold until' }),
    registrations: f.one2many('event.registration', 'ticket'),
    seatsTaken: f.integer({
      store: true,
      label: 'Sold',
      ...compute('event.ticket', 'seatsTaken', ['registrations.state'], (tickets) => {
        for (const t of tickets)
          t.seatsTaken = [...t.registrations].filter((r) =>
            (HOLDS as readonly string[]).includes(r.state),
          ).length;
      }),
    }),
  },
  sqlConstraints: {
    sensible: {
      check: orm.sql`price >= 0 AND seats_max >= 0`,
      message: 'A ticket has a price and seats that are not negative.',
    },
  },
});

export const EventSession = defineModel('event.session', {
  label: 'Session',
  recName: 'name',
  order: ['dateBegin asc', 'id asc'],
  access: { 'event.user': ['read'], 'event.manager': ALL },
  fields: {
    event: f.many2one('event.event', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    dateBegin: f.datetime({ required: true, label: 'Starts' }),
    dateEnd: f.datetime({ required: true, label: 'Ends' }),
    room: f.char(),
    speaker: f.char(),
  },
  constraints: {
    // A session happens during its event, and ends after it starts.
    withinTheEvent: {
      ...check('event.session', ['dateBegin', 'dateEnd', 'event'], async (sessions) =>
        (await sessions.load({ event: true }))
          .filter(
            (s) =>
              s.dateEnd < s.dateBegin ||
              s.dateBegin < s.event.dateBegin ||
              s.dateEnd > s.event.dateEnd,
          )
          .map((s) => s.id),
      ),
      message: 'A session happens during its event.',
    },
  },
});

/** Whether `registration` would find a seat (its event's and its ticket's), not counting itself. */
async function seatFor(
  env: Env,
  registration: {
    id: Id<'event.registration'>;
    event: Id<'event.event'>;
    ticket: Id<'event.ticket'> | null;
  },
): Promise<boolean> {
  return env.asSuperuser({ reason: 'event seats' }, async (su) => {
    const [event] = await su.model('event.event').browse([registration.event]).load({});
    if (event === undefined) return false;
    const holding = async (where: Record<string, unknown>) =>
      (
        await su.model('event.registration').search({
          where: { ...where, state: { in: [...HOLDS] }, id: { ne: registration.id } },
        })
      ).length;
    if (event.seatsMax > 0 && (await holding({ event: registration.event })) >= event.seatsMax)
      return false;
    if (registration.ticket !== null) {
      const [ticket] = await su.model('event.ticket').browse([registration.ticket]).load({});
      if (
        ticket !== undefined &&
        ticket.seatsMax > 0 &&
        (await holding({ ticket: registration.ticket })) >= ticket.seatsMax
      )
        return false;
    }
    return true;
  });
}

/** What follows a confirmed place: other apps' hook, and the confirmation email (through the outbox). */
async function placeConfirmed(env: Env, ids: readonly Id<'event.registration'>[]): Promise<void> {
  await env.model('event.registration').browse(ids).confirmed();
  for (const id of ids) await env.emit('event.registration.confirmed', { id });
}

/** Promotes the first waiting registrations of these events while seats are free (in the order they came). */
async function promoteWaiting(env: Env, events: readonly Id<'event.event'>[]): Promise<void> {
  await env.asSuperuser({ reason: 'event waiting list' }, async (su) => {
    for (const event of events) {
      const waiting = await (
        await su.model('event.registration').search({
          where: { event, state: 'waiting' },
          order: ['id asc'],
        })
      ).load({});
      for (const r of waiting) {
        if (!(await seatFor(su, { id: r.id, event, ticket: r.ticket?.id ?? null }))) continue;
        await su.model('event.registration').browse([r.id]).promote();
      }
    }
  });
}

export const EventRegistration = defineModel('event.registration', {
  label: 'Registration',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state'],
  access: {
    'event.user': ['read', 'write', 'create'],
    'event.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    event: f.many2one('event.event', { required: true, ondelete: 'cascade' }),
    ticket: f.many2one('event.ticket', { ondelete: 'restrict' }),
    name: f.char({ required: true, label: 'Attendee' }),
    email: f.char(),
    phone: f.char(),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Contact' }),
    /** The attendee's language, for their emails. */
    lang: f.selection(
      { en: 'English', bn: 'Bangla' },
      { required: true, default: 'en', label: 'Language' },
    ),
    /** What the attendee's QR carries; checked in once with it. */
    code: f.char({
      required: true,
      default: () => newCode(),
      index: 'unique',
      label: 'Check-in code',
    }),
    price: f.decimal({ scale: 2, default: '0' }),
    checkedInAt: f.datetime({ label: 'Checked in at' }),
    /** When the confirmation email went (once). */
    confirmationSentAt: f.datetime({ label: 'Confirmation sent' }),
    /** When the thanks went, after the event (once). */
    thanksSentAt: f.datetime({ label: 'Thanks sent' }),
    state: f.state({
      states: {
        draft: 'Draft',
        confirmed: 'Confirmed',
        waiting: 'Waiting list',
        attended: 'Checked in',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        confirm: {
          from: ['draft'],
          to: 'confirmed',
          // Only while the event takes registrations and has a seat; a full event offers its waiting list.
          guard: records('event.registration', async (registrations) => {
            const env = registrations.env as unknown as Env;
            const refused: number[] = [];
            for (const r of await registrations.load({ event: true, ticket: true })) {
              const open = r.event.state === 'published';
              const saleOver =
                r.ticket?.saleEnd != null && String(r.ticket.saleEnd) < String(env.today());
              const seat = await seatFor(env, {
                id: r.id,
                event: r.event.id,
                ticket: r.ticket?.id ?? null,
              });
              if (!open || saleOver || !seat) refused.push(r.id);
            }
            return refused;
          }),
          message:
            'No seat: the event is not open for registration, the ticket is no longer sold, or it is full (use the waiting list).',
          after: records('event.registration', async (registrations): Promise<void> => {
            for (const r of await registrations.load({ ticket: true }))
              if (r.ticket !== null) await r.write({ price: r.ticket.price } as never);
            await placeConfirmed(registrations.env as unknown as Env, registrations.ids);
          }),
        },
        wait: {
          from: ['draft'],
          to: 'waiting',
          guard: records('event.registration', async (registrations) =>
            (await registrations.load({ event: true })).filter(
              (r) => !r.event.waitingList || r.event.state !== 'published',
            ),
          ),
          message: 'This event has no waiting list, or does not take registrations.',
        },
        /** A seat freed: the first waiting takes it. */
        promote: {
          from: ['waiting'],
          to: 'confirmed',
          after: records('event.registration', async (registrations): Promise<void> => {
            for (const r of await registrations.load({ ticket: true }))
              if (r.ticket !== null) await r.write({ price: r.ticket.price } as never);
            await placeConfirmed(registrations.env as unknown as Env, registrations.ids);
          }),
        },
        attend: {
          from: ['confirmed'],
          to: 'attended',
          after: records('event.registration', async (registrations): Promise<void> => {
            await registrations.write({ checkedInAt: new Date() } as never);
          }),
        },
        cancel: {
          from: ['draft', 'confirmed', 'waiting'],
          to: 'cancel',
          // A confirmed seat freed goes to the waiting list, in order.
          after: records('event.registration', async (registrations): Promise<void> => {
            const env = registrations.env as unknown as Env;
            const events = [...new Set([...(await registrations.load({})).map((r) => r.event.id)])];
            await promoteWaiting(env, events);
          }),
        },
      },
    }),
  },
  methods: {
    /** Runs once these registrations hold a confirmed place. Nothing here; `event_account` invoices them. */
    confirmed: method('event.registration', async (): Promise<void> => undefined),
  },
  constraints: {
    ticketOfTheEvent: {
      ...check('event.registration', ['ticket', 'event'], async (registrations) =>
        (await registrations.load({ ticket: true }))
          .filter((r) => r.ticket !== null && r.ticket.event.id !== r.event.id)
          .map((r) => r.id),
      ),
      message: 'The ticket is for another event.',
    },
  },
});

export const eventShutro = defineModule({
  name: 'event',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({ code: 'event.user', label: 'Event Hub user', implies: ['contacts.user'] }),
    orm.defineGroup({ code: 'event.manager', label: 'Event Hub manager', implies: ['event.user'] }),
  ],
  models: [EventEvent, EventTicket, EventSession, EventRegistration],
});
