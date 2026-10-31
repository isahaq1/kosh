/**
 * Event Hub's emails (RFC 0021, Event Hub step 3): the confirmation to an attendee whose place is confirmed (also
 * when the waiting list moves them up), with their ticket and check-in code, and the thanks to those who came, once
 * the event ends. Through the outbox — each sent once (its time is kept on the registration), after the commit; a
 * failed send is logged. In the attendee's language (English or Bangla, on the registration).
 */
import { layout, type Mailer } from '@kosh/mail';
import type { ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

export const CONFIRMED = 'event.registration.confirmed';
export const ENDED = 'event.event.ended';

const TEXTS = {
  en: {
    confirmedSubject: (event: string) => `Your place at ${event} is confirmed`,
    confirmed: (name: string, event: string, when: string, venue: string) =>
      `${name}, your registration for ${event} on ${when}${venue === '' ? '' : ` at ${venue}`} is confirmed.`,
    ticket: (ticket: string) => `Ticket: ${ticket}.`,
    code: (code: string) =>
      `Your check-in code is ${code}: show it, or your printed ticket, at the door.`,
    thanksSubject: (event: string) => `Thank you for coming to ${event}`,
    thanks: (name: string, event: string) =>
      `${name}, thank you for coming to ${event}. We hope to see you at the next one.`,
  },
  bn: {
    confirmedSubject: (event: string) => `${event}-এ আপনার আসন নিশ্চিত হয়েছে`,
    confirmed: (name: string, event: string, when: string, venue: string) =>
      `${name}, ${when}${venue === '' ? '' : `, ${venue}`}-এ ${event}-এর জন্য আপনার নিবন্ধন নিশ্চিত হয়েছে।`,
    ticket: (ticket: string) => `টিকিট: ${ticket}।`,
    code: (code: string) => `আপনার চেক-ইন কোড ${code}: দরজায় এটি বা আপনার ছাপানো টিকিট দেখান।`,
    thanksSubject: (event: string) => `${event}-এ আসার জন্য ধন্যবাদ`,
    thanks: (name: string, event: string) =>
      `${name}, ${event}-এ আসার জন্য ধন্যবাদ। পরের আয়োজনে আবার দেখা হবে আশা করি।`,
  },
} as const;

type Mail = { to: string; subject: string; html: string; text: string };

/** The workers that send Event Hub's emails; `start()` them (the module does), tests `drain()` them. */
export function eventMailers(
  context: Pick<ModuleContext, 'shutro'> & {
    readonly log?: (message: string, error: unknown) => void;
  },
  mailer: Mailer | undefined,
): Worker[] {
  const send = (env: Env, mails: readonly Mail[]) => {
    if (mailer === undefined || mails.length === 0) return;
    env.afterCommit(async () => {
      for (const mail of mails)
        await mailer
          .send(mail)
          .catch((error: unknown) => context.log?.('event email not sent', error));
    });
  };
  const textsOf = (lang: unknown) => (String(lang ?? '').startsWith('bn') ? TEXTS.bn : TEXTS.en);
  return [
    context.shutro.subscribe(
      'event.confirmations',
      CONFIRMED,
      async (event, raw) => {
        const env = raw as unknown as Env;
        const id = Number((event.payload as { id?: unknown } | null)?.id);
        if (!Number.isInteger(id)) return;
        await env.asSuperuser({ reason: 'event confirmation email' }, async (su) => {
          const [r] = await su
            .model('event.registration')
            .browse([id as never])
            .load({ event: true, ticket: true, partner: true });
          if (r === undefined || r.state !== 'confirmed' || r.confirmationSentAt !== null) return;
          const to = r.email ?? r.partner?.email ?? null;
          await su
            .model('event.registration')
            .browse([r.id])
            .write({ confirmationSentAt: new Date() });
          if (to === null || to === '') return;
          const t = textsOf(r.lang);
          const when = r.event.dateBegin.toISOString().slice(0, 16).replace('T', ' ');
          const subject = t.confirmedSubject(r.event.name);
          send(su, [
            {
              to,
              subject,
              ...layout({
                title: subject,
                paragraphs: [
                  t.confirmed(r.name, r.event.name, when, r.event.venue ?? ''),
                  ...(r.ticket === null ? [] : [t.ticket(r.ticket.name)]),
                  t.code(r.code),
                ],
                lang: String(r.lang ?? 'en').slice(0, 2),
              }),
            },
          ]);
        });
      },
      { pollMs: 5000 },
    ),
    context.shutro.subscribe(
      'event.thanks',
      ENDED,
      async (event, raw) => {
        const env = raw as unknown as Env;
        const id = Number((event.payload as { id?: unknown } | null)?.id);
        if (!Number.isInteger(id)) return;
        await env.asSuperuser({ reason: 'event thanks email' }, async (su) => {
          const came = await (
            await su.model('event.registration').search({
              where: { event: id as never, state: 'attended', thanksSentAt: { isNull: true } },
            })
          ).load({ event: true, partner: true });
          const mails: Mail[] = [];
          for (const r of came) {
            await su.model('event.registration').browse([r.id]).write({ thanksSentAt: new Date() });
            const to = r.email ?? r.partner?.email ?? null;
            if (to === null || to === '') continue;
            const t = textsOf(r.lang);
            const subject = t.thanksSubject(r.event.name);
            mails.push({
              to,
              subject,
              ...layout({
                title: subject,
                paragraphs: [t.thanks(r.name, r.event.name)],
                lang: String(r.lang ?? 'en').slice(0, 2),
              }),
            });
          }
          send(su, mails);
        });
      },
      { pollMs: 5000 },
    ),
  ];
}
