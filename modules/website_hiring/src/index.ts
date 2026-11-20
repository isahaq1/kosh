/**
 * @packageDocumentation
 * `@kosh/website_hiring` (RFC 0034 §2.6): the **careers page**, the bridge of Sites and Hiring. Proposed whenever
 * both apps are installed.
 *
 * - An opening is put *on the careers page*, with its place of work, its employment and a closing date.
 * - The site reads the openings and takes applications without a sign-in: an applicant from the website, in the
 *   first stage, with their letter and their CV attached — one per email address and opening.
 * - A stage with an email subject and text emails each candidate who reaches it, once.
 *
 * - `GET  /api/v1/public/sites/:site/careers`             the openings shown, by name
 * - `GET  /api/v1/public/sites/:site/careers/:id`         one of them
 * - `POST /api/v1/public/sites/:site/careers/:id/apply`   `{ name, email, phone?, cover?, cv?: { name, mediaType, data } }`
 */
import { layout, type Mailer, mailerFromEnv } from '@kosh/mail';
import { defineModule } from '@kosh/modules-sdk';
import { recruitment } from '@kosh/recruitment';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import { cleanName, saveAttachment, storage, storageOf } from '@kosh/storage';
import { field } from '@kosh/views';
import { website } from '@kosh/website';
import type { Env } from './.kosh/bindings.js';
import { apply, publishedOpenings, takeStageEmail, websiteHiringShutro } from './module.js';

export {
  ApplicantCareers,
  type Applied,
  apply,
  OpeningCareers,
  type PublicOpening,
  publishedOpenings,
  type StageEmail,
  StageMail,
  takeStageEmail,
  websiteHiringShutro,
} from './module.js';

/** Shutro's change events: one per write, with the model, what was done and the records. */
const CHANGE_TOPIC = 'record.changed';
const HONEYPOT = 'website';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** What a CV may be: a document, never something a browser runs. */
const CV_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'text/plain': '.txt',
};
const MAX_CV_BYTES = 5_000_000;
const ATTACHABLE = new Set(['hiring.applicant']);

const invalid = (what: string): HttpProblem =>
  new HttpProblem(422, 'invalid-application', 'The application needs another look', what);
const clip = (value: unknown, size: number): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, size) : null;

