/**
 * @packageDocumentation
 * `@kosh/documents` (RFC 0024 §2.8): the **Documents** app. Folders (open, or kept to their members), documents with
 * tags and versions, one search over documents and every record's attachments, share links with an expiry and an
 * optional password, and requests that ask a person for a file by email and take it into the right folder.
 *
 * - `POST /api/v1/documents/upload?folder=&name=`         the raw body is the file (`X-Filename`): a new document
 * - `POST /api/v1/documents/:id/versions`                 a new version (the raw body)
 * - `GET  /api/v1/documents/:id/versions`                 its versions, newest first
 * - `GET  /api/v1/documents/search?q=`                    documents and record attachments the user may read
 * - `POST /api/v1/documents/shares`                       `{ document | folder, days?, password? }` → `{ url }`
 * - `POST /api/v1/documents/requests/remind`              the late requests reminded now (managers; hourly too)
 * - `GET  /api/v1/public/documents/shares/:token`         what a link shares (`x-share-password` when it has one)
 * - `GET  /api/v1/public/documents/shares/:token/documents/:id`   a shared document's file
 * - `GET|POST /api/v1/public/documents/requests/:token`   the upload page of a request; its file (the raw body)
 */

import { randomBytes } from 'node:crypto';
import { contacts } from '@kosh/contacts';
import { type Mailer, mailerFromEnv } from '@kosh/mail';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { cleanName, storageOf } from '@kosh/storage';
import { action, form, kanban, list, search } from '@kosh/views';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Env } from './.kosh/bindings.js';
import { documentsDemo } from './demo.js';
import {
  addVersion,
  configureRequests,
  fulfil,
  keyOf,
  makeShare,
  openShare,
  remindRequests,
  requestOf,
  searchAll,
  versionsOf,
} from './documents.js';
import {
  DocumentsDocument,
  DocumentsFolder,
  DocumentsRequest,
  DocumentsShare,
  DocumentsTag,
  documentsShutro,
} from './module.js';

export {
  addVersion,
  fulfil,
  makeShare,
  openShare,
  remindRequests,
  searchAll,
  versionsOf,
} from './documents.js';
export {
  DocumentsDocument,
  DocumentsFolder,
  DocumentsRequest,
  DocumentsShare,
  DocumentsTag,
  documentsShutro,
} from './module.js';

type Row = Record<string, unknown>;
const MAX_UPLOAD = 25 * 1024 * 1024;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const positive = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new HttpProblem(400, 'invalid-id', `Invalid ${what}`, `A ${what} id.`);
  return n;
};
const fileOf = (request: FastifyRequest) => {
  const body = request.body;
  if (!(body instanceof Uint8Array) || body.byteLength === 0)
    throw new HttpProblem(400, 'invalid-body', 'Empty file', 'The request body is the file.');
  const header = request.headers['x-filename'];
  let name = 'file';
  try {
    name = cleanName(decodeURIComponent(typeof header === 'string' ? header : 'file'));
  } catch {
    throw new HttpProblem(400, 'invalid-name', 'Invalid file name', 'X-Filename is URI-encoded.');
  }
  return { name, mime: request.headers['content-type'], data: body };
};

