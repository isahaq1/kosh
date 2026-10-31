/**
 * Sites' routes (RFC 0021). The public ones need no sign-in but stay rate limited per address (`auth: false`); they
 * read in a system scope across companies — published pages only — and keep what they read for a while per server.
 * A submission is checked value by value and becomes its record in an audited system scope of the site's company.
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Id } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { formTargets, HONEYPOT, submissionValues } from './module.js';
import { type PublicPage, pageHtml, pageOf } from './render.js';

export const SUBMITTED = 'website.form.submitted';

/** At most this many inputs, and this long each (a long text: `LONG`). */
const MAX_INPUTS = 50;
const SHORT = 200;
const LONG = 5000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The kinds of field each input kind may fill. */
const FILLS: Readonly<Record<string, readonly string[]>> = {
  text: ['char', 'text'],
  email: ['char', 'text'],
  phone: ['char', 'text'],
  textarea: ['char', 'text'],
  number: ['integer', 'float', 'decimal'],
  date: ['date'],
};

const notFound = (what: string): HttpProblem =>
  new HttpProblem(404, 'not-found', 'Not found', `There is no ${what}.`);

interface SiteInfo {
  readonly id: number;
  readonly key: string;
  readonly name: string;
  readonly lang: string;
  readonly domain: string | null;
  readonly company: number;
}

/** A per-server memory of public reads (misses too), for `ttlMs`; at most `max` entries, the oldest dropped. */
class Memo {
  readonly #entries = new Map<string, { readonly at: number; readonly value: unknown }>();
  readonly ttlMs: number;
  readonly max: number;
  constructor(ttlMs: number, max = 500) {
    this.ttlMs = ttlMs;
    this.max = max;
  }
  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.#entries.get(key);
    if (hit !== undefined && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    const value = await load();
    if (this.ttlMs > 0) {
      this.#entries.delete(key);
      this.#entries.set(key, { at: Date.now(), value });
      if (this.#entries.size > this.max) {
        const [oldest] = this.#entries.keys();
        if (oldest !== undefined) this.#entries.delete(oldest);
      }
    }
    return value;
  }
}

export interface SitesOptions {
  /** How long a server keeps a public read (default 30 s; 0: never). */
  readonly cacheMs?: number | undefined;
}

