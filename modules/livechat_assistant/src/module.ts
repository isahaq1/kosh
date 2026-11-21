/**
 * The data layer of the assistant in Live chat (RFC 0034 §2.6): a channel may be answered first by the AI
 * assistant, from the published pages of one site; it hands the conversation over to a person when the pages do
 * not answer, when the visitor asks for one, or after so many answers. What the visitor reads is marked as the
 * assistant's.
 *
 * The model is called between two transactions, never inside one: what it needs is read here (`chatContext`),
 * and what it answered is written here (`writeAnswer`).
 */
import { handOver, livechatShutro, sayAsAssistant } from '@kosh/livechat';
import { type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { websiteShutro } from '@kosh/website';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';
import { type ChatLine, handoverText, type PageText } from './prompt.js';

/**
 * Whether the assistant may answer for a company right now (a key, switched on, budget left): asked by the
 * channel's hook below. Set by the module's routes from the assistant's service; none: it does not answer.
 */
let assistantReady: ((company: number) => Promise<boolean>) | null = null;
export function setAssistantReady(fn: ((company: number) => Promise<boolean>) | null): void {
  assistantReady = fn;
}

export const ChannelAssistant = extendModel('livechat.channel', {
  fields: {
    assistant: f.boolean({
      default: false,
      label: 'The assistant answers first',
      help: 'The AI assistant answers visitors from the published pages of the site below, and hands over to an operator when the pages do not answer or the visitor asks for a person. What visitors write goes to the AI service: it needs the assistant switched on for the company.',
    }),
    assistantSite: f.many2one('website.site', {
      ondelete: 'set null',
      label: 'Answers from the site',
      help: 'The site whose published pages are everything the assistant knows.',
    }),
    assistantName: f.char({
      size: 40,
      default: 'Assistant',
      label: 'The assistant’s name',
      help: 'What visitors read above its answers, followed by “AI”.',
    }),
    assistantAnswers: f.integer({
      required: true,
      default: 6,
      label: 'Answers before a person',
      help: 'After this many answers in one conversation, the assistant hands over to a person.',
    }),
    assistantGuidance: f.text({
      label: 'How it should speak',
      help: 'A few words on tone: formal, brief, the greeting to use. It cannot make the assistant answer beyond the pages.',
    }),
  },
  sqlConstraints: {
    assistantAnswers: {
      check: orm.sql`assistant_answers BETWEEN 1 AND 30`,
      message: 'One to thirty answers before a person.',
    },
  },
  overrides: {
    // New conversations of a channel the assistant answers are not given out at once: it hands them over.
    answeredFirst: async function (
      this: unknown,
      next: () => Promise<number[]>,
    ): Promise<number[]> {
      const channels = this as Records<'livechat.channel'>;
      const held = new Set(await next());
      if (assistantReady === null || channels.ids.length === 0) return [...held];
      for (const c of await channels.load({ company: true }))
        if (
          c.assistant === true &&
          c.assistantSite !== null &&
          (await assistantReady(c.company.id as number))
        )
          held.add(c.id as number);
      return [...held];
    },
  },
});

/** What the assistant needs to answer in a conversation. */
export interface ChatContext {
  readonly company: string;
  readonly site: string;
  readonly lang: string | null;
  readonly name: string;
  readonly guidance: string | null;
  readonly pages: readonly PageText[];
  readonly lines: readonly ChatLine[];
  /** The last message the answer is to. */
  readonly last: number;
}

/**
 * Reads what the assistant needs for a conversation — or says why it does not answer: `skip` (not its
 * conversation: no channel of its, an operator has it, it ended, the visitor's message was answered already) or
 * `handover` (it answered as often as the channel allows).
 */
export async function chatContext(
  su: Env,
  session: number,
): Promise<ChatContext | 'skip' | 'handover'> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const [s] = await all
    .model('livechat.session')
    .browse([session as never])
    .load({ channel: { assistantSite: true }, company: true, messages: true });
  if (s === undefined || s.state !== 'waiting') return 'skip';
  const channel = s.channel;
  if (channel.assistant !== true || channel.assistantSite === null) return 'skip';
  const messages = [...s.messages].sort((a, b) => (a.id as number) - (b.id as number));
  const said = messages.filter((m) => m.kind !== 'system');
  const last = said.at(-1);
  if (last === undefined || last.kind !== 'visitor') return 'skip';
  if (messages.filter((m) => m.kind === 'assistant').length >= channel.assistantAnswers)
    return 'handover';
  const site = channel.assistantSite;
  const pages = await all
    .model('website.page')
    .search({
      where: { site: site.id, state: 'published' } as never,
      order: ['sequence asc', 'path asc'],
      limit: 200,
    })
    .then((found) => found.load({ blocks: true }));
  return {
    company: s.company.name,
    site: site.name,
    lang: s.lang ?? null,
    name: `${(channel.assistantName ?? '').trim() || 'Assistant'} · AI`,
    guidance: channel.assistantGuidance ?? null,
    pages: [...pages].map((p) => ({
      path: p.path,
      lang: p.lang,
      title: p.title,
      description: p.description ?? null,
      blocks: [...p.blocks]
        .sort((a, b) => a.sequence - b.sequence || (a.id as number) - (b.id as number))
        .map((b) => ({ title: b.title ?? null, body: b.body ?? null })),
    })),
    lines: said.map((m) => ({ kind: m.kind, body: m.body })),
    last: last.id as number,
  };
}

/**
 * Writes what the assistant answered — if the conversation still waits: an operator who took it meanwhile
 * answers instead. `handover`: the conversation goes to a person, by the channel's way of giving them out.
 */
export async function writeAnswer(
  su: Env,
  session: number,
  said: { readonly name: string; readonly answer: string; readonly handover: boolean },
): Promise<'answered' | 'handed' | 'dropped'> {
  const message = await sayAsAssistant(su, session, {
    author: said.name,
    body: said.answer,
    answered: !said.handover,
  });
  if (message === null) return 'dropped';
  if (!said.handover) return 'answered';
  await handOver(su, session);
  return 'handed';
}

/** The assistant gives the conversation to a person without an answer of its own, and says so once. */
export async function giveToPerson(su: Env, session: number, say: boolean): Promise<void> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const [s] = await all
    .model('livechat.session')
    .browse([session as never])
    .load({ channel: true, messages: true });
  if (s === undefined || s.state !== 'waiting') return;
  const text = handoverText(s.lang ?? null);
  if (say && ![...s.messages].some((m) => m.kind === 'assistant' && m.body === text))
    await sayAsAssistant(su, session, {
      author: `${(s.channel.assistantName ?? '').trim() || 'Assistant'} · AI`,
      body: text,
      answered: false,
    });
  await handOver(su, session);
}

// Named so the module's type stays short enough to emit (TS7056) with every model its dependencies carry.
const DEPENDS: readonly ModuleBase[] = [livechatShutro, websiteShutro];
const MODELS = [] as const;
const EXTENSIONS = [ChannelAssistant] as const;

export const livechatAssistantShutro: Module<
  typeof MODELS,
  readonly ModuleBase[],
  typeof EXTENSIONS
> = defineModule({
  name: 'livechat_assistant',
  version: '0.1.0',
  depends: DEPENDS,
  groups: [
    orm.defineGroup({
      code: 'livechat_assistant.user',
      label: 'The assistant in Live chat',
      implies: ['livechat.user'],
    }),
  ],
  models: MODELS,
  extensions: EXTENSIONS,
});
