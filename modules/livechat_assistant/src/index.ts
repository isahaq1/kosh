/**
 * @packageDocumentation
 * `@kosh/livechat_assistant` (RFC 0034 §2.6): the AI assistant in Live chat. Proposed whenever Live chat and
 * Sites are installed; it answers only where the assistant (RFC 0013) is installed, has a key, is switched on for
 * the company and has budget left — otherwise conversations go to the operators as before.
 *
 * - A channel says *The assistant answers first*, and from which site's published pages.
 * - The assistant answers a visitor from those pages only, marked as an AI; it hands over to a person when the
 *   pages do not answer, when the visitor asks for one, when it answered as often as the channel allows, and
 *   whenever it cannot answer at all (off, over budget, an error).
 * - Every call is logged by the assistant without its content, and counts in the company's monthly budget.
 */
import { type AssistantService, assistantService, languageName } from '@kosh/assistant';
import { livechat, setResponder } from '@kosh/livechat';
import { defineModule } from '@kosh/modules-sdk';
import type { ModuleContext } from '@kosh/server';
import { field } from '@kosh/views';
import { website } from '@kosh/website';
import type { Env } from './.kosh/bindings.js';
import {
  chatContext,
  giveToPerson,
  livechatAssistantShutro,
  setAssistantReady,
  writeAnswer,
} from './module.js';
import {
  ANSWER_SCHEMA,
  chatInstructions,
  conversationText,
  pagesText,
  readAnswer,
} from './prompt.js';

export {
  ChannelAssistant,
  type ChatContext,
  chatContext,
  giveToPerson,
  livechatAssistantShutro,
  writeAnswer,
} from './module.js';
export {
  ANSWER_SCHEMA,
  type ChatLine,
  chatInstructions,
  conversationText,
  handoverText,
  MAX_ANSWER,
  MAX_LINES,
  MAX_PAGES_TEXT,
  type PageText,
  pagesText,
  pageText,
  readAnswer,
} from './prompt.js';

/** At most this many answers are being written at once on a server; a visitor beyond that gets a person. */
export const MAX_AT_ONCE = 4;

/**
 * What answers a visitor first: reads the conversation and the site's pages, asks the assistant — with no
 * transaction open —, writes the answer if the conversation still waits. Whatever goes wrong, the conversation
 * goes to a person. One answer at a time per conversation; a message that came meanwhile is answered next.
 */
export function assistantResponder(
  context: Pick<ModuleContext, 'shutro'>,
  service: AssistantService,
): (session: number, company: number) => Promise<void> {
  const { shutro } = context;
  const busy = new Map<number, { again: boolean }>();
  const inScope = <T>(reason: string, company: number, fn: (env: Env) => Promise<T>): Promise<T> =>
    shutro.bootstrap({ reason, company }, (env) => fn(env as unknown as Env));
  const once = async (session: number, company: number): Promise<void> => {
    const read = await inScope('a chat read for the assistant', company, (env) =>
      chatContext(env, session),
    );
    if (read === 'skip') return;
    const toPerson = (say: boolean): Promise<void> =>
      inScope('a chat handed over by the assistant', company, (env) =>
        giveToPerson(env, session, say),
      );
    if (read === 'handover') return toPerson(true);
    const result = await service.json(
      { company, feature: 'livechat', resModel: 'livechat.session' },
      {
        system: chatInstructions({
          company: read.company,
          site: read.site,
          pages: pagesText(read.pages, read.lang).text,
          guidance: read.guidance,
        }),
        user: conversationText(read.lines, languageName(read.lang)),
        schema: ANSWER_SCHEMA,
        effort: 'low',
        maxTokens: 700,
      },
    );
    const answer = result.ok ? readAnswer(result.data) : null;
    // Off, over budget, refused, an error, not an answer: a person, and the visitor is told one comes.
    if (answer === null) return toPerson(true);
    await inScope('a chat answered by the assistant', company, (env) =>
      writeAnswer(env, session, { name: read.name, ...answer }),
    );
  };
  return async (session, company) => {
    const running = busy.get(session);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    if (busy.size >= MAX_AT_ONCE) {
      await inScope('a chat handed over: the assistant is busy', company, (env) =>
        giveToPerson(env, session, false),
      );
      return;
    }
    const mine = { again: false };
    busy.set(session, mine);
    try {
      // The visitor wrote again while it answered: once more, for what they wrote since.
      for (let round = 0; round < 3; round += 1) {
        mine.again = false;
        await once(session, company);
        if (!mine.again) break;
      }
    } catch (error) {
      await inScope('a chat handed over: the assistant failed', company, (env) =>
        giveToPerson(env, session, false),
      ).catch(() => undefined);
      throw error;
    } finally {
      busy.delete(session);
    }
  };
}

export const livechatAssistant: ReturnType<typeof defineModule> = defineModule({
  shutro: livechatAssistantShutro,
  kosh: '^0.1.0',
  depends: [livechat, website],
  bridge: [livechat, website],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'The assistant in Live chat', groups: ['livechat_assistant.user'] },
  },
  viewExtensions: [
    {
      view: 'livechat.channel.form',
      operations: [
        {
          append: 'texts',
          nodes: [
            field({ field: 'assistant', id: 'channel_assistant' }),
            field({ field: 'assistantSite', id: 'channel_assistant_site' }),
            field({ field: 'assistantName', id: 'channel_assistant_name' }),
            field({ field: 'assistantAnswers', id: 'channel_assistant_answers' }),
            field({ field: 'assistantGuidance', id: 'channel_assistant_guidance' }),
          ],
        },
      ],
    },
  ],
  routes: (context: ModuleContext) => {
    // The assistant is looked for when it is needed: its module may register after this one.
    let responder: ((session: number, company: number) => Promise<void>) | null = null;
    const service = (): AssistantService | null => assistantService(context);
    setAssistantReady(async (company) => (await service()?.ready(company)) === 'ok');
    setResponder(context, async (session, company) => {
      const found = service();
      if (found === null) return;
      responder ??= assistantResponder(context, found);
      await responder(session, company);
    });
    context.app.addHook('onClose', async () => {
      setResponder(context, null);
      setAssistantReady(null);
    });
  },
});
