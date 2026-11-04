/**
 * @packageDocumentation
 * `@kosh/sign` (RFC 0024 §2.8): the **Sign** app. Templates (a PDF with fields per signer's role), requests from a
 * template — from any record — with signers in order or all at once, each by email link and a one-time code, signing
 * in the browser (a phone too), and the PDF sealed with the signatures and a certificate page, stored in Documents
 * and on the record. pdf-lib (MIT, no native code) stamps and seals.
 *
 * - `POST /api/v1/sign/templates/:id/pdf`         the raw body is the template's PDF (managers)
 * - `POST /api/v1/sign/requests`                  `{ template, model?, id?, ordered?, signers: [{ role, name, email }] }`
 * - `GET  /api/v1/public/sign/:token`             the signing page
 * - `GET  /api/v1/public/sign/:token/pdf`         the PDF to sign
 * - `POST /api/v1/public/sign/:token/code`        a one-time code by email
 * - `POST /api/v1/public/sign/:token/sign`        `{ code, values: { <field id>: text | true | PNG data URL } }`
 * - `POST /api/v1/public/sign/:token/refuse`      `{ code, reason }`
 */
import { randomBytes } from 'node:crypto';
import { contacts } from '@kosh/contacts';
import { documents } from '@kosh/documents';
import { type Mailer, mailerFromEnv } from '@kosh/mail';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { storageOf } from '@kosh/storage';
import { action, form, list, search } from '@kosh/views';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Env } from './.kosh/bindings.js';
import { SignRequest, SignTemplate, signShutro } from './module.js';
import {
  configureSign,
  refuseWith,
  requestFrom,
  sendCode,
  setTemplatePdf,
  signerOf,
  signWith,
  templatePdf,
  WrongCode,
} from './sign.js';

export { SignRequest, SignSigner, SignTemplate, SignTemplateField, signShutro } from './module.js';
export { requestFrom, sha256, signerOf } from './sign.js';

