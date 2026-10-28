/**
 * The portal's documents API (RFC 0015 §5.3–5.5), for portal users only:
 *
 * - `GET  /api/portal/v1/home`                               per document type: what needs the user, and counts
 * - `GET  /api/portal/v1/documents`                          the document types (and how many the user has)
 * - `GET  /api/portal/v1/documents/:key?q=&offset=&limit=`   a list: the declared list fields
 * - `GET  /api/portal/v1/documents/:key/:id`                 a document: the declared fields, lines, actions
 * - `GET  /api/portal/v1/documents/:key/:id/pdf`             its PDF, from the declared template
 * - `POST /api/portal/v1/documents/:key/:id/actions/:action` `{ signature?: { name, image }, message? }`
 * - `GET  /api/portal/v1/documents/:key/:id/thread`          its comments (never notes, activities or the log)
 * - `POST /api/portal/v1/documents/:key/:id/thread`          `{ body }`: a comment, its followers notified
 *
 * Which records: always a search **as the portal user**, so the model's portal record rule decides, narrowed by the
 * declared domain; another customer's document is 404. What of them: only the declared fields, read once the record
 * is known to be theirs (relations as their names). Actions run their transition in a system transaction once the
 * checks passed — the system confirms on the customer's word, as an employee would — so the apps' own reactions
 * (tasks of a confirmed order) run with the rights they need; the signature, the thread and the audit name the
 * portal user.
 */
