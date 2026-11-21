/**
 * The data layer of the Live chat ↔ Pipeline bridge (RFC 0034 §2.6): a conversation that ended may become
 * a deal — by the channel's routing rules, or when an operator says so — with what was said.
 */
import { crmShutro } from '@kosh/crm';
import { livechatShutro, type Routed } from '@kosh/livechat';
import { type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

const TARGET = 'crm.deal';

/** The contact an email address is of, in the company, if there is exactly that one. */
async function contactOf(su: Env, email: string | null): Promise<number | null> {
  if (email === null || email.trim() === '') return null;
  const found = await su.model('res.partner').search({
    where: { email: { ilike: email.replace(/[%_\\]/g, '\\$&') } } as never,
    limit: 2,
  });
  return found.length === 1 ? (found.ids[0] as number) : null;
}

export const ChatDeals = extendModel('livechat.channel', {
  overrides: {
    routeTargets: async function (this: unknown, next: () => Promise<string[]>): Promise<string[]> {
      return [...(await next()), TARGET];
    },
  },
});

export const ChatDeal = extendModel('livechat.session', {
  overrides: {
    makeRecord: async function (
      this: unknown,
      next: (target: string, about: Routed) => Promise<{ id: number; name: string } | null>,
      target: string,
      about: Routed,
    ): Promise<{ id: number; name: string } | null> {
      if (target !== TARGET) return next(target, about);
      const su = (this as Records<'livechat.session'>).env as unknown as Env;
      // From the website, in the first stage, for no salesperson yet: every Pipeline user sees it.
      const [stage] = (
        await su.model('crm.stage').search({ order: ['sequence asc', 'id asc'], limit: 1 })
      ).ids;
      const partner = await contactOf(su, about.visitorEmail);
      const made = await su.model('crm.deal').create([
        {
          company: about.company,
          name: about.subject === '' ? 'Chat enquiry' : about.subject,
          description: about.transcript,
          contactName: about.visitorName,
          email: about.visitorEmail,
          partner,
          source: 'website',
          salesperson: null,
          ...(stage === undefined ? {} : { stage }),
        } as never,
      ]);
      await su.flush();
      const [deal] = await made.load(['name']);
      return deal === undefined ? null : { id: deal.id as number, name: deal.name };
    },
  },
});

// Named so the module's type stays short enough to emit (TS7056) with every model its dependencies carry.
const DEPENDS: readonly ModuleBase[] = [livechatShutro, crmShutro];
const MODELS = [] as const;
const EXTENSIONS = [ChatDeals, ChatDeal] as const;

export const livechatCrmShutro: Module<typeof MODELS, readonly ModuleBase[], typeof EXTENSIONS> =
  defineModule({
    name: 'livechat_crm',
    version: '0.1.0',
    depends: DEPENDS,
    groups: [
      orm.defineGroup({
        code: 'livechat_crm.user',
        label: 'Chats to deals',
        implies: ['livechat.user'],
      }),
    ],
    models: MODELS,
    extensions: EXTENSIONS,
  });
