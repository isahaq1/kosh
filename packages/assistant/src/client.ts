/**
 * The assistant's client (RFC 0013 §5.3): one Messages API request per feature, its answer constrained to a JSON
 * schema (structured outputs), the stable instructions first and cached. A refusal is an answer, not an error. The
 * interface lets tests and the end-to-end server answer without the API.
 */
import Anthropic from '@anthropic-ai/sdk';

/** One request: instructions (cached), the user's input, the answer's JSON schema. */
export interface JsonRequest {
  readonly system: string;
  readonly user: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly maxTokens?: number;
}

export interface JsonAnswer {
  /** The parsed answer; null when the model refused. */
  readonly data: unknown;
  readonly refused: boolean;
  /** The model that answered (a refusal fallback may have answered instead of the one asked). */
  readonly model: string;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cached: number;
  };
}

export interface AssistantClient {
  readonly model: string;
  json(request: JsonRequest): Promise<JsonAnswer>;
}

/** The default model (RFC 0013 §5.1). */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** A client of the Anthropic API (`ANTHROPIC_API_KEY`). */
export function anthropicClient(options: {
  readonly apiKey: string;
  readonly model?: string;
}): AssistantClient {
  const client = new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? DEFAULT_MODEL;
  return {
    model,
    async json(request) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: request.maxTokens ?? 4096,
        // A refusal is retried on a model chosen by its category (RFC 0013 §5.3).
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: request.user }],
        output_config: {
          effort: request.effort ?? 'low',
          format: { type: 'json_schema', schema: request.schema as Record<string, unknown> },
        },
      });
      const message = response;
      const usage = {
        input: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0),
        output: message.usage.output_tokens,
        cached: message.usage.cache_read_input_tokens ?? 0,
      };
      if (message.stop_reason === 'refusal')
        return { data: null, refused: true, model: message.model, usage };
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return { data: JSON.parse(text), refused: false, model: message.model, usage };
    },
  };
}

/** The client from the environment; null when no key is set (the assistant is then off). */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): AssistantClient | null {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey === '') return null;
  const model = env['KOSH_ASSISTANT_MODEL'];
  return anthropicClient({ apiKey, ...(model === undefined || model === '' ? {} : { model }) });
}

/** A client answering with `answer(request)` (tests, the end-to-end server). */
export function fakeClient(
  answer: (request: JsonRequest) => unknown,
  model = 'fake-model',
): AssistantClient & { readonly requests: JsonRequest[] } {
  const requests: JsonRequest[] = [];
  return {
    model,
    requests,
    async json(request) {
      requests.push(request);
      const data = answer(request);
      return {
        data: data === 'refuse' ? null : data,
        refused: data === 'refuse',
        model,
        usage: { input: 100, output: 20, cached: 0 },
      };
    },
  };
}