type Row = Record<string, unknown>;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function registerSignRoutes(context: ModuleContext): void {
  const { app, shutro } = context;
  configureSign({ storage: () => storageOf(app) });
  const needs = (env: Env, group: string, who: string) => {
    if (!env.administrator && !env.groups.has(group))
      throw new HttpProblem(403, 'access', who, `This needs the ${who} role.`);
  };
  /** A link's work, as the system in the request's company (the link names the signer). */
  const bySigner = async <T>(
    token: string,
    reason: string,
    fn: (env: Env) => Promise<T>,
  ): Promise<T> => {
    const company = await shutro.bootstrap({ reason: `sign: ${reason}` }, (raw) =>
      (raw as unknown as Env).asSuperuser({ reason: `sign: ${reason}` }, async (su) => {
        const s = await signerOf(su.withFlags({ checkCompany: false }) as unknown as Env, token);
        if (s === null) return null;
        const [r] = await (su.withFlags({ checkCompany: false }) as unknown as Env)
          .model('sign.request')
          .browse([s.request.id as never])
          .load({ company: true });
        return r?.company.id ?? null;
      }),
    );
    if (company === null)
      throw new HttpProblem(
        404,
        'not-found',
        'Not found',
        'There is no signature waiting for this link.',
      );
    // A wrong code is counted in this transaction, which commits; the 401 comes after.
    const result = await shutro.bootstrap({ reason: `sign: ${reason}`, company }, (raw) =>
      (raw as unknown as Env).asSuperuser({ reason: `sign: ${reason}` }, async (su) => {
        try {
          return { ok: true as const, value: await fn(su) };
        } catch (error) {
          if (error instanceof WrongCode) return { ok: false as const };
          throw error;
        }
      }),
    );
    if (!result.ok)
      throw new HttpProblem(401, 'wrong-code', 'Wrong code', 'The code is wrong or has expired.');
    return result.value;
  };
  const tokenOf = (request: FastifyRequest) => String((request.params as Row)['token'] ?? '');

  app.register(async (uploads: FastifyInstance) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 },
      (_r, body, done) => done(null, body),
    );
    uploads.post('/api/v1/sign/templates/:id/pdf', async (request) => {
      const id = Number((request.params as Row)['id']);
      const body = request.body;
      if (!(body instanceof Uint8Array) || body.byteLength === 0)
        throw new HttpProblem(400, 'invalid-body', 'Empty file', 'The request body is the PDF.');
      return request.env(
        async (raw) => {
          const env = raw as unknown as Env;
          needs(env, 'sign.manager', 'Sign manager');
          const found = await env
            .model('sign.template')
            .search({ where: { id: id as never }, limit: 1 });
          if (found.length === 0)
            throw new HttpProblem(404, 'not-found', 'Not found', `There is no template ${id}.`);
          return env.asSuperuser({ reason: 'sign: a template’s PDF' }, (su) =>
            setTemplatePdf(su, id, { name: 'template.pdf', data: body }),
          );
        },
        { write: true },
      );
    });
  });

  app.post('/api/v1/sign/requests', async (request, reply) => {
    const b = (request.body ?? {}) as Row;
    const signers = Array.isArray(b['signers']) ? (b['signers'] as Row[]) : [];
    const id = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        needs(env, 'sign.user', 'Sign user');
        // The record it is signed from must be one the user may read.
        if (typeof b['model'] === 'string') {
          const found = await (
            env.model(b['model'] as never) as unknown as {
              search(q: unknown): Promise<{ length: number }>;
            }
          )
            .search({ where: { id: Number(b['id']) }, limit: 1 })
            .catch(() => ({ length: 0 }));
          if (found.length === 0)
            throw new HttpProblem(
              404,
              'not-found',
              'Not found',
              'There is no such record to sign from.',
            );
        }
        return requestFrom(env, {
          template: Number(b['template']),
          ...(typeof b['name'] === 'string' ? { name: b['name'] } : {}),
          ...(typeof b['model'] === 'string' ? { model: b['model'], id: Number(b['id']) } : {}),
          ...(typeof b['ordered'] === 'boolean' ? { ordered: b['ordered'] } : {}),
          ...(typeof b['message'] === 'string' ? { message: b['message'] } : {}),
          signers: signers.map((s) => ({
            role: String(s['role'] ?? ''),
            name: String(s['name'] ?? ''),
            email: String(s['email'] ?? ''),
            ...(s['partner'] === undefined ? {} : { partner: Number(s['partner']) }),
          })),
        });
      },
      { write: true },
    );
    return reply.status(201).send({ id });
  });

  const pub = { config: { auth: false } };
  app.get('/api/v1/public/sign/:token/pdf', pub, async (request, reply) => {
    const bytes = await bySigner(tokenOf(request), 'the PDF', async (env) => {
      const s = await signerOf(env, tokenOf(request));
      if (s === null) return null;
      const [r] = await env
        .model('sign.request')
        .browse([s.request.id as never])
        .load({});
      return r === undefined ? null : templatePdf(env, r.template.id);
    });
    if (bytes === null)
      throw new HttpProblem(404, 'not-found', 'Not found', 'No PDF for this link.');
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', 'inline; filename="document.pdf"')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(bytes));
  });
  app.post('/api/v1/public/sign/:token/code', pub, async (request) => {
    await bySigner(tokenOf(request), 'a code', (env) => sendCode(env, tokenOf(request)));
    return { sent: true };
  });
  app.post(
    '/api/v1/public/sign/:token/sign',
    { ...pub, bodyLimit: 1024 * 1024 },
    async (request) => {
      const b = (request.body ?? {}) as Row;
      const values =
        b['values'] !== null && typeof b['values'] === 'object' ? (b['values'] as Row) : {};
      return bySigner(tokenOf(request), 'signing', (env) =>
        signWith(env, tokenOf(request), {
          code: String(b['code'] ?? ''),
          values,
          ip: request.ip,
          userAgent: String(request.headers['user-agent'] ?? ''),
        }),
      );
    },
  );
  app.post('/api/v1/public/sign/:token/refuse', pub, async (request) => {
    const b = (request.body ?? {}) as Row;
    await bySigner(tokenOf(request), 'refusing', (env) =>
      refuseWith(env, tokenOf(request), {
        code: String(b['code'] ?? ''),
        reason: String(b['reason'] ?? ''),
      }),
    );
    return { refused: true };
  });

  // The signing page: the PDF, the signer's fields, a code by email, a pad to draw the signature (a phone too).
  app.get('/api/v1/public/sign/:token', pub, async (request, reply) => {
    const token = tokenOf(request);
    const s = await bySigner(token, 'the page', (env) => signerOf(env, token));
    if (s === null)
      throw new HttpProblem(
        404,
        'not-found',
        'Not found',
        'There is no signature waiting for this link.',
      );
    const nonce = randomBytes(16).toString('base64');
    const input = (f: (typeof s.fields)[number]) => {
      const label = escapeHtml(f.label ?? f.kind);
      const req = f.required ? ' required' : '';
      if (f.kind === 'date') return `<p>${label}: <em>today, when you sign</em></p>`;
      if (f.kind === 'checkbox')
        return `<p><label><input type="checkbox" data-field="${f.id}"${req}> ${label}</label></p>`;
      if (f.kind === 'text')
        return `<p><label>${label}<br><input type="text" maxlength="200" data-field="${f.id}"${req}></label></p>`;
      return `<p>${label} (draw it)<br><canvas data-field="${f.id}" data-pad width="360" height="${f.kind === 'initials' ? 90 : 140}" aria-label="${label}"></canvas><br><button type="button" data-clear="${f.id}">Clear</button></p>`;
    };
    return reply
      .type('text/html; charset=utf-8')
      .header(
        'content-security-policy',
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; img-src 'self' data:`,
      )
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(s.request.name)}</title><style>body{font:16px system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}canvas{background:#fff}}iframe{width:100%;height:60vh;border:1px solid #888}
canvas{border:1px dashed #888;touch-action:none;max-width:100%;background:#fff}button{font:inherit;padding:.5rem .9rem;border-radius:.5rem;border:1px solid #888;cursor:pointer;margin:.25rem .25rem 0 0}
.go{background:#16a34a;color:#fff;border-color:#16a34a}</style></head>
<body><h1>${escapeHtml(s.request.name)}</h1><p>${escapeHtml(s.request.company)} asks <strong>${escapeHtml(s.name)}</strong> to sign as ${escapeHtml(s.role)}.</p>
${s.request.message === null ? '' : `<p>${escapeHtml(s.request.message)}</p>`}
<iframe title="The document" src="${escapeHtml(request.url.split('?')[0] ?? '')}/pdf"></iframe>
<h2>Your part</h2>${s.fields.map(input).join('\n')}
<p><button type="button" id="code">Email me a code</button></p>
<p><label>Code<br><input id="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label></p>
<p><button type="button" class="go" id="sign">Sign</button> <button type="button" id="refuse">Refuse</button></p>
<p id="out" role="status"></p>
<script nonce="${nonce}">
const base=location.pathname;const out=document.getElementById('out');
for(const c of document.querySelectorAll('canvas[data-pad]')){const x=c.getContext('2d');x.lineWidth=2.5;x.lineCap='round';let on=false;c.dataset.drawn='';
const at=(e)=>{const r=c.getBoundingClientRect();return[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]};
c.addEventListener('pointerdown',(e)=>{on=true;c.setPointerCapture(e.pointerId);const[a,b]=at(e);x.beginPath();x.moveTo(a,b)});
c.addEventListener('pointermove',(e)=>{if(!on)return;const[a,b]=at(e);x.lineTo(a,b);x.stroke();c.dataset.drawn='1'});
c.addEventListener('pointerup',()=>{on=false});}
for(const b of document.querySelectorAll('[data-clear]')){b.addEventListener('click',()=>{const c=document.querySelector('canvas[data-field="'+b.dataset.clear+'"]');c.getContext('2d').clearRect(0,0,c.width,c.height);c.dataset.drawn=''})}
const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});let j={};try{j=await r.json()}catch{}return[r.ok,j]};
document.getElementById('code').addEventListener('click',async()=>{const[ok]=await post('/code');out.textContent=ok?'A code is on its way to your email.':'The code could not be sent.'});
document.getElementById('sign').addEventListener('click',async()=>{const values={};
for(const i of document.querySelectorAll('input[data-field]')){values[i.dataset.field]=i.type==='checkbox'?i.checked:i.value}
for(const c of document.querySelectorAll('canvas[data-field]')){if(c.dataset.drawn)values[c.dataset.field]=c.toDataURL('image/png')}
const[ok,j]=await post('/sign',{code:document.getElementById('otp').value,values});out.textContent=ok?(j.completed?'Signed — everyone has signed; a copy is on its way.':'Signed — thank you.'):(j.detail||'It could not be signed.')});
document.getElementById('refuse').addEventListener('click',async()=>{const reason=prompt('Why do you refuse?');if(!reason)return;const[ok,j]=await post('/refuse',{code:document.getElementById('otp').value,reason});out.textContent=ok?'Refused.':(j.detail||'It could not be refused.')});
</script></body></html>`);
  });
}

