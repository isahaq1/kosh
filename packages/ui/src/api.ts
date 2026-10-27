/**
 * The API as the view renderers see it: models known only at runtime, from view definitions (RFC 0004). Business
 * code uses the generated typed client (`kosh generate client`); both speak the same REST API, sessions (cookie +
 * CSRF header) and RFC 9457 problems. The server decides everything; this only transports.
 */
import type { Action, Condition, SearchSpec, ViewDefinition, ViewType } from '@kosh/views';

export type Row = Record<string, unknown> & { readonly id: number };

/** An RFC 9457 problem. */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly hint?: string;
}

/** A refused request. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.hint === undefined ? problem.detail : `${problem.detail} ${problem.hint}`);
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
  }
  /** The short problem type (`stale-record`, `access`, `two-factor-required`). */
  get kind(): string {
    return this.problem.type.replace(/^https:\/\/kosh\.dev\/problems\//, '');
  }
}

/**
 * The request never reached the server, or its answer never came back (offline, a dropped connection): nothing is
 * known about its fate. Forms keep such a save on the device (`offline/queue.ts`).
 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('The server could not be reached.', { cause });
    this.name = 'NetworkError';
  }
}

/** `fetch` that throws {@link NetworkError} instead of a bare `TypeError` when the network fails. */
async function reach(doFetch: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  try {
    return await doFetch(input, init);
  } catch (error) {
    throw new NetworkError(error);
  }
}

export interface ViewField {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly target?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/** A view for the current user (`GET /api/v1/views/:id`). */
export interface ServedView {
  readonly view: ViewDefinition;
  readonly fields: Readonly<Record<string, Readonly<Record<string, ViewField>>>>;
  readonly transitions: readonly {
    name: string;
    field: string;
    from: readonly string[];
    to: string;
  }[];
  readonly operations: {
    readonly create: boolean;
    readonly write: boolean;
    readonly unlink: boolean;
  };
  readonly onchange: readonly string[];
}

export interface CurrentUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly company: number | null;
  readonly companies: readonly number[];
  readonly twoFactorEnabled: boolean;
  readonly administrator: boolean;
  readonly administratorNeedsSecondFactor: boolean;
}

export interface AppEntry {
  readonly code: string;
  readonly label: string;
  readonly icon?: string;
  readonly category?: string;
  readonly summary?: string;
  readonly sequence: number;
}
/** A model as `/api/v1/meta/:model` describes it for the user: what they may do, and the fields they may read. */
export interface ModelMeta {
  readonly name: string;
  readonly label: string;
  readonly operations: Readonly<
    Record<'read' | 'write' | 'create' | 'unlink' | 'export' | 'import', boolean>
  >;
  readonly transitions: readonly string[];
  readonly fields: readonly ViewField[];
}
/** A record the global search found, with the action and app that open it. */
export interface FoundRecord {
  readonly model: string;
  readonly modelLabel: string;
  readonly id: number;
  readonly displayName: string;
  readonly action: string;
  readonly app: string | undefined;
}
export interface MenuNode {
  readonly id: string;
  readonly label: string;
  readonly app?: string;
  readonly action?: string;
  readonly sequence: number;
  readonly children: readonly MenuNode[];
}

export interface ListQuery {
  readonly filter?: Condition | undefined;
  readonly order?: readonly string[];
  readonly fields?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
  readonly count?: boolean;
}

export interface Versioned {
  readonly record: Row;
  readonly etag: string | null;
}

