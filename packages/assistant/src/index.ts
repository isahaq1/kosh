/**
 * @packageDocumentation
 * `@kosh/assistant` (RFC 0013): an AI assistant on Claude that proposes and never acts — natural-language search
 * first (step 1). It runs as the user, describes only what the user may read, is off for a company until an
 * administrator switches it on, logs every call without its content, and stays within a monthly token budget.
 */

import { messaging } from '@kosh/messaging';
import { defineModule, type KoshModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import { settings } from '@kosh/settings';
import { type AssistantClient, clientFromEnv } from './client.js';
import { assistantShutro } from './models.js';
import { registerAssistantRoutes } from './routes.js';

export {
  type AssistantClient,
  anthropicClient,
  clientFromEnv,
  DEFAULT_MODEL,
  fakeClient,
  type JsonAnswer,
  type JsonRequest,
  type TextAnswer,
  type TextRequest,
} from './client.js';
export { assistantShutro } from './models.js';
export {
  languageName,
  type RecordText,
  recordText,
  replyInstructions,
  summaryInstructions,
  TIMELINE_ITEMS,
} from './record.js';
export { registerAssistantRoutes, searchFieldsFor } from './routes.js';
export {
  domainOf,
  operatorsOf,
  SearchAnswerError,
  type SearchField,
  searchInstructions,
  searchSchema,
} from './search.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/assistant',
  rfc: 'RFC 0013',
});

/** The default monthly budget per company (RFC 0013 §5.1). */
export const DEFAULT_MONTHLY_TOKENS = 2_000_000;

export interface AssistantOptions {
  /** Default: from `ANTHROPIC_API_KEY` / `KOSH_ASSISTANT_MODEL`; null: off. */
  readonly client?: AssistantClient | null;
  /** Default: `KOSH_ASSISTANT_MONTHLY_TOKENS`, else 2 000 000. */
  readonly monthlyTokens?: number;
}

/** The assistant module with explicit options (tests, the end-to-end server). */
export function createAssistant(options: AssistantOptions = {}): KoshModule {
  return defineModule({
    shutro: assistantShutro,
    kosh: '^0.1.0',
    depends: [base, settings, messaging],
    accessLevels: { user: { label: 'AI assistant', groups: ['assistant.user'] } },
    privateModels: ['assistant.config', 'assistant.call'],
    actions: {
      'assistant.action_settings': {
        type: 'client',
        page: 'assistant.Settings',
        label: 'AI assistant',
      },
    },
    menus: [
      {
        id: 'assistant.settings',
        parent: 'settings.root',
        label: 'AI assistant',
        action: 'assistant.action_settings',
        sequence: 50,
      },
    ],
    routes: (context: ModuleContext) => {
      const env = process.env;
      const budget = Number(env['KOSH_ASSISTANT_MONTHLY_TOKENS'] ?? DEFAULT_MONTHLY_TOKENS);
      registerAssistantRoutes(context, {
        client: options.client === undefined ? clientFromEnv(env) : options.client,
        monthlyTokens:
          options.monthlyTokens ??
          (Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_MONTHLY_TOKENS),
      });
    },
  });
}

/** The assistant, configured from the environment. */
export const assistant: KoshModule = createAssistant();