import { createHash } from 'node:crypto';
import { chatterContext, postExternalMessage } from '@kosh/messaging';
import { documentFields, renderDocument } from '@kosh/reporting';
import { audit, HttpProblem, idempotent, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';
import { type PortalDocument, portalDocuments } from './documents.js';

type Row = Record<string, unknown>;
interface Records {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[] | Readonly<Record<string, true>>): Promise<Records>;
  read(keys: readonly string[]): Row[];
}
interface Ref {
  search(q: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly unknown[]): Promise<Records>;
  aggregate(q: unknown): Promise<readonly Row[]>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** Largest drawn signature accepted (a PNG data URL, decoded). */
const MAX_SIGNATURE_BYTES = 300_000;
const ATTENTION_ITEMS = 5;

export function registerPortalDocumentRoutes(context: ModuleContext): void {
  const { app, driver } = context;
  const documents = portalDocuments(context.registry);
  const printable = documentFields(
    new Map([...documents.values()].map((d) => [d.model.name, d.model])),
  );
  const chatter = chatterContext(context);

  const portalOnly = (env: Env) => {
    if (!env.groups.has('portal.user') || env.groups.has('base.user'))
      throw new HttpProblem(403, 'portal-only', 'Portal users only', 'This is the portal’s API.');
  };
  const documentOf = (params: unknown): PortalDocument => {
    const key = String((params as Row)['key'] ?? '');
    const document = documents.get(key);
    if (document === undefined)
      throw new HttpProblem(404, 'not-found', 'No such document type', `No documents '${key}'.`);
    return document;
  };
  const idOf = (params: unknown): number => {
    const id = Number((params as Row)['id']);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(404, 'not-found', 'No such document', 'No such document.');
    return id;
  };
  /** The declared records the user may see, narrowed by `extra`. */
  const scope = (d: PortalDocument, extra: Row = {}): Row => ({
    and: [d.spec.domain ?? {}, extra],
  });
  /** Whether record `id` is the user's (searched as the user: the record rule decides). */
  const mine = async (env: Env, d: PortalDocument, id: number) => {
    const found = await ref(env, d.model.name).search({ where: scope(d, { id }), limit: 1 });
    if (found.length === 0)
      throw new HttpProblem(404, 'not-found', 'No such document', `No ${d.spec.label} #${id}.`);
  };

  /** Field descriptions of `keys` of `model`, for the screen. */
  const meta = (model: PortalDocument['model'], keys: readonly string[]) =>
    keys.map((key) => {
      const f = model.byKey.get(key);
      return {
        key,
        label: f?.label ?? key,
        kind: f?.kind ?? 'char',
        ...(f?.options === null || f?.options === undefined
          ? {}
          : { options: f.options.map(([value, label]) => ({ value, label })) }),
      };
    });
  /** `keys` of `ids` read as the system (the records are known to be the user's): relations as names. */
  const values = async (
    su: Env,
    model: PortalDocument['model'],
    ids: readonly number[],
    keys: readonly string[],
  ): Promise<Row[]> => {
    if (ids.length === 0) return [];
    const loaded = await ref(su, model.name)
      .browse(ids)
      .load([...keys]);
    const rows = loaded.read([...keys]);
    for (const key of keys) {
      const field = model.byKey.get(key);
      if (field?.kind !== 'many2one' && field?.kind !== 'many2many') continue;
      const targetIds = [
        ...new Set(rows.flatMap((r) => (Array.isArray(r[key]) ? r[key] : [r[key]]) as unknown[])),
      ].filter((v): v is number => typeof v === 'number');
      const names = new Map<number, string>();
      if (targetIds.length > 0 && field.target !== null)
        for (const t of (await ref(su, field.target).browse(targetIds).load(['displayName'])).read([
          'displayName',
        ]))
          names.set(t['id'] as number, String(t['displayName'] ?? ''));
      const named = (v: unknown) =>
        typeof v === 'number' ? { id: v, name: names.get(v) ?? '' } : null;
      for (const r of rows)
        r[key] =
          field.kind === 'many2one' ? named(r[key]) : ((r[key] as number[]) ?? []).map(named);
    }
    return rows;
  };
  /** The actions `when` allows on record `id`. */
  const available = async (su: Env, d: PortalDocument, id: number) => {
    const out = [];
    for (const action of d.spec.actions ?? [])
      if (
        (await ref(su, d.model.name).search({ where: { and: [{ id }, action.when] }, limit: 1 }))
          .length > 0
      )
        out.push({
          key: action.key,
          label: action.label,
          signature: action.signature === true,
          message: action.message === true,
        });
    return out;
  };
  /** The document as the user sees it: what a signature's hash covers. */
  const documentOfRecord = async (su: Env, d: PortalDocument, id: number) => {
    const [record] = await values(su, d.model, [id], d.spec.fields);
    let lines: Row[] = [];
    if (d.spec.lines !== undefined && d.lineModel !== null) {
      const [withLines] = (
        await ref(su, d.model.name)
          .browse([id])
          .load({ [d.spec.lines.field]: true })
      ).read([d.spec.lines.field]);
      const lineIds = (withLines?.[d.spec.lines.field] as number[] | undefined) ?? [];
      lines = await values(su, d.lineModel, lineIds, d.spec.lines.fields);
    }
    return { record: record ?? { id }, lines };
  };
  const run = <T>(request: FastifyRequest, fn: (env: Env, su: Env) => Promise<T>) =>
    request.env(
      (env) => {
        portalOnly(env);
        return env.asSuperuser({ reason: 'portal read' }, (su) => fn(env, su));
      },
      { write: true },
    );

  app.get('/api/portal/v1/documents', async (request) =>
    run(request, async (env) => {
      const out = [];
      for (const d of documents.values()) {
        const [row] = await ref(env, d.model.name).aggregate({
          where: scope(d),
          measures: { count: 'count' },
        });
        out.push({ key: d.spec.key, label: d.spec.label, count: Number(row?.['count'] ?? 0) });
      }
      return { documents: out };
    }),
  );

  app.get('/api/portal/v1/home', async (request) =>
    run(request, async (env, su) => {
      const sections = [];
      for (const d of documents.values()) {
        if (d.spec.attention === undefined) continue;
        const found = await ref(env, d.model.name).search({
          where: scope(d, d.spec.attention),
          ...(d.spec.order === undefined ? {} : { order: d.spec.order }),
          limit: ATTENTION_ITEMS,
        });
        const [count] = await ref(env, d.model.name).aggregate({
          where: scope(d, d.spec.attention),
          measures: { count: 'count' },
        });
        sections.push({
          key: d.spec.key,
          label: d.spec.label,
          count: Number(count?.['count'] ?? 0),
          fields: meta(d.model, d.spec.list),
          items: await values(su, d.model, found.ids, d.spec.list),
        });
      }
      return { sections };
    }),
  );

  app.get('/api/portal/v1/documents/:key', async (request) => {
    const d = documentOf(request.params);
    const q = (request.query ?? {}) as Row;
    const limit = Math.min(Math.max(Number(q['limit'] ?? 30) || 30, 1), 100);
    const offset = Math.max(Number(q['offset'] ?? 0) || 0, 0);
    const text = typeof q['q'] === 'string' ? q['q'].trim().slice(0, 100) : '';
    const recName = d.model.recName ?? 'name';
    const where = scope(
      d,
      text === '' ? {} : { [recName]: { ilike: `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%` } },
    );
    return run(request, async (env, su) => {
      const found = await ref(env, d.model.name).search({
        where,
        ...(d.spec.order === undefined ? {} : { order: d.spec.order }),
        limit,
        offset,
      });
      const [count] = await ref(env, d.model.name).aggregate({
        where,
        measures: { count: 'count' },
      });
      return {
        key: d.spec.key,
        label: d.spec.label,
        fields: meta(d.model, d.spec.list),
        items: await values(su, d.model, found.ids, d.spec.list),
        count: Number(count?.['count'] ?? 0),
      };
    });
  });

  app.get('/api/portal/v1/documents/:key/:id', async (request) => {
    const d = documentOf(request.params);
    const id = idOf(request.params);
    return run(request, async (env, su) => {
      await mine(env, d, id);
      const { record, lines } = await documentOfRecord(su, d, id);
      return {
        key: d.spec.key,
        label: d.spec.label,
        fields: meta(d.model, d.spec.fields),
        record,
        ...(d.spec.lines === undefined || d.lineModel === null
          ? {}
          : { lineFields: meta(d.lineModel, d.spec.lines.fields), lines }),
        actions: await available(su, d, id),
        payable:
          d.spec.payment !== undefined &&
          (
            await ref(su, d.model.name).search({
              where: { and: [{ id }, d.spec.payment.when] },
              limit: 1,
            })
          ).length > 0,
        pdf: d.spec.pdf !== undefined,
        thread: d.spec.thread === true,
      };
    });
  });

  app.get('/api/portal/v1/documents/:key/:id/pdf', async (request, reply) => {
    const d = documentOf(request.params);
    const id = idOf(request.params);
    const template = d.spec.pdf;
    if (template === undefined)
      throw new HttpProblem(404, 'not-found', 'No PDF', `${d.spec.label} have no PDF.`);
    const rendered = await run(request, async (env, su) => {
      await mine(env, d, id);
      const keys = ['name', 'layout', 'scope'];
      const found = await ref(su, 'report.template').search({
        where: { key: template, targetModel: d.model.name, active: true },
        limit: 1,
      });
      const [row] = (await found.load(keys)).read(keys);
      if (row === undefined)
        throw new HttpProblem(
          404,
          'not-found',
          'No PDF',
          `The template ${template} is not installed.`,
        );
      // The company's printed document of a record that is the user's: printed as the system.
      return renderDocument(su, d.model, row, printable, { ids: [id] }, 'pdf');
    });
    return reply
      .header('content-type', rendered.mime)
      .header(
        'content-disposition',
        `attachment; filename="${rendered.filename.replace(/["\\\r\n]/g, '_')}"`,
      )
      .send(rendered.content);
  });

  app.post('/api/portal/v1/documents/:key/:id/actions/:action', async (request, reply) => {
    const d = documentOf(request.params);
    const id = idOf(request.params);
    const key = String((request.params as Row)['action'] ?? '');
    const action = (d.spec.actions ?? []).find((a) => a.key === key);
    if (action === undefined)
      throw new HttpProblem(
        404,
        'not-found',
        'No such action',
        `${d.spec.label} have no '${key}'.`,
      );
    const body = (request.body ?? {}) as Row;
    const message = typeof body['message'] === 'string' ? body['message'].trim() : '';
    if (action.message === true && message === '')
      throw new HttpProblem(422, 'message-required', 'Say why', 'Write a message for this action.');
    const signature = (body['signature'] ?? null) as Row | null;
    const signedName = typeof signature?.['name'] === 'string' ? signature['name'].trim() : '';
    let image: Uint8Array | null = null;
    if (action.signature === true) {
      const data = typeof signature?.['image'] === 'string' ? signature['image'] : '';
      const png = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(data);
      if (signedName === '' || signedName.length > 200 || png === null)
        throw new HttpProblem(
          422,
          'signature-required',
          'Sign first',
          'Type your name and draw your signature.',
        );
      image = new Uint8Array(Buffer.from(png[1] as string, 'base64'));
      if (image.byteLength > MAX_SIGNATURE_BYTES || image.byteLength === 0)
        throw new HttpProblem(422, 'signature-too-large', 'Signature too large', 'Draw it again.');
    }
    const outcome = await request.env(
      (env) =>
        idempotent(request, env, driver, async () => {
          portalOnly(env);
          await mine(env, d, id);
          const who = await env.asSuperuser({ reason: 'portal action' }, async (su) => {
            if (!(await available(su, d, id)).some((a) => a.key === key))
              throw new HttpProblem(
                409,
                'not-available',
                'Not possible any more',
                `${action.label} is not possible on this document now.`,
              );
            const [user] = (
              await ref(su, 'res.users').browse([env.uid]).load(['login', 'name'])
            ).read(['login', 'name']);
            const seen = await documentOfRecord(su, d, id);
            return {
              login: String(user?.['login'] ?? ''),
              name: String(user?.['name'] ?? ''),
              hash: createHash('sha256').update(JSON.stringify(seen)).digest('hex'),
            };
          });
          // The transition and its record, as the system, in one transaction of their own.
          await context.shutro.bootstrap(
            { reason: `portal ${d.spec.key} ${key} by ${who.login}`, company: env.companyId },
            async (su) => {
              const target = ref(su, d.model.name).browse([id]) as unknown as Record<
                string,
                () => Promise<void>
              >;
              await (target[action.transition] as () => Promise<void>).call(target);
              let signatureId: number | null = null;
              if (image !== null) {
                const created = await ref(su, 'portal.signature').create([
                  {
                    resModel: d.model.name,
                    resId: id,
                    action: key,
                    user: env.uid,
                    signedName,
                    image,
                    documentHash: who.hash,
                    ip: request.ip,
                    company: env.companyId,
                  },
                ]);
                signatureId = created.ids[0] ?? null;
              }
              const text = [
                image === null
                  ? `${action.label} by ${who.name} in the portal.`
                  : `${action.label} by ${who.name} in the portal, signed as “${signedName}”.`,
                message,
              ]
                .filter((t) => t !== '')
                .join('\n\n');
              await postExternalMessage(su, chatter, d.model.name, id, {
                text,
                authorEmail: who.login,
                authorName: who.name,
              });
              await audit(su, {
                kind: 'portal.action',
                summary: `${who.name} (${who.login}): ${action.label} on ${d.model.name} #${id} in the portal.`,
                actor: env.uid,
                company: env.companyId,
                targetModel: d.model.name,
                targetId: id,
                details: { action: key, signature: signatureId, documentHash: who.hash },
                ip: request.ip,
              });
              await su.flush(); // checks run in this scope, not at commit (Shutro request #11)
            },
          );
          return { status: 200, body: { done: key } };
        }),
      { write: true },
    );
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get('/api/portal/v1/documents/:key/:id/thread', async (request) => {
    const d = documentOf(request.params);
    const id = idOf(request.params);
    if (d.spec.thread !== true)
      throw new HttpProblem(404, 'not-found', 'No thread', `${d.spec.label} have no thread.`);
    return run(request, async (env, su) => {
      await mine(env, d, id);
      const keys = ['body', 'author', 'authorName', 'createdAt'];
      const found = await ref(su, 'mail.message').search({
        where: { resModel: d.model.name, resId: id, kind: 'comment' },
        order: ['id desc'],
        limit: 100,
      });
      const rows = (await found.load(keys)).read(keys);
      const authors = [
        ...new Set(rows.map((r) => r['author']).filter((a) => typeof a === 'number')),
      ];
      const names = new Map<number, string>();
      if (authors.length > 0)
        for (const u of (
          await ref(su, 'res.users')
            .browse(authors as number[])
            .load(['name'])
        ).read(['name']))
          names.set(u['id'] as number, String(u['name']));
      return {
        messages: rows.map((r) => ({
          id: r['id'],
          at: r['createdAt'],
          body: r['body'],
          author:
            typeof r['author'] === 'number'
              ? (names.get(r['author']) ?? '')
              : String(r['authorName'] ?? ''),
          mine: r['author'] === env.uid,
        })),
      };
    });
  });

  app.post('/api/portal/v1/documents/:key/:id/thread', async (request, reply) => {
    const d = documentOf(request.params);
    const id = idOf(request.params);
    if (d.spec.thread !== true)
      throw new HttpProblem(404, 'not-found', 'No thread', `${d.spec.label} have no thread.`);
    const text = String(((request.body ?? {}) as Row)['body'] ?? '').trim();
    if (text === '')
      throw new HttpProblem(400, 'invalid-body', 'Empty message', 'Write something first.');
    const posted = await run(request, async (env, su) => {
      await mine(env, d, id);
      const [user] = (await ref(su, 'res.users').browse([env.uid]).load(['login', 'name'])).read([
        'login',
        'name',
      ]);
      const item = await postExternalMessage(su, chatter, d.model.name, id, {
        text,
        authorEmail: String(user?.['login'] ?? ''),
        authorName: String(user?.['name'] ?? ''),
      });
      return {
        id: item.id,
        at: item.at,
        body: item.body,
        author: item.authorName ?? '',
        mine: true,
      };
    });
    return reply.code(201).send(posted);
  });
}