/** The dynamic API. */
export interface KoshApi {
  me(): Promise<CurrentUser>;
  login(login: string, password: string): Promise<{ twoFactorRequired: boolean }>;
  verifyTwoFactor(code: string): Promise<void>;
  logout(): Promise<void>;
  apps(): Promise<readonly AppEntry[]>;
  menus(app?: string): Promise<readonly MenuNode[]>;
  action(id: string): Promise<Action>;
  view(id: string): Promise<ServedView>;
  viewFor(model: string, type: ViewType): Promise<ServedView>;
  search(model: string): Promise<SearchSpec>;
  list(model: string, query?: ListQuery): Promise<{ items: Row[]; count?: number }>;
  get(model: string, id: number, fields?: readonly string[]): Promise<Versioned>;
  create(model: string, values: Record<string, unknown>): Promise<Versioned>;
  update(
    model: string,
    id: number,
    values: Record<string, unknown>,
    ifMatch?: string | null,
  ): Promise<Versioned>;
  remove(model: string, id: number): Promise<void>;
  /** Name search (`q`) or display names of `ids`. */
  names(
    model: string,
    query: { readonly q?: string; readonly ids?: readonly number[]; readonly limit?: number },
  ): Promise<{ id: number; displayName: string }[]>;
  transition(model: string, id: number, name: string): Promise<Versioned>;
  onchange(
    model: string,
    input: {
      readonly id?: number;
      readonly values: Record<string, unknown>;
      readonly changed: readonly string[];
    },
  ): Promise<{ values: Record<string, unknown>; warnings?: readonly string[] }>;
  aggregate(
    model: string,
    query: {
      where?: Condition | undefined;
      groupBy?: readonly string[];
      measures: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>[]>;
  /** The company of later requests (`X-Company`). */
  setCompany(company: number | undefined): void;
  /** The language of later requests (`Accept-Language`: server-side labels and messages). */
  setLanguage(lang: string): void;
  /** Records named like `q` across the user's visible apps (the command palette). */
  find(q: string, limit?: number): Promise<FoundRecord[]>;
  /** A model's operations and readable fields for the user. */
  meta(model: string): Promise<ModelMeta>;
  /** Where records of each model open for the user: `{ 'sale.order': { action, app } }`. */
  routes(): Promise<Readonly<Record<string, { action: string; app: string | undefined }>>>;
  /** Raw call for module code (custom routes). */
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** A file from the API (exports, documents): the response body and its file name. */
  download(
    path: string,
    body?: unknown,
    method?: 'GET' | 'POST',
  ): Promise<{ readonly blob: Blob; readonly filename: string }>;
  /** Sends a file as the raw body (`Content-Type` from the file, `X-Filename` URI-encoded); the JSON answer. */
  upload<T>(path: string, file: Blob, filename: string): Promise<T>;
  /**
   * POSTs `body` and reads the server-sent events of the answer (`event:` and JSON `data:` lines), calling
   * `onEvent` for each (`message` when the event has no name) until the stream ends. @throws {ApiError} when the
   * server answers with a problem instead of a stream
   */
  stream(
    path: string,
    body: unknown,
    onEvent: (event: string, data: unknown) => void,
  ): Promise<void>;
}

export interface ApiOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Where the CSRF token survives reloads (default: `sessionStorage`). */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

const CSRF_KEY = 'kosh.csrf';

/** Creates the API over the browser session (httpOnly cookie + CSRF header). */
export function createKoshApi(options: ApiOptions = {}): KoshApi {
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storage =
    options.storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
  let csrf: string | undefined = storage?.getItem(CSRF_KEY) ?? undefined;
  let company: number | undefined;
  let language: string | undefined;

  async function request<T>(
    method: string,
    path: string,
    init: {
      body?: unknown;
      query?: Record<string, string | undefined>;
      headers?: Record<string, string | undefined>;
    } = {},
  ): Promise<{ body: T; headers: Headers }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) params.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [k, v] of Object.entries(init.headers ?? {})) if (v !== undefined) headers[k] = v;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (csrf !== undefined && method !== 'GET') headers['x-csrf-token'] = csrf;
    if (company !== undefined) headers['x-company'] = String(company);
    if (language !== undefined) headers['accept-language'] = language.replace('_', '-');
    const search = params.size === 0 ? '' : `?${params.toString()}`;
    const response = await reach(doFetch, `${base}${path}${search}`, {
      method,
      headers,
      credentials: 'include',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const problem =
        typeof body === 'object' && body !== null && 'type' in body
          ? (body as Problem)
          : {
              type: 'about:blank',
              title: response.statusText,
              status: response.status,
              detail: text.slice(0, 300),
            };
      throw new ApiError(problem);
    }
    return { body: body as T, headers: response.headers };
  }
  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    (await request<T>(method, path, body === undefined ? {} : { body })).body;
  const versioned = async (
    pending: Promise<{ body: Row; headers: Headers }>,
  ): Promise<Versioned> => {
    const { body, headers } = await pending;
    return { record: body, etag: headers.get('etag') };
  };
  const model = (name: string) => `/api/v1/models/${encodeURIComponent(name)}`;

