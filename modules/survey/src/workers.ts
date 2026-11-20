/**
 * What Surveys does by itself (RFC 0034 §2.6), through the outbox — after the commit that caused it, once:
 *
 * - an **invitation with an email address is emailed** when it is made, or when its survey opens: the survey's
 *   name and introduction, and a button to the person's own link, in English or Bangla;
 * - the **automatic invitations**: every event of an installed app, and every record made, is offered to the
 *   triggers that wait for it.
 *
 * The emails need a mailer and the server's public address (`KOSH_BASE_URL`): without either, invitations stay
 * unsent — their links are still there to copy — and are sent once both are there.
 */
import { layout, type Mailer } from '@kosh/mail';
import type { KoshModule } from '@kosh/modules-sdk';
import type { ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { fireTriggers, type TriggerCatalogue, takeToSend } from './module.js';

/** Shutro's change events: one per write, with the model, what was done and the records. */
const CHANGE_TOPIC = 'record.changed';

const TEXTS = {
  en: {
    hello: (name: string, survey: string) => `${name}, we would like to hear from you: ${survey}.`,
    once: 'The link is yours: it opens the questions once.',
    answer: 'Answer the questions',
  },
  bn: {
    hello: (name: string, survey: string) => `${name}, আমরা আপনার মতামত জানতে চাই: ${survey}।`,
    once: 'লিংকটি আপনার জন্য: এটি একবার প্রশ্নগুলো খোলে।',
    answer: 'প্রশ্নের উত্তর দিন',
  },
} as const;

/** The events a trigger may wait for: the apps' named events (not Surveys' own), and any model's creation. */
export function triggerCatalogue(registry: ModuleContext['registry']): TriggerCatalogue & {
  readonly topics: readonly { topic: string; model: string; label: string }[];
} {
  const topics = (registry.loaded.modules as readonly KoshModule[])
    .flatMap((m) => m.events ?? [])
    .filter((e) => !e.topic.startsWith('survey.'))
    .map((e) => ({ topic: e.topic, model: e.model, label: e.label }));
  const named = new Map(topics.map((e) => [e.topic, e.model]));
  const models = registry.registry.models as unknown as { has(name: string): boolean };
  return {
    topics,
    modelOf(topic) {
      const known = named.get(topic);
      if (known !== undefined) return known;
      if (!topic.endsWith('.created')) return null;
      const model = topic.slice(0, -'.created'.length);
      // Surveys does not wait for itself: an invitation about an invitation would never end.
      return !model.startsWith('survey.') && models.has(model) ? model : null;
    },
    fieldsOf(model) {
      if (!models.has(model)) return null;
      return (
        registry.registry as unknown as {
          describe(name: string): { fields: Record<string, { kind: string; target?: unknown }> };
        }
      ).describe(model).fields;
    },
  };
}

/** The workers of Surveys; `start()` them (the module does), tests `drain()` them. */
export function surveyWorkers(
  context: Pick<ModuleContext, 'shutro' | 'registry'> & {
    readonly log?: (message: string, error: unknown) => void;
  },
  options: { readonly mailer: Mailer | undefined; readonly baseUrl: string },
): Worker[] {
  const { mailer } = options;
  const base = options.baseUrl.replace(/\/+$/, '');
  /** Emails the pending invitations among these, when emails can be sent at all. */
  const send = async (
    su: Env,
    where: { readonly invitations?: readonly number[]; readonly survey?: number },
  ): Promise<void> => {
    if (mailer === undefined || base === '') return;
    const mails = (await takeToSend(su, where)).map((m) => {
      const t = TEXTS[m.lang];
      return {
        to: m.to,
        subject: m.survey,
        ...layout({
          title: m.survey,
          paragraphs: [
            t.hello(m.name, m.survey),
            ...(m.description === null ? [] : [m.description]),
            t.once,
          ],
          action: { label: t.answer, url: `${base}${m.path}` },
          lang: m.lang,
        }),
      };
    });
    if (mails.length === 0) return;
    su.afterCommit(async () => {
      for (const mail of mails)
        await mailer
          .send(mail)
          .catch((error: unknown) => context.log?.('survey invitation not sent', error));
    });
  };
  const idOf = (payload: unknown): number | null => {
    const id = Number((payload as { id?: unknown } | null)?.id);
    return Number.isInteger(id) ? id : null;
  };
  const asSystem = (env: unknown, reason: string, fn: (su: Env) => Promise<void>): Promise<void> =>
    (env as Env).asSuperuser({ reason }, fn);

  const workers: Worker[] = [
    // A survey opens: its invitations made while it was a draft go out.
    context.shutro.subscribe(
      'survey.invitations.opened',
      'survey.survey.opened',
      async (event, env) => {
        const id = idOf(event.payload);
        if (id === null) return;
        await asSystem(env, 'survey invitations emailed', (su) => send(su, { survey: id }));
      },
      { pollMs: 5000 },
    ),
    // Every record made: an invitation is emailed; any other is offered to the triggers on its creation.
    context.shutro.subscribe(
      'survey.changes',
      CHANGE_TOPIC,
      async (event, env) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (payload['action'] !== 'create') return;
        const model = String(payload['model'] ?? '');
        const ids = (Array.isArray(payload['ids']) ? payload['ids'] : []).map(Number);
        if (model === '' || ids.length === 0) return;
        await asSystem(env, 'surveys: a record was made', async (su) => {
          if (model === 'survey.invitation') return send(su, { invitations: ids });
          if (model.startsWith('survey.')) return;
          for (const id of ids) {
            const made = await fireTriggers(su, `${model}.created`, id);
            if (made.length > 0) await send(su, { invitations: made });
          }
        });
      },
      { pollMs: 5000 },
    ),
  ];
  // The apps' named events.
  for (const e of triggerCatalogue(context.registry).topics)
    workers.push(
      context.shutro.subscribe(
        `survey.triggers.${e.topic}`,
        e.topic,
        async (event, env) => {
          const id = idOf(event.payload);
          if (id === null) return;
          await asSystem(env, `surveys: ${e.topic}`, async (su) => {
            const made = await fireTriggers(su, e.topic, id);
            if (made.length > 0) await send(su, { invitations: made });
          });
        },
        { pollMs: 5000 },
      ),
    );
  return workers;
}