export interface SignOptions {
  /** Who sends the links and codes; default: SMTP from the environment (`SMTP_URL`), none without it. */
  readonly mailer?: Mailer | undefined;
  /** The API's public address, which signing links point to (`KOSH_API_URL`). */
  readonly apiUrl?: string;
}

/** Sign with explicit options (tests: a memory mailer). */
export function signModule(options: SignOptions = {}): ReturnType<typeof defineModule> {
  configureSign({
    mailer: 'mailer' in options ? options.mailer : mailerFromEnv(),
    apiUrl: (options.apiUrl ?? process.env['KOSH_API_URL'] ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    ),
  });
  return defineModule({
    shutro: signShutro,
    kosh: '^0.1.0',
    depends: [contacts, messaging, documents],
    app: {
      code: 'sign',
      label: 'Sign',
      icon: 'sign',
      sequence: 31,
      category: 'Productivity',
      summary:
        'Signatures in order or all at once, one-time codes, a sealed PDF with its certificate',
    },
    documents: [
      {
        key: 'signature_request',
        name: 'Signature request',
        model: 'sign.request',
        layout: {
          paper: 'A4',
          header: '{{company.name}}',
          footer: 'Page {{page}} of {{pages}}',
          blocks: [
            { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
            {
              kind: 'fields',
              id: 'request',
              items: [
                { label: 'Template', bind: 'template.name' },
                { label: 'In order', bind: 'ordered' },
                { label: 'Completed', bind: 'completedAt' },
                { label: 'Status', bind: 'state' },
                { label: 'Refused because', bind: 'refusal' },
              ],
            },
            { kind: 'text', id: 'message', text: '{{message}}' },
            {
              kind: 'table',
              id: 'signers',
              bind: 'signers',
              columns: [
                { label: 'Role', bind: 'role' },
                { label: 'Name', bind: 'name' },
                { label: 'Email', bind: 'email' },
                { label: 'Sent', bind: 'sentAt' },
                { label: 'Signed', bind: 'signedAt' },
                { label: 'Status', bind: 'state' },
              ],
            },
          ],
        },
      },
    ],
    importTemplates: [
      {
        key: 'sign_template',
        model: 'sign.template',
        label: 'Signing template',
        columns: [
          { header: 'Name', field: 'name' },
          { header: 'Pages', field: 'pages' },
          { header: 'Description', field: 'description' },
        ],
      },
    ],
    standard: {
      waive: [
        {
          rule: 'I1',
          model: 'sign.request',
          reason: 'Sent from a template to its signers; a file cannot sign.',
        },
      ],
    },
    accessLevels: {
      user: { label: 'User (send requests)', groups: ['sign.user'] },
      manager: { label: 'Manager (templates)', groups: ['sign.manager'], implies: ['user'] },
    },
    attachable: ['sign.template', 'sign.request'],
    routes: (context: ModuleContext) => registerSignRoutes(context),
    events: [{ topic: 'sign.request.signed', model: 'sign.request', label: 'Signed by everyone' }],
    actions: {
      'sign.action_requests': action(SignRequest, {
        label: 'Requests',
        views: ['list', 'form'],
        defaultFilters: ['open'],
      }),
      'sign.action_templates': action(SignTemplate, {
        label: 'Templates',
        views: ['list', 'form'],
      }),
    },
    menus: [
      { id: 'sign.root', label: 'Sign', app: 'sign' },
      {
        id: 'sign.requests',
        parent: 'sign.root',
        label: 'Requests',
        action: 'sign.action_requests',
        sequence: 1,
      },
      {
        id: 'sign.templates',
        parent: 'sign.root',
        label: 'Templates',
        action: 'sign.action_templates',
        sequence: 2,
      },
    ],
    views: {
      'sign.template.list': list(SignTemplate, { columns: ['name', 'pages', 'attachment'] }),
      'sign.template.form': form(SignTemplate, (k) => ({
        sheet: [
          k.group('main', ['name', 'pages', 'attachment'], {
            description:
              'Upload the PDF, then place each field: its page, and where it starts and how big it is as fractions of the page.',
          }),
          k.lines('fields', [
            { field: 'role', id: 'field_role' },
            { field: 'kind', id: 'field_kind' },
            { field: 'label', id: 'field_label' },
            { field: 'page', id: 'field_page' },
            { field: 'x', id: 'field_x' },
            { field: 'y', id: 'field_y' },
            { field: 'width', id: 'field_width' },
            { field: 'height', id: 'field_height' },
            { field: 'required', id: 'field_required' },
          ]),
          k.group('about', ['description'], { columns: 1 }),
        ],
        chatter: true,
      })),
      'sign.request.list': list(SignRequest, {
        columns: [
          'name',
          'template',
          'resModel',
          { field: 'state', widget: 'badge' },
          'completedAt',
        ],
      }),
      'sign.request.form': form(SignRequest, (k) => ({
        header: {
          statusbar: 'state',
          buttons: [
            k.button('send', { primary: true, label: 'Send for signature' }),
            k.button('cancel', {
              label: 'Cancel',
              confirm: 'Cancel this request? Its links stop working.',
            }),
          ],
        },
        sheet: [
          k.group('main', ['name', 'template', 'ordered', 'resModel', 'resId'], {
            description:
              'Each signer gets a link of their own and confirms with a code sent to their email; in order, the next is asked once the one before has signed.',
          }),
          k.lines('signers', [
            { field: 'role', id: 'signer_role' },
            { field: 'name', id: 'signer_name' },
            { field: 'email', id: 'signer_email' },
            { field: 'sequence', id: 'signer_sequence' },
            { field: 'state', id: 'signer_state' },
            { field: 'signedAt', id: 'signer_signed_at' },
          ]),
          k.group('about', ['message'], { columns: 1 }),
          k.group('outcome', [
            'completedAt',
            'sealed',
            'document',
            'hashBefore',
            'hashAfter',
            'refusal',
          ]),
        ],
        chatter: true,
      })),
    },
    search: {
      'sign.request': search(SignRequest, {
        fields: ['name', 'signers.name', 'signers.email'],
        filters: {
          open: {
            label: 'Out for signature',
            domain: { state: { in: ['draft', 'sent'] } },
            group: 'state',
          },
          signed: { label: 'Signed', domain: { state: 'signed' }, group: 'state' },
        },
        groupBy: ['state', 'template'],
      }),
      'sign.template': search(SignTemplate, { fields: ['name'] }),
    },
  });
}

/** Sign (mail from the environment). */
export const sign: ReturnType<typeof defineModule> = signModule();