  return {
    me: () => json('GET', '/api/v1/auth/me'),
    async login(login, password) {
      const result = await json<{ csrfToken: string; twoFactorRequired: boolean }>(
        'POST',
        '/api/v1/auth/login',
        { login, password },
      );
      csrf = result.csrfToken;
      storage?.setItem(CSRF_KEY, csrf);
      return { twoFactorRequired: result.twoFactorRequired };
    },
    async verifyTwoFactor(code) {
      await json('POST', '/api/v1/auth/2fa/verify', { code });
    },
    async logout() {
      await json('POST', '/api/v1/auth/logout').catch(() => undefined);
      csrf = undefined;
      storage?.removeItem(CSRF_KEY);
    },
    apps: async () => (await json<{ apps: AppEntry[] }>('GET', '/api/v1/apps')).apps,
    menus: async (app) =>
      (await request<{ menus: MenuNode[] }>('GET', '/api/v1/menus', { query: { app } })).body.menus,
    action: async (id) =>
      (await json<{ spec: Action }>('GET', `/api/v1/actions/${encodeURIComponent(id)}`)).spec,
    view: (id) => json('GET', `/api/v1/views/${encodeURIComponent(id)}`),
    viewFor: async (name, type) =>
      (await request<ServedView>('GET', '/api/v1/views', { query: { model: name, type } })).body,
    search: (name) => json('GET', `/api/v1/search/${encodeURIComponent(name)}`),
    async list(name, query = {}) {
      return (
        await request<{ items: Row[]; count?: number }>('GET', model(name), {
          query: {
            filter: query.filter === undefined ? undefined : JSON.stringify(query.filter),
            order: query.order?.join(','),
            fields: query.fields?.join(','),
            limit: query.limit === undefined ? undefined : String(query.limit),
            offset: query.offset === undefined ? undefined : String(query.offset),
            count: query.count === true ? 'true' : undefined,
          },
        })
      ).body;
    },
    get: (name, id, fields) =>
      versioned(request('GET', `${model(name)}/${id}`, { query: { fields: fields?.join(',') } })),
    create: (name, values) => versioned(request('POST', model(name), { body: values })),
    update: (name, id, values, ifMatch) =>
      versioned(
        request('PATCH', `${model(name)}/${id}`, {
          body: values,
          headers: { 'if-match': ifMatch ?? undefined },
        }),
      ),
    async remove(name, id) {
      await request('DELETE', `${model(name)}/${id}`);
    },
    names: async (name, query) =>
      (
        await request<{ items: { id: number; displayName: string }[] }>(
          'GET',
          `${model(name)}/names`,
          {
            query: {
              q: query.q,
              ids: query.ids === undefined ? undefined : query.ids.join(','),
              limit: query.limit === undefined ? undefined : String(query.limit),
            },
          },
        )
      ).body.items,
    transition: (name, id, t) =>
      versioned(request('POST', `${model(name)}/${id}/transitions/${encodeURIComponent(t)}`)),
    onchange: (name, input) => json('POST', `${model(name)}/onchange`, input),
    aggregate: async (name, query) =>
      (await json<{ rows: Record<string, unknown>[] }>('POST', `${model(name)}/aggregate`, query))
        .rows,
    setCompany(next) {
      company = next;
    },
    setLanguage(next) {
      language = next;
    },
    call: (method, path, body) => json(method, path, body),
    meta: (name) => json('GET', `/api/v1/meta/${encodeURIComponent(name)}`),
    routes: async () =>
      (
        await json<{ routes: Record<string, { action: string; app: string | undefined }> }>(
          'GET',
          '/api/v1/routes',
        )
      ).routes,
    find: async (q, limit) =>
      (
        await request<{ results: FoundRecord[] }>('GET', '/api/v1/find', {
          query: { q, ...(limit === undefined ? {} : { limit: String(limit) }) },
        })
      ).body.results,
    async stream(path, body, onEvent) {
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        'content-type': 'application/json',
      };
      if (csrf !== undefined) headers['x-csrf-token'] = csrf;
      if (company !== undefined) headers['x-company'] = String(company);
      if (language !== undefined) headers['accept-language'] = language.replace('_', '-');
      const response = await reach(doFetch, `${base}${path}`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!response.ok || response.body === null) {
        const text = await response.text();
        let parsed: unknown = null;
        try {
          parsed = text === '' ? null : JSON.parse(text);
        } catch {
          parsed = null;
        }
        throw new ApiError(
          (parsed as Problem | null) ?? {
            type: 'about:blank',
            title: response.statusText,
            status: response.status,
            detail: text.slice(0, 300),
          },
        );
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = '';
      const flush = (block: string) => {
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length === 0) return;
        try {
          onEvent(event, JSON.parse(data.join('\n')));
        } catch {
          onEvent(event, data.join('\n'));
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += value;
        let end = buffered.indexOf('\n\n');
        while (end !== -1) {
          flush(buffered.slice(0, end));
          buffered = buffered.slice(end + 2);
          end = buffered.indexOf('\n\n');
        }
      }
      if (buffered.trim() !== '') flush(buffered);
    },
    async upload<T>(path: string, file: Blob, filename: string): Promise<T> {
      const headers: Record<string, string> = {
        'content-type': file.type === '' ? 'application/octet-stream' : file.type,
        'x-filename': encodeURIComponent(filename),
      };
      if (csrf !== undefined) headers['x-csrf-token'] = csrf;
      if (company !== undefined) headers['x-company'] = String(company);
      if (language !== undefined) headers['accept-language'] = language.replace('_', '-');
      const response = await reach(doFetch, `${base}${path}`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: file,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!response.ok)
        throw new ApiError(
          (parsed as Problem | null) ?? {
            type: 'about:blank',
            title: response.statusText,
            status: response.status,
            detail: text.slice(0, 300),
          },
        );
      return parsed as T;
    },
    async download(path, body, method = 'POST') {
      const headers: Record<string, string> =
        method === 'POST' ? { 'content-type': 'application/json' } : {};
      if (csrf !== undefined && method !== 'GET') headers['x-csrf-token'] = csrf;
      if (company !== undefined) headers['x-company'] = String(company);
      if (language !== undefined) headers['accept-language'] = language.replace('_', '-');
      const response = await doFetch(`${base}${path}`, {
        method,
        headers,
        credentials: 'include',
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      if (!response.ok) {
        const text = await response.text();
        let problem: Problem;
        try {
          problem = JSON.parse(text) as Problem;
        } catch {
          problem = {
            type: 'about:blank',
            title: response.statusText,
            status: response.status,
            detail: text.slice(0, 300),
          };
        }
        throw new ApiError(problem);
      }
      const disposition = response.headers.get('content-disposition') ?? '';
      // RFC 6266: the UTF-8 name when given, else the ASCII fallback.
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      let filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';
      if (encoded !== undefined)
        try {
          filename = decodeURIComponent(encoded);
        } catch {
          // keep the fallback
        }
      return { blob: await response.blob(), filename };
    },
  };
}
