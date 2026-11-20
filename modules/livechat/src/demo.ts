/**
 * Live chat's demo data (RFC 0008 §5.8): a channel for the website answered by Dina and Rahim, and three
 * conversations — one answered and rated, one that waits, one that was missed with the visitor's email — so the
 * inbox, the list and the overview have something to show.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import {
  endSession,
  say,
  setPresence,
  startSession,
  sweepSessions,
  takeSession,
} from './module.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['livechat.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['livechat.user'] } as const;

export async function livechatDemo(ctx: DemoContext): Promise<string> {
  const rahim = await ctx.as(RAHIM, async (raw) => (raw as Env).userId as number);
  return ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const dina = env.userId as number;
    const made = await env.model('livechat.channel').create([
      {
        name: 'Chat with us',
        operators: { set: [dina, rahim] },
        // The demo gives nothing out by itself: the conversations below are placed by hand.
        assignment: 'manual',
      } as never,
    ]);
    await env.flush();
    const [channel] = await made.load(['key']);
    if (channel === undefined) return 'Live chat: nothing made';
    await env.asSuperuser({ reason: 'live chat demo data' }, async (su) => {
      const hour = 3_600_000;
      const now = Date.now();
      // Two hours ago Dina was there: a question answered in forty seconds, and rated.
      await setPresence(su, dina, true, now - 2 * hour);
      const first = await startSession(
        su,
        channel.key,
        { name: 'Rina Akter', message: 'Do you deliver to Gazipur?', page: '/delivery' },
        now - 2 * hour,
      );
      if (first.ok) {
        await takeSession(su, first.session, dina, now - 2 * hour + 15_000);
        await say(
          su,
          first.session,
          { user: dina, name: DINA.name },
          'Yes — within two working days, for 120 taka.',
          now - 2 * hour + 40_000,
        );
        await say(su, first.session, {}, 'Thank you!', now - 2 * hour + 70_000);
        await endSession(su, first.session, { rating: 5 }, now - 2 * hour + 90_000);
      }
      // Yesterday evening nobody was there: the visitor left an email, and the conversation was missed.
      await setPresence(su, dina, false, now - 20 * hour);
      const missed = await startSession(
        su,
        channel.key,
        {
          name: 'Karim Hossain',
          email: 'karim@example.com',
          message: 'I would like a quotation for 200 cartons.',
        },
        now - 20 * hour,
      );
      if (missed.ok) await sweepSessions(su, now - 19 * hour);
      // Just now: one that waits for somebody to take it.
      await setPresence(su, dina, true, now);
      await startSession(
        su,
        channel.key,
        { name: 'Salma', message: 'Is the blue one in stock?', page: '/products' },
        now,
      );
    });
    return 'Live chat: a channel with two operators, three conversations';
  });
}
