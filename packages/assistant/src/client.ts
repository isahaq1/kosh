/**
 * The assistant's client (RFC 0013 §5.3): one Messages API request per feature, its answer constrained to a JSON
 * schema (structured outputs), the stable instructions first and cached. A refusal is an answer, not an error. The
 * interface lets tests and the end-to-end server answer without the API.
 */
import Anthropic from '@anthropic-ai/sdk';

/** One request: instructions (cached), the user's input, the answer's JSON schema. */
/** A file sent with a request: a PDF (as a document) or an image, base64-encoded. */
export interface Attachment {
  readonly mediaType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly data: string;
}

export interface JsonRequest {
  readonly system: string;
  readonly user: string;
  /** Files the user gave (sent before the text). */
  readonly attachments?: readonly Attachment[];
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

/** One text request (summaries, drafts): instructions (cached) and the input, the text streamed. */
export interface TextRequest {
  readonly system: string;
  readonly user: string;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly maxTokens?: number;
}

export interface TextAnswer {
  readonly text: string;
  readonly refused: boolean;
  readonly model: string;
  readonly usage: JsonAnswer['usage'];
}

export interface AssistantClient {
  readonly model: string;
  json(request: JsonRequest): Promise<JsonAnswer>;
  /** Streams the answer's text to `onText` as it comes, then resolves with the whole answer. */
  text(request: TextRequest, onText: (delta: string) => void): Promise<TextAnswer>;
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
      const files = (request.attachments ?? []).map((a) =>
        a.mediaType === 'application/pdf'
          ? {
              type: 'document' as const,
              source: { type: 'base64' as const, media_type: a.mediaType, data: a.data },
            }
          : {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: a.mediaType, data: a.data },
            },
      );
      const response = await client.beta.messages.create({
        model,
        max_tokens: request.maxTokens ?? 4096,
        // A refusal is retried on a model chosen by its category (RFC 0013 §5.3).
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content:
              files.length === 0 ? request.user : [...files, { type: 'text', text: request.user }],
          },
        ],
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
    async text(request, onText) {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: request.maxTokens ?? 4096,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: request.user }],
        output_config: { effort: request.effort ?? 'low' },
      });
      stream.on('text', onText);
      const message = await stream.finalMessage();
      const usage = {
        input: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0),
        output: message.usage.output_tokens,
        cached: message.usage.cache_read_input_tokens ?? 0,
      };
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { text, refused: message.stop_reason === 'refusal', model: message.model, usage };
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

/**
 * A client answering with `answer(request)` (tests, the end-to-end server): JSON requests get its value, text
 * requests its string, streamed word by word; `'refuse'` refuses.
 */
export function fakeClient(
  answer: (request: JsonRequest | TextRequest) => unknown,
  model = 'fake-model',
): AssistantClient & { readonly requests: (JsonRequest | TextRequest)[] } {
  const requests: (JsonRequest | TextRequest)[] = [];
  return {
    model,
    requests,
    async text(request, onText) {
      requests.push(request);
      const data = answer(request);
      if (data === 'refuse')
        return { text: '', refused: true, model, usage: { input: 100, output: 0, cached: 0 } };
      const text = String(data);
      for (const word of text.split(/(?<= )/)) onText(word);
      return { text, refused: false, model, usage: { input: 100, output: 20, cached: 0 } };
    },
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
