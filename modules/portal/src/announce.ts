/**
 * Telling customers about new documents (RFC 0015 §5.7): when a record enters a declared document's `announce`
 * domain (a quotation sent, an invoice posted), the portal users who can see it get an email with a link to it in
 * the portal — once per record and document type (`portal.announcement`). It reads Shutro's `record.changed`
 * events, so the models must be in a module's `changeEvents` (the bridges list theirs).
 */
import { layout, type Mailer } from '@kosh/mail';
import { type ModuleContext, publicApiModels } from '@kosh/server';
import type { Env, Worker } from '@kosh/server/orm';
import { type PortalDocument, portalDocuments } from './documents.js';

type Row = Record<string, unknown>;
interface Records {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
}
interface Ref {
  search(q: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly unknown[]): Promise<Records>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** The topic of Shutro's change events. */
export const CHANGE_TOPIC = 'record.changed';

const TEXTS = {
  en: {
    intro: (label: string, name: string) => `A new document is ready for you: ${label} ${name}.`,
    open: 'Open it in the portal',
  },
  bn: {
    intro: (label: string, name: string) => `আপনার জন্য একটি নতুন নথি প্রস্তুত: ${label} ${name}।`,
    open: 'পোর্টালে খুলুন',
  },
} as const;

/** The contact a record is for (following a path such as `project.partner`), or null. */
async function partnerOf(
  su: Env,
  models: ReturnType<typeof publicApiModels>,
  model: string,
  id: number,
  path: string,
): Promise<number | null> {
  let currentModel = model;
  let currentId = id;
  for (const segment of path.split('.')) {
    const loaded = await ref(su, currentModel).browse([currentId]).load([segment]);
    const rows: Row[] = loaded.read([segment]);
    const next: unknown = rows[0]?.[segment];
    const target = models.get(currentModel)?.byKey.get(segment)?.target ?? null;
    if (typeof next !== 'number' || target === null) return null;
    currentModel = target;
    currentId = next;
  }
  return currentId;
}

/** The active portal users who see documents of `partner`: theirs, their company's, their colleagues'. */
async function recipientsOf(su: Env, partner: number) {
  const [row] = (await ref(su, 'res.partner').browse([partner]).load(['parent'])).read(['parent']);
  const company = typeof row?.['parent'] === 'number' ? (row['parent'] as number) : null;
  const heads = company === null ? [partner] : [partner, company];
  const people = await ref(su, 'res.partner').search({ where: { parent: { in: heads } } });
  const partners = [...new Set([...heads, ...people.ids])];
  const users = await ref(su, 'res.users').search({
    where: { portalPartner: { in: partners }, active: true },
  });
  return (await users.load(['login', 'name', 'lang'])).read(['login', 'name', 'lang']);
}

/** The subscriber that announces documents; `start()` it (the module does), tests `drain()` it. */
export function portalAnnouncer(
  context: ModuleContext,
  options: { readonly portalUrl: string; readonly mailer?: Mailer | undefined },
): Worker {
  const models = publicApiModels(context.registry);
  const announced = [...portalDocuments(context.registry).values()].filter(
    (d): d is PortalDocument & { spec: { announce: Readonly<Record<string, unknown>> } } =>
      d.spec.announce !== undefined,
  );
  return context.shutro.subscribe(
    'portal.announce',
    CHANGE_TOPIC,
    async (event, env) => {
      const payload = (event.payload ?? {}) as Row;
      const model = String(payload['model'] ?? '');
      const ids = Array.isArray(payload['ids'])
        ? (payload['ids'] as unknown[]).filter((i): i is number => typeof i === 'number')
        : [];
      const documents = announced.filter((d) => d.model.name === model);
      if (documents.length === 0 || ids.length === 0) return;
      await env.asSuperuser({ reason: 'portal announcement' }, async (su) => {
        for (const d of documents) {
          const found = await ref(su, model).search({
            where: { and: [{ id: { in: ids } }, d.spec.domain ?? {}, d.spec.announce] },
          });
          for (const id of found.ids) {
            const already = await ref(su, 'portal.announcement').search({
              where: { resModel: model, resId: id, document: d.spec.key },
              limit: 1,
            });
            if (already.length > 0) continue;
            const partner = await partnerOf(su, models, model, id, d.spec.partner);
            const users = partner === null ? [] : await recipientsOf(su, partner);
            await ref(su, 'portal.announcement').create([
              { resModel: model, resId: id, document: d.spec.key, recipients: users.length },
            ]);
            const mailer = options.mailer;
            if (mailer === undefined || users.length === 0) continue;
            const [record] = (await ref(su, model).browse([id]).load(['displayName'])).read([
              'displayName',
            ]);
            const [company] = (
              await ref(su, 'res.company').browse([env.companyId]).load(['name'])
            ).read(['name']);
            const name = String(record?.['displayName'] ?? `#${id}`);
            const from = String(company?.['name'] ?? '');
            const url = `${options.portalUrl.replace(/\/$/, '')}/d/${d.spec.key}/${id}`;
            const mails = users.map((u) => {
              const texts = String(u['lang'] ?? '').startsWith('bn') ? TEXTS.bn : TEXTS.en;
              const subject = `${from}: ${d.spec.label} ${name}`;
              return {
                to: String(u['login']),
                subject,
                ...layout({
                  title: subject,
                  paragraphs: [texts.intro(d.spec.label, name)],
                  action: { label: texts.open, url },
                  lang: String(u['lang'] ?? 'en').slice(0, 2),
                }),
              };
            });
            // Sent once the announcement is committed; a failed send is logged, not retried.
            env.afterCommit(async () => {
              for (const mail of mails)
                await mailer
                  .send(mail)
                  .catch((error: unknown) =>
                    context.app.log.error({ err: error }, 'portal announcement not sent'),
                  );
            });
          }
        }
        await su.flush();
      });
    },
    { pollMs: 5000 },
  );
}