function registerDocumentRoutes(context: ModuleContext, apiUrl: string): void {
  const { app, shutro } = context;
  const needs = (env: Env, group: string, who: string) => {
    if (!env.administrator && !env.groups.has(group))
      throw new HttpProblem(403, 'access', who, `This needs the ${who} role.`);
  };
  /** Public reads and writes: as the system, across companies (the link names the record). */
  const asSystem = <T>(reason: string, fn: (env: Env) => Promise<T>): Promise<T> =>
    shutro.bootstrap({ reason: `documents: ${reason}` }, (raw) =>
      (raw as unknown as Env).asSuperuser({ reason: `documents: ${reason}` }, (su) =>
        fn(su.withFlags({ checkCompany: false }) as unknown as Env),
      ),
    );

  // Files arrive as the raw body, whatever their type (own parsers in an encapsulated context).
  app.register(async (uploads: FastifyInstance) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD },
      (_r, body, done) => done(null, body),
    );
    uploads.post('/api/v1/documents/upload', async (request, reply) => {
      const q = (request.query ?? {}) as Row;
      const folder = positive(q['folder'], 'folder');
      const file = fileOf(request);
      const made = await request.env(
        async (raw) => {
          const env = raw as unknown as Env;
          needs(env, 'documents.user', 'Documents user');
          const created = await env.model('documents.document').create([
            {
              name: typeof q['name'] === 'string' && q['name'] !== '' ? q['name'] : file.name,
              folder: orm.asId(folder, 'documents.folder'),
            },
          ]);
          await env.flush();
          const id = created.ids[0] as number;
          const version = await addVersion(env, storageOf(app), id, file);
          return { id, versions: version.versions };
        },
        { write: true },
      );
      return reply.status(201).send(made);
    });
    uploads.post('/api/v1/documents/:id/versions', async (request, reply) => {
      const id = positive((request.params as Row)['id'], 'document');
      const file = fileOf(request);
      const made = await request.env(
        async (raw) => {
          const env = raw as unknown as Env;
          needs(env, 'documents.user', 'Documents user');
          return addVersion(env, storageOf(app), id, file);
        },
        { write: true },
      );
      return reply.status(201).send(made);
    });
    uploads.post(
      '/api/v1/public/documents/requests/:token',
      { config: { auth: false } },
      async (request, reply) => {
        const token = String((request.params as Row)['token'] ?? '');
        const file = fileOf(request);
        const company = await asSystem('request', async (env) => {
          const [r] = await (
            await env
              .model('documents.request')
              .search({ where: { id: (await requestOf(env, token))?.id ?? 0 } as never, limit: 1 })
          ).load({ company: true });
          return r?.company.id ?? null;
        });
        if (company === null)
          throw new HttpProblem(
            404,
            'not-found',
            'Not found',
            'There is no open request for this link.',
          );
        const done = await shutro.bootstrap(
          { reason: 'documents: a requested file', company },
          (raw) =>
            (raw as unknown as Env).asSuperuser({ reason: 'documents: a requested file' }, (su) =>
              fulfil(su, storageOf(app), token, file),
            ),
        );
        return reply.status(201).send({ received: true, document: done.document });
      },
    );
  });

  app.get('/api/v1/documents/:id/versions', async (request) => {
    const id = positive((request.params as Row)['id'], 'document');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        needs(env, 'documents.user', 'Documents user');
        return { versions: await versionsOf(env, id) };
      },
      { write: true },
    );
  });

  app.get('/api/v1/documents/search', async (request) => {
    const q = String(((request.query ?? {}) as Row)['q'] ?? '');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        needs(env, 'documents.user', 'Documents user');
        return searchAll(env, q, async (model, id) => {
          try {
            const found = await (
              env.model(model as never) as unknown as {
                search(q: unknown): Promise<{ length: number }>;
              }
            ).search({ where: { id }, limit: 1 });
            return found.length > 0;
          } catch {
            return false;
          }
        });
      },
      { write: true },
    );
  });

  app.post('/api/v1/documents/shares', async (request, reply) => {
    const body = (request.body ?? {}) as Row;
    const made = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        needs(env, 'documents.user', 'Documents user');
        return makeShare(env, {
          ...(body['document'] === undefined
            ? {}
            : { document: positive(body['document'], 'document') }),
          ...(body['folder'] === undefined ? {} : { folder: positive(body['folder'], 'folder') }),
          ...(body['days'] === undefined ? {} : { days: Number(body['days']) }),
          ...(typeof body['password'] === 'string' ? { password: body['password'] } : {}),
        });
      },
      { write: true },
    );
    return reply.status(201).send({
      url: `${apiUrl}/api/v1/public/documents/shares/${made.token}`,
      expiresAt: made.expiresAt,
    });
  });

  const passwordOf = (request: FastifyRequest) =>
    String(request.headers['x-share-password'] ?? '').slice(0, 200);
  app.get(
    '/api/v1/public/documents/shares/:token',
    { config: { auth: false } },
    async (request) => {
      const token = String((request.params as Row)['token'] ?? '');
      const opened = await asSystem('share', (env) => openShare(env, token, passwordOf(request)));
      return {
        documents: opened.documents.map((d) => ({
          id: d.id,
          name: d.name,
          mime: d.mime,
          size: d.size,
        })),
      };
    },
  );
  app.get(
    '/api/v1/public/documents/shares/:token/documents/:id',
    { config: { auth: false } },
    async (request, reply) => {
      const token = String((request.params as Row)['token'] ?? '');
      const id = positive((request.params as Row)['id'], 'document');
      const file = await asSystem('shared file', async (env) => {
        const opened = await openShare(env, token, passwordOf(request));
        const doc = opened.documents.find((d) => d.id === id);
        if (doc === undefined || doc.attachment === null) return null;
        const key = await keyOf(env, doc.attachment);
        const [share] = await env
          .model('documents.share')
          .browse([opened.share as never])
          .load({});
        await env
          .model('documents.share')
          .browse([opened.share as never])
          .write({ downloads: (share?.downloads ?? 0) + 1 });
        await env.flush();
        return key === null
          ? null
          : { key, name: doc.name, mime: doc.mime ?? 'application/octet-stream' };
      });
      if (file === null)
        throw new HttpProblem(
          404,
          'not-found',
          'Not found',
          'This link does not share that document.',
        );
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(await storageOf(app).read(file.key));
    },
  );

  // A request's upload page: what is asked, a file input; its script (with this response's nonce) sends the file.
  app.get(
    '/api/v1/public/documents/requests/:token',
    { config: { auth: false } },
    async (request, reply) => {
      const token = String((request.params as Row)['token'] ?? '');
      const open = await asSystem('request page', (env) => requestOf(env, token));
      if (open === null)
        throw new HttpProblem(
          404,
          'not-found',
          'Not found',
          'There is no open request for this link.',
        );
      const nonce = randomBytes(16).toString('base64');
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'`,
        )
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(open.name)}</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #888;cursor:pointer;margin-top:1rem}</style></head>
<body><h1>${escapeHtml(open.company)}</h1><p>${escapeHtml(open.company)} asks you for: <strong>${escapeHtml(open.name)}</strong></p>
${open.message === null ? '' : `<p>${escapeHtml(open.message)}</p>`}
<label for="file">Your file</label><br><input id="file" type="file"><br><button id="send" type="button">Send</button><p id="out" role="status"></p>
<script nonce="${nonce}">document.getElementById('send').addEventListener('click',async()=>{const f=document.getElementById('file').files[0];const out=document.getElementById('out');if(!f){out.textContent='Choose a file first.';return}out.textContent='Sending…';const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':f.type||'application/octet-stream','x-filename':encodeURIComponent(f.name)},body:f});out.textContent=r.ok?'Received — thank you.':'It could not be sent: '+r.status;});</script></body></html>`);
    },
  );

  app.post('/api/v1/documents/requests/remind', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        needs(env, 'documents.manager', 'Documents manager');
        return {
          reminded: await env.asSuperuser({ reason: 'document requests' }, (su) =>
            remindRequests(su),
          ),
        };
      },
      { write: true },
    ),
  );

  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const run = async () => {
    try {
      const companies = await shutro.bootstrap(
        { reason: 'document requests' },
        async (env) => (await (env as unknown as Env).model('res.company').search({})).ids,
      );
      for (const company of companies)
        await shutro.bootstrap({ reason: 'document requests', company }, (env) =>
          (env as unknown as Env).asSuperuser({ reason: 'document requests' }, (su) =>
            remindRequests(su),
          ),
        );
    } catch (error) {
      app.log.error({ err: error }, 'document requests');
    }
  };
  const timer = setInterval(() => void run(), 3_600_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

export interface DocumentsOptions {
  /** Who sends the requests; default: SMTP from the environment (`SMTP_URL`), none without it. */
  readonly mailer?: Mailer | undefined;
  /** The API's public address, which request and share links point to (`KOSH_API_URL`). */
  readonly apiUrl?: string;
}

/** Documents with explicit options (tests: a memory mailer). */
export function documentsModule(options: DocumentsOptions = {}): ReturnType<typeof defineModule> {
  const apiUrl = (options.apiUrl ?? process.env['KOSH_API_URL'] ?? 'http://localhost:3000').replace(
    /\/$/,
    '',
  );
  configureRequests({ mailer: 'mailer' in options ? options.mailer : mailerFromEnv(), apiUrl });
  return defineModule({
    shutro: documentsShutro,
    kosh: '^0.1.0',
    hooks: { demo: documentsDemo },
    depends: [contacts, messaging, reporting],
    app: {
      code: 'documents',
      label: 'Documents',
      icon: 'documents',
      sequence: 30,
      category: 'Productivity',
      summary:
        'Folders, versions, share links and requests for files — one search with every record’s files',
    },
    documents: [
      {
        key: 'document_request',
        name: 'Document request',
        model: 'documents.request',
        layout: {
          paper: 'A4',
          header: '{{company.name}}',
          footer: 'Page {{page}} of {{pages}}',
          blocks: [
            { kind: 'heading', id: 'title', text: 'Document request: {{name}}', level: 1 },
            {
              kind: 'fields',
              id: 'request',
              items: [
                { label: 'Asked of', bind: 'partner.name' },
                { label: 'Email', bind: 'email' },
                { label: 'Folder', bind: 'folder.name' },
                { label: 'Due', bind: 'dueDate' },
                { label: 'Sent', bind: 'sentAt' },
                { label: 'Status', bind: 'state' },
              ],
            },
            { kind: 'text', id: 'message', text: '{{message}}' },
          ],
        },
      },
    ],
    importTemplates: [
      {
        key: 'documents_folder',
        model: 'documents.folder',
        label: 'Folder',
        columns: [
          { header: 'Name', field: 'name' },
          { header: 'Inside', field: 'parent' },
          { header: 'Owner', field: 'owner' },
          { header: 'Members only', field: 'restricted' },
          { header: 'Members', field: 'members' },
          { header: 'Description', field: 'description' },
        ],
      },
      {
        key: 'documents_request',
        model: 'documents.request',
        label: 'Document request',
        columns: [
          { header: 'What is asked for', field: 'name' },
          { header: 'Into', field: 'folder' },
          { header: 'From', field: 'partner' },
          { header: 'Email', field: 'email' },
          { header: 'Message', field: 'message' },
          { header: 'Due', field: 'dueDate' },
        ],
      },
    ],
    standard: {
      waive: [
        {
          rule: 'I1',
          model: 'documents.document',
          reason: 'Files are uploaded, not imported from a sheet.',
        },
      ],
    },
    // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
    i18n: { bn: () => import('./i18n/bn.js') },
    overview: {
      cards: [
        {
          id: 'documents',
          title: 'Documents',
          kind: 'kpi',
          model: 'documents.document',
          measure: 'count',
          comparison: { field: 'createdAt', mode: 'previous' },
          w: 3,
        },
        {
          id: 'requests_waiting',
          title: 'Requests waiting for a file',
          kind: 'kpi',
          model: 'documents.request',
          measure: 'count',
          filter: { state: 'sent' },
          w: 3,
        },
        {
          id: 'requests_received',
          title: 'Files received',
          kind: 'kpi',
          model: 'documents.request',
          measure: 'count',
          filter: { state: 'received' },
          w: 3,
        },
        {
          id: 'folders',
          title: 'Folders',
          kind: 'kpi',
          model: 'documents.folder',
          measure: 'count',
          w: 3,
        },
        {
          id: 'by_folder',
          title: 'Documents by folder',
          kind: 'chart',
          model: 'documents.document',
          measure: 'count',
          groupBy: 'folder',
          chart: 'bar',
          w: 6,
        },
        {
          id: 'requests_by_state',
          title: 'Requests by state',
          kind: 'chart',
          model: 'documents.request',
          measure: 'count',
          groupBy: 'state',
          chart: 'pie',
          w: 6,
        },
      ],
    },
    accessLevels: {
      user: { label: 'User', groups: ['documents.user'] },
      manager: {
        label: 'Manager (every folder)',
        groups: ['documents.manager'],
        implies: ['user'],
      },
    },
    attachable: ['documents.document'],
    routes: (context: ModuleContext) => registerDocumentRoutes(context, apiUrl),
    events: [
      {
        topic: 'documents.request.received',
        model: 'documents.request',
        label: 'Requested file received',
      },
    ],
    actions: {
      'documents.action_documents': action(DocumentsDocument, {
        label: 'Documents',
        views: ['kanban', 'list', 'form'],
      }),
      'documents.action_folders': action(DocumentsFolder, {
        label: 'Folders',
        views: ['list', 'form'],
      }),
      'documents.action_requests': action(DocumentsRequest, {
        label: 'Requests',
        views: ['list', 'form'],
        defaultFilters: ['open'],
      }),
      'documents.action_shares': action(DocumentsShare, { label: 'Share links', views: ['list'] }),
      'documents.action_tags': action(DocumentsTag, { label: 'Tags', views: ['list'] }),
    },
    menus: [
      { id: 'documents.root', label: 'Documents', app: 'documents' },
      {
        id: 'documents.documents',
        parent: 'documents.root',
        label: 'Documents',
        action: 'documents.action_documents',
        sequence: 1,
      },
      {
        id: 'documents.folders',
        parent: 'documents.root',
        label: 'Folders',
        action: 'documents.action_folders',
        sequence: 2,
      },
      {
        id: 'documents.requests',
        parent: 'documents.root',
        label: 'Requests',
        action: 'documents.action_requests',
        sequence: 3,
      },
      {
        id: 'documents.shares',
        parent: 'documents.root',
        label: 'Share links',
        action: 'documents.action_shares',
        sequence: 4,
      },
      {
        id: 'documents.configuration',
        parent: 'documents.root',
        label: 'Configuration',
        sequence: 9,
      },
      {
        id: 'documents.tags',
        parent: 'documents.configuration',
        label: 'Tags',
        action: 'documents.action_tags',
        sequence: 1,
      },
    ],
    views: {
      'documents.document.kanban': kanban(DocumentsDocument, {
        groupBy: 'folder',
        card: { title: 'name', subtitle: 'folder', footer: ['mime', 'versions'] },
      }),
      'documents.document.list': list(DocumentsDocument, {
        columns: [
          'name',
          'folder',
          { field: 'tags', widget: 'tags' },
          'mime',
          'size',
          'versions',
          'owner',
          'updatedAt',
        ],
      }),
      'documents.document.form': form(DocumentsDocument, (k) => ({
        sheet: [
          k.group('main', ['name', 'folder', 'tags', 'owner'], {
            description: 'Each upload is a new version; the latest is the document’s file.',
          }),
          { kind: 'component', id: 'document_versions', component: 'documents.Versions' },
          k.group('about', [
            'description',
            'resModel',
            'resId',
            'request',
            'mime',
            'size',
            'versions',
          ]),
        ],
        chatter: true,
      })),
      'documents.folder.list': list(DocumentsFolder, {
        columns: ['fullName', 'restricted', 'owner'],
      }),
      'documents.folder.form': form(DocumentsFolder, (k) => ({
        sheet: [
          k.group('main', ['name', 'parent', 'owner', 'restricted'], {
            description:
              'A folder kept to its members is seen by them and its owner (and Documents managers).',
          }),
          k.group('people', ['members'], { columns: 1 }),
          k.group('about', ['description'], { columns: 1 }),
        ],
        chatter: true,
      })),
      'documents.request.list': list(DocumentsRequest, {
        columns: [
          'name',
          'partner',
          'email',
          'folder',
          'dueDate',
          { field: 'state', widget: 'badge' },
        ],
      }),
      'documents.request.form': form(DocumentsRequest, (k) => ({
        header: {
          statusbar: 'state',
          buttons: [
            k.button('send', { primary: true, label: 'Send the request' }),
            k.button('cancel', { label: 'Cancel' }),
            k.button('redraft', { label: 'Back to draft' }),
          ],
        },
        sheet: [
          k.group('main', ['name', 'partner', 'email', 'folder', 'dueDate'], {
            description:
              'The person gets a link by email that uploads the file into the folder; reminded once when late.',
          }),
          k.group('about', ['message'], { columns: 1 }),
          k.group('outcome', ['sentAt', 'remindedAt', 'document']),
        ],
        chatter: true,
      })),
      'documents.share.list': list(DocumentsShare, {
        columns: ['document', 'folder', 'expiresAt', 'downloads', 'revoked', 'createdBy'],
        inlineEdit: ['revoked'],
      }),
      'documents.tag.list': list(DocumentsTag, {
        columns: ['name', 'color'],
        inlineEdit: ['name', 'color'],
      }),
      'documents.tag.form': form(DocumentsTag, (k) => ({
        sheet: [k.group('main', ['name', 'color'])],
      })),
    },
    search: {
      'documents.document': search(DocumentsDocument, {
        fields: ['name', 'description', 'folder.name', 'tags.name'],
        filters: { mine: { label: 'Mine', domain: { owner: { $env: 'uid' } } } },
        groupBy: ['folder', 'owner', 'mime'],
      }),
      'documents.folder': search(DocumentsFolder, { fields: ['name'], groupBy: ['parent'] }),
      'documents.request': search(DocumentsRequest, {
        fields: ['name', 'email', 'partner.name'],
        filters: {
          open: { label: 'Waiting', domain: { state: { in: ['draft', 'sent'] } }, group: 'state' },
          received: { label: 'Received', domain: { state: 'received' }, group: 'state' },
        },
        groupBy: ['state', 'folder'],
      }),
      'documents.share': search(DocumentsShare, { fields: ['document.name', 'folder.name'] }),
      'documents.tag': search(DocumentsTag, { fields: ['name'] }),
    },
  });
}

/** Documents (mail from the environment). */
export const documents: ReturnType<typeof defineModule> = documentsModule();
