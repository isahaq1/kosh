/**
 * The assistant's models (RFC 0013 §5.1, §5.6): whether a company uses the assistant (off until an administrator
 * switches it on), and the log of every call — who, what for, which model, the tokens, never the content.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const { defineGroup, defineModel, defineModule, f } = orm;

const Config = defineModel('assistant.config', {
  label: 'Assistant settings',
  companyScoped: { required: true },
  access: { 'assistant.user': ['read'] },
  fields: {
    enabled: f.boolean({ required: true, default: false }),
  },
  sqlConstraints: {
    onePerCompany: { unique: ['company'], message: 'One assistant setting per company.' },
  },
});

const Call = defineModel('assistant.call', {
  label: 'Assistant call',
  order: ['id desc'],
  companyScoped: { required: true },
  access: {},
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    /** `search`, later `summary`, `reply`, `form`. */
    feature: f.char({ required: true, size: 20 }),
    /** The Claude model that answered. */
    llm: f.char({ required: true, size: 60, label: 'Model' }),
    /** The Kosh model the call was about (`sale.order`). */
    resModel: f.char({ label: 'Record model' }),
    inputTokens: f.integer({ required: true, default: 0 }),
    outputTokens: f.integer({ required: true, default: 0 }),
    cachedTokens: f.integer({ required: true, default: 0 }),
    durationMs: f.integer({ required: true, default: 0 }),
    refused: f.boolean({ required: true, default: false }),
    /** Why the answer was not used (an invalid domain, the budget), when it was not. */
    error: f.char({ size: 500 }),
  },
});

export const assistantShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'assistant',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [defineGroup({ code: 'assistant.user', label: 'AI assistant', implies: ['base.user'] })],
  models: [Config, Call],
});
