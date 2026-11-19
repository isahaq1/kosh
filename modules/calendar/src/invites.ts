/**
 * Agenda's invitations and feeds (RFC 0034 §2.4):
 *
 * - **Send invitations** on an event emails each attendee — people of the company and contacts from outside — an
 *   invitation with an `.ics` their mail client and calendar read (`METHOD:REQUEST`). Sent again after a change, it
 *   carries a higher sequence, so the client updates the event instead of adding a second one. **Cancelling** an
 *   event that was sent emails the cancellation (`METHOD:CANCEL`) to those who were invited.
 *   Through the outbox: after the commit, once per press; a failed send is logged, not retried into duplicates.
 * - **A calendar address** (`calendar.feed`): `GET /api/v1/agenda/feed/<secret>.ics`, public, returns its owner's
 *   events — organized or attended and not declined, from 30 days back to 400 days ahead — for another calendar to
 *   subscribe to. The secret is the access: no sign-in, read only, the owner's events only.
 *
 * Answers typed in a mail client go to the organizer's mailbox, not here: people of the company answer in Agenda.
 */
import { layout, type Mailer } from '@kosh/mail';
import type { ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import { dateIn, scheduleOf } from '@kosh/worktime';
import type { FastifyRequest } from 'fastify';
import type { Env } from './.kosh/bindings.js';
import { type IcsAttendee, type IcsEvent, type IcsMethod, toIcs } from './ics.js';

export const INVITED = 'calendar.event.invited';
export const CANCELLED = 'calendar.event.cancelled';
const DAY = 86_400_000;

const TEXTS = {
  en: {
    invite: (title: string) => `Invitation: ${title}`,
    update: (title: string) => `Updated invitation: ${title}`,
    cancel: (title: string) => `Cancelled: ${title}`,
    invited: (organizer: string, title: string) => `${organizer} invites you to ${title}.`,
    cancelled: (organizer: string, title: string) => `${organizer} cancelled ${title}.`,
    when: (when: string) => `When: ${when}`,
    where: (where: string) => `Where: ${where}`,
    video: (url: string) => `Video call: ${url}`,
    hint: 'Open the attached invitation to add it to your calendar.',
  },
  bn: {
    invite: (title: string) => `আমন্ত্রণ: ${title}`,
    update: (title: string) => `হালনাগাদ আমন্ত্রণ: ${title}`,
    cancel: (title: string) => `বাতিল: ${title}`,
    invited: (organizer: string, title: string) => `${organizer} আপনাকে ${title}-এ আমন্ত্রণ জানিয়েছেন।`,
    cancelled: (organizer: string, title: string) => `${organizer} ${title} বাতিল করেছেন।`,
    when: (when: string) => `কখন: ${when}`,
    where: (where: string) => `কোথায়: ${where}`,
    video: (url: string) => `ভিডিও কল: ${url}`,
    hint: 'সংযুক্ত আমন্ত্রণটি খুলে আপনার ক্যালেন্ডারে যোগ করুন।',
  },
} as const;

/** The address in `Name <a@b>` or a bare address; null when there is none. */
const addressOf = (value: unknown): string | null => {
  const found = /[^\s<>"]+@[^\s<>"]+/.exec(String(value ?? ''));
  return found === null ? null : found[0];
};
/** The host events are identified by: stable for the installation. */
const host = (): string => {
  try {
    return new URL(process.env['KOSH_BASE_URL'] ?? 'http://localhost').hostname;
  } catch {
    return 'localhost';
  }
};
/** The id a client knows an event by, for its whole life. */
export const eventUid = (id: number): string => `event-${id}@${host()}`;

interface Loaded {
  readonly ics: IcsEvent;
  readonly recipients: readonly {
    readonly attendee: number;
    readonly email: string;
    readonly lang: string;
    readonly invited: boolean;
  }[];
  readonly organizerName: string;
  readonly when: string;
}

/** An event with its people as the invitation says them, read as the system. */
async function loadEvent(su: Env, id: number, fallbackFrom: string): Promise<Loaded | null> {
  const [e] = await su
    .model('calendar.event')
    .browse([id as never])
    .load({ organizer: true, room: true, attendees: { user: true, partner: true } });
  if (e === undefined) return null;
  const day = e.start.toISOString().slice(0, 10);
  const { tz } = await scheduleOf(su as never, { from: day, to: day });
  const organizerEmail =
    addressOf(e.organizer.email) ?? addressOf(e.organizer.login) ?? addressOf(fallbackFrom);
  const attendees: IcsAttendee[] = [];
  const recipients: Loaded['recipients'][number][] = [];
  for (const a of e.attendees) {
    const email =
      a.user !== null
        ? (addressOf(a.user.email) ?? addressOf(a.user.login))
        : addressOf(a.partner?.email);
    if (email === null) continue;
    attendees.push({ email, name: a.user?.name ?? a.partner?.name ?? null, response: a.response });
    // The organizer has it already: they are not written to about their own meeting.
    if (a.user?.id === e.organizer.id) continue;
    recipients.push({
      attendee: a.id as number,
      email,
      lang: String(a.user?.lang ?? 'en').slice(0, 2),
      invited: a.invitedAt !== null,
    });
  }
  const local = (at: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(at);
  return {
    ics: {
      uid: eventUid(e.id as number),
      start: e.start,
      stop: e.stop,
      allDay: e.allDay
        ? { startDate: dateIn(e.start, tz), stopDate: dateIn(new Date(e.stop.getTime() - 1), tz) }
        : null,
      title: e.name,
      description: e.description,
      location: [e.room?.name, e.location].filter((x) => x != null && x !== '').join(', ') || null,
      url: e.videoUrl,
      cancelled: e.state === 'cancelled',
      sequence: e.inviteSequence ?? 0,
      organizer: organizerEmail === null ? null : { email: organizerEmail, name: e.organizer.name },
      attendees,
      updatedAt: e.updatedAt ?? null,
    },
    recipients,
    organizerName: e.organizer.name,
    when: e.allDay
      ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full' }).format(e.start)
      : `${local(e.start)} – ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeStyle: 'short' }).format(e.stop)} (${tz})`,
  };
}

/** The workers that email invitations and cancellations; `start()` them (the module does), tests `drain()` them. */
export function agendaMailers(
  context: Pick<ModuleContext, 'shutro'> & {
    readonly log?: (message: string, error: unknown) => void;
  },
  mailer: Mailer | undefined,
): Worker[] {
  const deliver = (
    env: Env,
    loaded: Loaded,
    method: IcsMethod,
    to: readonly Loaded['recipients'][number][],
    update: boolean,
  ) => {
    if (mailer === undefined || to.length === 0) return;
    const content = new TextEncoder().encode(toIcs([loaded.ics], { method }));
    const mails = to.map((r) => {
      const t = r.lang === 'bn' ? TEXTS.bn : TEXTS.en;
      const title = loaded.ics.title;
      const subject =
        method === 'CANCEL' ? t.cancel(title) : update ? t.update(title) : t.invite(title);
      return {
        to: r.email,
        subject,
        ...layout({
          title: subject,
          paragraphs: [
            method === 'CANCEL'
              ? t.cancelled(loaded.organizerName, title)
              : t.invited(loaded.organizerName, title),
            t.when(loaded.when),
            ...(loaded.ics.location ? [t.where(loaded.ics.location)] : []),
            ...(loaded.ics.url && method !== 'CANCEL' ? [t.video(loaded.ics.url)] : []),
            ...(method === 'CANCEL' ? [] : [t.hint]),
          ],
          lang: r.lang === 'bn' ? 'bn' : 'en',
        }),
        ...(loaded.ics.organizer == null ? {} : { replyTo: loaded.ics.organizer.email }),
        attachments: [
          {
            filename: method === 'CANCEL' ? 'cancelled.ics' : 'invite.ics',
            content,
            contentType: `text/calendar; method=${method}; charset=UTF-8`,
          },
        ],
      };
    });
    env.afterCommit(async () => {
      for (const mail of mails)
        await mailer
          .send(mail)
          .catch((error: unknown) => context.log?.('agenda invitation not sent', error));
    });
  };
  const idOf = (event: { payload?: unknown }): number =>
    Number((event.payload as { id?: unknown } | null)?.id);

  return [
    context.shutro.subscribe(
      'agenda.invitations',
      INVITED,
      async (event, raw) => {
        const id = idOf(event);
        if (!Number.isInteger(id)) return;
        await (raw as unknown as Env).asSuperuser({ reason: 'agenda invitations' }, async (su) => {
          const before = await loadEvent(su, id, mailer?.from ?? '');
          if (before === null || before.ics.cancelled === true) return;
          // A new version of the event for the clients: the first is 0, each sending after it one more.
          const again = before.recipients.some((r) => r.invited);
          const sequence = (before.ics.sequence ?? 0) + (again ? 1 : 0);
          const now = new Date();
          await su
            .model('calendar.event')
            .browse([id as never])
            .write({ inviteSequence: sequence, invitedAt: now } as never);
          if (before.recipients.length > 0)
            await su
              .model('calendar.attendee')
              .browse(before.recipients.map((r) => r.attendee) as never)
              .write({ invitedAt: now } as never);
          deliver(
            su,
            { ...before, ics: { ...before.ics, sequence } },
            'REQUEST',
            before.recipients,
            again,
          );
        });
      },
      { pollMs: 5000 },
    ),
    context.shutro.subscribe(
      'agenda.cancellations',
      CANCELLED,
      async (event, raw) => {
        const id = idOf(event);
        if (!Number.isInteger(id)) return;
        await (raw as unknown as Env).asSuperuser(
          { reason: 'agenda cancellations' },
          async (su) => {
            const loaded = await loadEvent(su, id, mailer?.from ?? '');
            if (loaded === null) return;
            // Only those who were told of it are told it is off.
            const told = loaded.recipients.filter((r) => r.invited);
            if (told.length === 0) return;
            const sequence = (loaded.ics.sequence ?? 0) + 1;
            await su
              .model('calendar.event')
              .browse([id as never])
              .write({ inviteSequence: sequence } as never);
            deliver(su, { ...loaded, ics: { ...loaded.ics, sequence } }, 'CANCEL', told, false);
          },
        );
      },
      { pollMs: 5000 },
    ),
  ];
}

/** The public route of calendar addresses. */
export function registerFeedRoute({ app, shutro }: ModuleContext): void {
  app.get(
    '/api/v1/agenda/feed/:file',
    {
      config: {
        auth: false,
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => `agenda-feed:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      const file = String((request.params as { file?: unknown }).file ?? '');
      const token = /^([A-Za-z0-9_-]{16,64})\.ics$/.exec(file)?.[1];
      const body =
        token === undefined
          ? null
          : await shutro.bootstrap({ reason: 'agenda feed' }, async (raw) => {
              const su = raw as unknown as Env;
              const found = await su.model('calendar.feed').search({ where: { token }, limit: 1 });
              const [feed] = await found.load({ user: true });
              if (feed === undefined || feed.user.active === false) return null;
              const user = feed.user.id;
              const from = new Date(Date.now() - 30 * DAY);
              const to = new Date(Date.now() + 400 * DAY);
              const attended = await (
                await su
                  .model('calendar.attendee')
                  .search({ where: { user, response: { ne: 'declined' } } })
              ).load(['event']);
              const events = await su.model('calendar.event').search({
                where: {
                  start: { lt: to },
                  stop: { gt: from },
                  or: [{ organizer: user }, { id: { in: [...attended].map((a) => a.event.id) } }],
                },
                order: ['start asc'],
                limit: 2000,
              });
              const out: IcsEvent[] = [];
              for (const id of events.ids) {
                const loaded = await loadEvent(su, id as number, '');
                if (loaded !== null) out.push(loaded.ics);
              }
              await found.write({ lastReadAt: new Date() } as never);
              await su.flush();
              return toIcs(out, { method: 'PUBLISH', name: `${feed.user.name} — Agenda` });
            });
      // One answer for a wrong, closed or malformed address.
      if (body === null) return reply.code(404).type('text/plain').send('Not found');
      return reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('cache-control', 'private, max-age=300')
        .send(body);
    },
  );
}
