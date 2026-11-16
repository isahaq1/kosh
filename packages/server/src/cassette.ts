/**
 * The adapter certification kit (RFC 0034 §2.2): an adapter's contract suite runs against the provider's real
 * sandbox with `KOSH_CERTIFY=live`, recording every HTTP exchange; everywhere else (CI, `pnpm test`) the recording is
 * replayed, so a change in what the adapter sends is caught without reaching the provider, and the recording's date
 * says when the adapter last passed against the real sandbox.
 *
 * Recordings never hold secrets: the credentials given as `secrets` (and their URL-encoded forms) and every JSON
 * field named like a token, secret or password are replaced by `<redacted>` in URLs and bodies, both ways.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Exchange {
  readonly method: string;
  readonly url: string;
  readonly requestBody: string;
  readonly status: number;
  readonly contentType: string;
  readonly responseBody: string;
}

export interface Recording {
  readonly adapter: string;
  /** When the contract last passed against the provider's sandbox. */
  readonly recordedAt: string;
  /** Values the suite chose in the live run (references), given back on replay. */
  readonly vars: Readonly<Record<string, string>>;
  readonly exchanges: readonly Exchange[];
}

export interface Cassette {
  /** True when talking to the real sandbox. */
  readonly live: boolean;
  /** The HTTP client to give the adapter. */
  readonly fetch: typeof fetch;
  /** A value chosen live (e.g. a unique reference), the recorded one on replay. */
  vars(name: string, make: () => string): string;
  /** When the recording was made (now, when live). */
  readonly recordedAt: string;
  /**
   * Writes the recording once the whole contract passed live; does nothing on replay. A failed live run is written
   * beside it as `<name>.failed.json` (never committed) to see what the provider answered.
   */
  save(how?: { readonly failed?: boolean }): void;
}

const REDACTED = '<redacted>';
const SECRET_KEY = /token|secret|password|passwd/i;

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) && typeof v === 'string' ? REDACTED : redactJson(v),
      ]),
    );
  return value;
}

/** The text with every secret, raw or URL-encoded, replaced; JSON with secret-named fields blanked. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets.filter((x) => x.length >= 3))
    for (const form of new Set([
      s,
      encodeURIComponent(s),
      new URLSearchParams({ x: s }).toString().slice(2),
    ]))
      out = out.split(form).join(REDACTED);
  try {
    const parsed: unknown = JSON.parse(out);
    if (parsed !== null && typeof parsed === 'object') return JSON.stringify(redactJson(parsed));
  } catch {
    // not JSON
  }
  return out;
}

function bodyText(body: RequestInit['body']): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('The cassette records string and form bodies only.');
}

/**
 * A cassette at `file` for `adapter`. Live when `KOSH_CERTIFY=live` (or `options.live`), replaying `file` otherwise;
 * with no recording yet, replay fails saying how to make one.
 */
export function cassette(
  file: string,
  options: {
    readonly adapter: string;
    readonly secrets: readonly string[];
    readonly live?: boolean;
    readonly fetch?: typeof fetch;
  },
): Cassette {
  const live = options.live ?? process.env['KOSH_CERTIFY'] === 'live';
  const secrets = options.secrets;
  if (live) {
    const exchanges: Exchange[] = [];
    const vars: Record<string, string> = {};
    const real = options.fetch ?? fetch;
    const recordedAt = new Date().toISOString();
    return {
      live,
      recordedAt,
      vars: (name, make) => (vars[name] ??= make()),
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const res = await real(input, init);
        const responseBody = await res.text();
        exchanges.push({
          method: (init.method ?? 'GET').toUpperCase(),
          url: redact(url, secrets),
          requestBody: redact(bodyText(init.body), secrets),
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
          responseBody: redact(responseBody, secrets),
        });
        return new Response(responseBody, {
          status: res.status,
          headers: { 'content-type': res.headers.get('content-type') ?? '' },
        });
      }) as typeof fetch,
      save(how = {}) {
        mkdirSync(dirname(file), { recursive: true });
        const recording: Recording = { adapter: options.adapter, recordedAt, vars, exchanges };
        const target = how.failed === true ? file.replace(/[.]json$/, '.failed.json') : file;
        writeFileSync(target, `${JSON.stringify(recording, null, 2)}\n`);
      },
    };
  }
  if (!existsSync(file))
    throw new Error(
      `No recording for ${options.adapter} at ${file}: run its contract against the sandbox with KOSH_CERTIFY=live.`,
    );
  const recording = JSON.parse(readFileSync(file, 'utf8')) as Recording;
  let next = 0;
  return {
    live,
    recordedAt: recording.recordedAt,
    vars: (name, make) => recording.vars[name] ?? make(),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const sent = {
        method: (init.method ?? 'GET').toUpperCase(),
        url: redact(url, secrets),
        requestBody: redact(bodyText(init.body), secrets),
      };
      const expected = recording.exchanges[next];
      if (expected === undefined)
        throw new Error(
          `${options.adapter} sent request ${next + 1} (${sent.method} ${sent.url}), which the recording does not have. Re-record against the sandbox with KOSH_CERTIFY=live.`,
        );
      for (const key of ['method', 'url', 'requestBody'] as const)
        if (expected[key] !== sent[key])
          throw new Error(
            `${options.adapter}'s request ${next + 1} differs from the recording in its ${key}:\n  recorded: ${expected[key]}\n  sent:     ${sent[key]}\nIf the change is intended, re-record against the sandbox with KOSH_CERTIFY=live.`,
          );
      next += 1;
      return new Response(expected.responseBody, {
        status: expected.status,
        headers: { 'content-type': expected.contentType },
      });
    }) as typeof fetch,
    save() {},
  };
}
