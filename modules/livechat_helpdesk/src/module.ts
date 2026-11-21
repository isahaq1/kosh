/**
 * The data layer of the Live chat ↔ Helpdesk bridge (RFC 0034 §2.6): a conversation that ended may become
 * a ticket — by the channel's routing rules, or when an operator says so — with what was said.
 */
import { helpdeskShutro } from '@kosh/helpdesk';
import { livechatShutro, type Routed } from '@kosh/livechat';
import { type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

const TARGET = 'helpdesk.ticket';

/** The contact an email address is of, in the company, if there is exactly that one. */
async function contactOf(su: Env, email: string | null): Promise<number | null> {
  if (email === null || email.trim() === '') return null;
  const found = await su.model('res.partner').search({
    where: { email: { ilike: email.replace(/[%_\\]/g, '\\$&') } } as never,
    limit: 2,
  });
  return found.length === 1 ? (found.ids[0] as number) : null;
}

export const ChatTickets = extendModel('livechat.channel', {
  overrides: {
    routeTargets: async function (this: unknown, next: () => Promise<string[]>): Promise<string[]> {
      return [...(await next()), TARGET];
    },
  },
});

export const ChatTicket = extendModel('livechat.session', {
  overrides: {
    makeRecord: async function (
      this: unknown,
      next: (target: string, about: Routed) => Promise<{ id: number; name: string } | null>,
      target: string,
      about: Routed,
    ): Promise<{ id: number; name: string } | null> {
      if (target !== TARGET) return next(target, about);
      const su = (this as Records<'livechat.session'>).env as unknown as Env;
      const text = (value: string): string =>
        value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // The company's first team takes it; its own rules then give it an agent.
      const [team] = (
        await su
          .model('helpdesk.team')
          .search({ where: { company: about.company } as never, order: ['id asc'], limit: 1 })
      ).ids;
      const partner = await contactOf(su, about.visitorEmail);
      const made = await su.model('helpdesk.ticket').create([
        {
          company: about.company,
          subject: about.subject === '' ? 'Chat' : about.subject,
          // What was said, a line per message: text, written as text.
          description: about.transcript
            .split('\n')
            .map((line) => `<p>${text(line)}</p>`)
            .join(''),
          team: team ?? null,
          partner,
          email: about.visitorEmail,
        } as never,
      ]);
      await su.flush();
      const [ticket] = await made.load(['name']);
      return ticket === undefined ? null : { id: ticket.id as number, name: ticket.name };
    },
  },
});

// Named so the module's type stays short enough to emit (TS7056) with every model its dependencies carry.
const DEPENDS: readonly ModuleBase[] = [livechatShutro, helpdeskShutro];
const MODELS = [] as const;
const EXTENSIONS = [ChatTickets, ChatTicket] as const;

export const livechatHelpdeskShutro: Module<
  typeof MODELS,
  readonly ModuleBase[],
  typeof EXTENSIONS
> = defineModule({
  name: 'livechat_helpdesk',
  version: '0.1.0',
  depends: DEPENDS,
  groups: [
    orm.defineGroup({
      code: 'livechat_helpdesk.user',
      label: 'Chats to tickets',
      implies: ['livechat.user'],
    }),
  ],
  models: MODELS,
  extensions: EXTENSIONS,
});