export function registerSitesRoutes(context: ModuleContext, options: SitesOptions = {}): void {
  const { app, shutro } = context;
  const cacheMs = options.cacheMs ?? 30_000;
  const memo = new Memo(cacheMs);
  const maxAge = `public, max-age=${Math.floor(cacheMs / 1000)}`;

  /** A system scope reading across companies (public reads). */
  const reading = <T>(reason: string, fn: (env: Env) => Promise<T>): Promise<T> =>
    shutro.bootstrap({ reason: `sites: ${reason}` }, async (raw) =>
      fn((raw as unknown as Env).withFlags({ checkCompany: false }) as Env),
    );

  const siteOf = (key: string): Promise<SiteInfo | null> =>
    memo.get(`site:${key}`, () =>
      reading('site', async (env) => {
        const [site] = await env.model('website.site').search({ where: { key }, limit: 1 });
        return site === undefined
          ? null
          : {
              id: site.id,
              key: site.key,
              name: site.name,
              lang: site.lang,
              domain: site.domain,
              company: site.company.id,
            };
      }),
    );
  const siteParam = async (params: unknown): Promise<SiteInfo> => {
    const key = String((params as { site?: unknown }).site ?? '');
    const site = await siteOf(key);
    if (site === null) throw notFound(`site ${key}`);
    return site;
  };
  const langOf = (query: unknown, site: SiteInfo): 'en' | 'bn' => {
    const lang = String((query as { lang?: unknown } | null)?.lang ?? '');
    return lang === 'en' || lang === 'bn' ? lang : (site.lang as 'en' | 'bn');
  };

  app.get('/api/v1/public/sites/:site', { config: { auth: false } }, async (request, reply) => {
    const site = await siteParam(request.params);
    const lang = langOf(request.query, site);
    const menu = await memo.get(`menu:${site.key}:${lang}`, () =>
      reading('menu', async (env) =>
        [
          ...(await env.model('website.page').search({
            where: { site: site.id as never, lang, state: 'published', inMenu: true },
          })),
        ].map((p) => ({ path: p.path, title: p.title })),
      ),
    );
    void reply.header('cache-control', maxAge);
    return {
      site: { key: site.key, name: site.name, lang: site.lang, domain: site.domain },
      lang,
      menu,
    };
  });

  app.get(
    '/api/v1/public/sites/:site/page',
    { config: { auth: false } },
    async (request, reply) => {
      const site = await siteParam(request.params);
      const lang = langOf(request.query, site);
      const path = String((request.query as { path?: unknown } | null)?.path ?? '/');
      const page = await memo.get(`page:${site.key}:${lang}:${path}`, () =>
        reading('page', async (env): Promise<PublicPage | null> => {
          const [found] = await env.model('website.page').search({
            where: { site: site.id as never, path, lang, state: 'published' },
            limit: 1,
          });
          return found === undefined ? null : pageOf(env, found.id, true);
        }),
      );
      if (page === null) throw notFound(`published page at ${path} in this language`);
      void reply.header('cache-control', maxAge);
      return { site: { key: site.key, name: site.name }, page };
    },
  );

  app.post(
    '/api/v1/public/sites/:site/forms/:key',
    { config: { auth: false }, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const site = await siteParam(request.params);
      const key = String((request.params as { key?: unknown }).key ?? '');
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        throw new HttpProblem(400, 'invalid-body', 'Invalid form', 'Send the form as an object.');
      const sent = body as Record<string, unknown>;
      if (Object.keys(sent).length > MAX_INPUTS + 1)
        throw new HttpProblem(400, 'invalid-body', 'Invalid form', 'Too many inputs.');
      const describe = context.registry.registry;
      const result = await shutro.bootstrap(
        { reason: `sites: form ${key} submitted`, company: site.company },
        // The visitor has no rights of their own: the record is made as the system, audited with the form's key.
        (raw) =>
          (raw as unknown as Env).asSuperuser({ reason: `website form ${key}` }, async (env) => {
            const [form] = await env.model('website.form').search({ where: { key }, limit: 1 });
            if (form === undefined) throw notFound(`form ${key}`);
            const spam = String(sent[HONEYPOT] ?? '') !== '';
            const fields = [
              ...(await env.model('website.form.field').search({ where: { form: form.id } })),
            ];
            const data: Record<string, string> = {};
            for (const x of fields) {
              const value = sent[x.name];
              if (value !== undefined && value !== null && typeof value !== 'string')
                throw invalid(x.label, 'is text');
              const text = (value ?? '').trim();
              if (text !== '') data[x.name] = text;
            }
            if (spam) {
              const [made] = (
                await env
                  .model('website.submission')
                  .create([{ form: form.id, site: site.id as never, data, state: 'spam' }])
              ).ids;
              await env.flush();
              return { message: form.successMessage, submission: made ?? null };
            }
            const targets = await formTargets(env);
            if (!targets.includes(form.target) || !describe.models.has(form.target as never))
              throw new HttpProblem(
                409,
                'form-target',
                'Form not available',
                'This form creates records no installed app allows.',
              );
            const description = describe.describe(form.target as never);
            const values: Record<string, unknown> = {
              ...(await submissionValues(env, form.target)),
            };
            for (const x of fields) {
              const target = description.fields[x.targetField];
              if (
                target === undefined ||
                !(FILLS[x.kind] ?? []).includes(target.kind) ||
                target.readonly ||
                target.computed
              )
                throw new HttpProblem(
                  409,
                  'form-field',
                  'Form not available',
                  `The input ${x.name} fills ${x.targetField}, which a form cannot fill.`,
                );
              const text = data[x.name];
              if (text === undefined) {
                if (x.required) throw invalid(x.label, 'is required');
                continue;
              }
              values[x.targetField] = inputValue(x, text);
            }
            const created = await env.model(form.target as never).create([values as never]);
            const id = created.ids[0] as number;
            const [named] = (
              await env
                .model(form.target as never)
                .browse([id as never])
                .load([description.recName] as never)
            ).read([description.recName] as never) as Record<string, unknown>[];
            const [made] = (
              await env.model('website.submission').create([
                {
                  form: form.id,
                  site: site.id as never,
                  data,
                  state: 'received',
                  resModel: form.target,
                  resId: id,
                  resName: String(named?.[description.recName] ?? ''),
                },
              ])
            ).ids;
            if (made !== undefined) await env.emit(SUBMITTED, { id: made });
            // Written while still the superuser: the commit's flush checks constraints as the caller.
            await env.flush();
            return { message: form.successMessage, submission: made ?? null };
          }),
      );
      return reply.status(201).send({ message: result.message });
    },
  );

  // The editors' preview: the page as it will look, draft or published, for those who may read it.
  app.get('/api/v1/sites/pages/:id/preview', async (request) => {
    const id = Number((request.params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The id is a positive integer.');
    return request.env(async (raw) => {
      const env = raw as unknown as Env;
      const found = await env
        .model('website.page')
        .search({ where: { id: id as Id<'website.page'> }, limit: 1 });
      if (found.length === 0) throw notFound(`page ${id}`);
      const page = await pageOf(env, id as Id<'website.page'>, false);
      if (page === null) throw notFound(`page ${id}`);
      return { html: pageHtml(page), page };
    });
  });
}

function invalid(label: string, what: string): HttpProblem {
  return new HttpProblem(422, 'invalid-input', 'Check the form', `${label} ${what}.`);
}

/** An input's text as the value its field takes, checked for its kind. */
function inputValue(
  x: { readonly label: string; readonly kind: string },
  text: string,
): string | number {
  const max = x.kind === 'textarea' ? LONG : SHORT;
  if (text.length > max) throw invalid(x.label, `is at most ${max} characters`);
  switch (x.kind) {
    case 'email':
      if (!EMAIL.test(text)) throw invalid(x.label, 'is an email address');
      return text.toLowerCase();
    case 'phone':
      if (!/^[+\d][\d\s().-]{3,30}$/.test(text)) throw invalid(x.label, 'is a phone number');
      return text;
    case 'number': {
      const n = Number(text);
      if (!Number.isFinite(n)) throw invalid(x.label, 'is a number');
      return text;
    }
    case 'date':
      if (!DATE.test(text) || Number.isNaN(Date.parse(text))) throw invalid(x.label, 'is a date');
      return text;
    default:
      return text;
  }
}