function registerCareersRoutes(context: ModuleContext): void {
  const { app, shutro } = context;
  const pub = { config: { auth: false } };
  /** The site of a key and its company: read as the system, whatever the company. */
  const siteOf = async (params: unknown): Promise<{ company: number; name: string }> => {
    const key = String((params as { site?: unknown }).site ?? '');
    const site = await shutro.bootstrap({ reason: 'careers: site' }, async (raw) => {
      const env = (raw as unknown as Env).withFlags({ checkCompany: false }) as Env;
      const [found] = await env
        .model('website.site')
        .search({ where: { key } as never, limit: 1 })
        .then((rows) => rows.load({ company: true }));
      return found === undefined ? null : { company: found.company.id as number, name: found.name };
    });
    if (site === null)
      throw new HttpProblem(404, 'missing-record', 'Not found', `There is no site ${key}.`);
    return site;
  };
  /** In the site's company, as the system: a visitor has no rights of their own. */
  const inCompany = <T>(company: number, reason: string, fn: (su: Env) => Promise<T>): Promise<T> =>
    shutro.bootstrap({ reason: `careers: ${reason}`, company }, (raw) =>
      (raw as unknown as Env).asSuperuser({ reason: `careers: ${reason}` }, fn),
    );

  app.get('/api/v1/public/sites/:site/careers', pub, async (request, reply) => {
    const site = await siteOf(request.params);
    const openings = await inCompany(site.company, 'openings', (su) =>
      publishedOpenings(su, site.company),
    );
    void reply.header('cache-control', 'public, max-age=60');
    return { site: site.name, openings };
  });

  app.get('/api/v1/public/sites/:site/careers/:id', pub, async (request, reply) => {
    const site = await siteOf(request.params);
    const id = Number((request.params as { id?: unknown }).id);
    const opening = (
      await inCompany(site.company, 'opening', (su) => publishedOpenings(su, site.company))
    ).find((o) => o.id === id);
    if (opening === undefined)
      throw new HttpProblem(
        404,
        'missing-record',
        'Not found',
        'This opening is not taking applications.',
      );
    void reply.header('cache-control', 'public, max-age=60');
    return opening;
  });

  app.post(
    '/api/v1/public/sites/:site/careers/:id/apply',
    { ...pub, bodyLimit: Math.ceil(MAX_CV_BYTES * 1.4) + 64 * 1024 },
    async (request, reply) => {
      const site = await siteOf(request.params);
      const id = Number((request.params as { id?: unknown }).id);
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        throw new HttpProblem(400, 'invalid-body', 'Invalid application', 'Send it as an object.');
      const sent = body as Record<string, unknown>;
      const thanks = { message: 'Thank you — your application is in.' };
      // A field no person fills: a robot's application is thanked and dropped.
      if (String(sent[HONEYPOT] ?? '') !== '') return reply.code(201).send(thanks);
      const name = clip(sent['name'], 120);
      const email = clip(sent['email'], 200);
      if (name === null) throw invalid('Your name is needed.');
      if (email === null || !EMAIL.test(email)) throw invalid('An email address is needed.');
      const cv = sent['cv'];
      let file: { name: string; mime: string; data: Uint8Array } | null = null;
      if (cv !== undefined && cv !== null) {
        const given = cv as { name?: unknown; mediaType?: unknown; data?: unknown };
        const mime = typeof given.mediaType === 'string' ? given.mediaType : '';
        const extension = CV_TYPES[mime];
        if (extension === undefined || typeof given.data !== 'string')
          throw invalid('The CV is a PDF, a Word or OpenDocument text, or plain text.');
        const data = Buffer.from(given.data, 'base64');
        if (data.length === 0 || data.length > MAX_CV_BYTES)
          throw invalid(`The CV is at most ${MAX_CV_BYTES / 1_000_000} MB.`);
        const base = cleanName(typeof given.name === 'string' ? given.name : 'cv');
        file = {
          name: base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`,
          mime,
          data: new Uint8Array(data),
        };
      }
      const result = await inCompany(site.company, 'application', async (su) => {
        const applied = await apply(su, site.company, id, {
          name,
          email,
          phone: clip(sent['phone'], 40),
          cover: clip(sent['cover'], 5000),
        });
        if (applied.ok && file !== null)
          await saveAttachment(su as never, storageOf(app), ATTACHABLE, {
            model: 'hiring.applicant',
            id: applied.applicant,
            name: file.name,
            mime: file.mime,
            data: file.data,
          });
        return applied;
      });
      if (result.ok) return reply.code(201).send(thanks);
      if (result.why === 'duplicate')
        throw new HttpProblem(
          409,
          'already-applied',
          'Already applied',
          'An application from this email address is already in for this opening.',
        );
      throw new HttpProblem(
        410,
        'opening-closed',
        'Not taking applications',
        'This opening is not taking applications.',
      );
    },
  );
}

/** The worker that emails candidates as they reach a stage; `start()` it (the module does), tests `drain()` it. */
export function careersWorkers(
  context: Pick<ModuleContext, 'shutro'> & {
    readonly log?: (message: string, error: unknown) => void;
  },
  mailer: Mailer | undefined,
): Worker[] {
  return [
    context.shutro.subscribe(
      'website_hiring.stage_emails',
      CHANGE_TOPIC,
      async (event, env) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (payload['model'] !== 'hiring.applicant') return;
        if (payload['action'] !== 'create' && payload['action'] !== 'write') return;
        const keys = Array.isArray(payload['keys']) ? (payload['keys'] as string[]) : null;
        if (payload['action'] === 'write' && keys !== null && !keys.includes('stage')) return;
        const ids = (Array.isArray(payload['ids']) ? payload['ids'] : []).map(Number);
        await (env as unknown as Env).asSuperuser({ reason: 'candidate emails' }, async (su) => {
          for (const id of ids) {
            const mail = await takeStageEmail(su, id);
            if (mail === null || mailer === undefined) continue;
            const message = {
              to: mail.to,
              subject: mail.subject,
              ...layout({ title: mail.subject, paragraphs: mail.paragraphs }),
            };
            su.afterCommit(async () => {
              await mailer
                .send(message)
                .catch((error: unknown) => context.log?.('candidate email not sent', error));
            });
          }
        });
      },
      { pollMs: 5000 },
    ),
  ];
}

export interface CareersOptions {
  /** Sends the candidates' emails (default: from the environment; none: nothing is sent). */
  readonly mailer?: Mailer | undefined;
  /** Start the worker (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
}

/** The careers page with explicit options (tests: a memory mailer, the worker drained by hand). */
export function websiteHiringModule(options: CareersOptions = {}): ReturnType<typeof defineModule> {
  const mailer = 'mailer' in options ? options.mailer : mailerFromEnv();
  return defineModule({
    shutro: websiteHiringShutro,
    kosh: '^0.1.0',
    depends: [website, recruitment, storage],
    bridge: [website, recruitment],
    // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
    i18n: { bn: () => import('./i18n/bn.js') },
    accessLevels: {
      user: { label: 'Careers page', groups: ['website_hiring.user'] },
    },
    // A candidate is emailed when they are made an applicant and when their stage changes.
    changeEvents: ['hiring.applicant'],
    routes: (context: ModuleContext) => {
      registerCareersRoutes(context);
      if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
      const workers = careersWorkers(
        {
          shutro: context.shutro,
          log: (message, error) => context.app.log.error({ err: error }, message),
        },
        mailer,
      );
      for (const w of workers) w.start();
      context.app.addHook('onClose', async () => {
        for (const w of workers) await w.stop();
      });
    },
    viewExtensions: [
      {
        view: 'hiring.opening.form',
        operations: [
          {
            append: 'main',
            nodes: [
              field({ field: 'published', id: 'careers_published' }),
              field({ field: 'location', id: 'careers_location' }),
              field({ field: 'employment', id: 'careers_employment' }),
              field({ field: 'closingDate', id: 'careers_closing' }),
            ],
          },
        ],
      },
      {
        view: 'hiring.applicant.form',
        operations: [
          { append: 'candidate', nodes: [field({ field: 'cover', id: 'careers_cover' })] },
        ],
      },
      {
        view: 'hiring.stage.form',
        operations: [
          {
            append: 'main',
            nodes: [
              field({ field: 'mailSubject', id: 'careers_mail_subject' }),
              field({ field: 'mailBody', id: 'careers_mail_body' }),
            ],
          },
        ],
      },
    ],
  });
}

export const websiteHiring: ReturnType<typeof defineModule> = websiteHiringModule();
