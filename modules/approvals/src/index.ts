/**
 * @packageDocumentation
 * `@kosh/approvals` (RFC 0025): the **Approvals** app on the engine of `@kosh/permissions`. Everyone who decides or
 * asks has it: the inbox (cards with the record, who asked, how long it waits, every level as a step; decided one by
 * one or many at once, from the keyboard too), my requests (withdrawn while they wait), what I decided, and *Away*
 * (who decides for me while I am away); for Approvals managers, the policies — levels, who decides each and how many,
 * the deadline and who it escalates to — edited on screen. Approvers get each request by email with a link of their
 * own that opens a confirmation page; reminders at half a deadline and escalations once late, hourly.
 *
 * - `GET  /api/v1/public/approvals/:token`   the confirmation page of an email link
 * - `POST /api/v1/public/approvals/:token`   `{ decision: approve | reject | send_back, comment? }`, once
 * - `POST /api/v1/approvals/deadlines/run`   reminders and escalations now (Approvals managers; hourly too)
 * - `POST /api/v1/approvals/categories/:id/policy`  a request category's policy, made when missing (Approvals managers)
 * - `GET  /api/v1/approvals/policies/:id/preview`    which of the last 50 records each level would have asked about
 *
 * **Generic requests** (step 4): categories say what a request asks for and what it leads to; a request is decided
 * through its category's policy, and its outcome runs when approved.
 */

import { randomBytes } from 'node:crypto';
import { contacts } from '@kosh/contacts';
import { type Mailer, mailerFromEnv } from '@kosh/mail';
import { defineModule } from '@kosh/modules-sdk';
import {
  type Decision,
  decide,
  groupsOf,
  linkOf,
  permissions,
  previewPolicy,
  sweepDeadlines,
  useLink,
} from '@kosh/permissions';
import { reporting } from '@kosh/reporting';
import { digest, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env, Worker } from '@kosh/server/orm';
import { action, form, kanban, list, search } from '@kosh/views';
import { approvalsDemo } from './demo.js';
import { configureMails, mailDeciders, mailTurn } from './mails.js';
import { ApprovalAsk, ApprovalCategory, approvalsShutro, ensureCategoryPolicy } from './module.js';

export { mailDeciders, mailTurn } from './mails.js';
export {
  ApprovalAsk,
  ApprovalAskLine,
  ApprovalCategory,
  approvalsShutro,
  ensureCategoryPolicy,
  missingFields,
  outcomesOffered,
} from './module.js';

type Row = Record<string, unknown>;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DECISIONS = new Set<Decision>(['approve', 'reject', 'send_back']);

/** The subscribers that email a record's approvers when its approvals are asked and when a level is approved. */
export function approvalMailWorkers(context: Pick<ModuleContext, 'shutro'>): Worker[] {
  const turn = (name: string, topic: string) =>
    context.shutro.subscribe(
      name,
      topic,
      async (event, env) => {
        const p = (event.payload ?? {}) as Row;
        const model = String(p['model'] ?? '');
        const id = Number(p['id']);
        if (model === '' || !Number.isSafeInteger(id)) return;
        if (topic === 'approval.decided' && (p['final'] === true || p['state'] !== 'approved'))
          return;
        await (env as Env).asSuperuser({ reason: 'approval emails' }, (su) =>
          mailTurn(su, model, id),
        );
      },
      { pollMs: 5000 },
    );
  return [
    turn('approvals.asked', 'approval.requested'),
    turn('approvals.next', 'approval.decided'),
  ];
}

/** Reminders and escalations, then their emails (as the system). */
async function runDeadlines(su: Env): Promise<{ reminded: number; escalated: number }> {
  const done = await sweepDeadlines(su);
  const reminded = done.filter((d) => d.kind === 'reminded').map((d) => d.request);
  const escalated = done.filter((d) => d.kind === 'escalated').map((d) => d.request);
  await mailDeciders(su, reminded, 'reminded');
  await mailDeciders(su, escalated, 'escalated');
  return { reminded: reminded.length, escalated: escalated.length };
}

function registerApprovalAppRoutes(context: ModuleContext): void {
  const { app, shutro } = context;
  const managersOnly = (env: Env) => {
    if (!env.administrator && !env.groups.has('approvals.manager'))
      throw new HttpProblem(
        403,
        'access',
        'Approvals managers',
        'This needs the Approvals manager role.',
      );
  };
  const idParam = (params: unknown) => {
    const id = Number((params as Row)['id']);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(404, 'missing-record', 'Not found', 'No such record.');
    return id;
  };
  app.post('/api/v1/approvals/categories/:id/policy', async (request) => {
    const id = idParam(request.params);
    return request.env(
      async (raw) => {
        const env = raw as Env;
        managersOnly(env);
        return env.asSuperuser({ reason: 'request category policy' }, async (su) => ({
          policy: await ensureCategoryPolicy(su as never, id),
        }));
      },
      { write: true },
    );
  });
  app.get('/api/v1/approvals/policies/:id/preview', async (request) => {
    const id = idParam(request.params);
    return request.env(
      async (raw) => {
        const env = raw as Env;
        managersOnly(env);
        return env.asSuperuser({ reason: 'approval policy preview' }, (su) =>
          previewPolicy(su, id),
        );
      },
      { write: true },
    );
  });
  const tokenOf = (params: unknown) => String((params as Row)['token'] ?? '');
  const linkFor = (token: string) =>
    shutro.bootstrap({ reason: 'approval link' }, (raw) =>
      (raw as Env).asSuperuser({ reason: 'approval link' }, async (su) => {
        const link = await linkOf(su.withFlags({ checkCompany: false }) as Env, digest(token));
        if (link === null) return null;
        const [record] = await (
          await (
            su
              .withFlags({ checkCompany: false })
              .model(link.request.targetModel as never) as unknown as {
              search(
                q: unknown,
              ): Promise<{ load(k: string[]): Promise<{ read(k: string[]): Row[] }> }>;
            }
          ).search({ where: { id: link.request.targetId }, limit: 1 })
        )
          .load(['displayName'])
          .then((r) => r.read(['displayName']))
          .catch(() => [] as Row[]);
        return { ...link, name: String(record?.['displayName'] ?? `#${link.request.targetId}`) };
      }),
    );

  app.post('/api/v1/approvals/deadlines/run', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as Env;
        if (!env.administrator && !env.groups.has('approvals.manager'))
          throw new HttpProblem(
            403,
            'access',
            'Approvals managers',
            'This needs the Approvals manager role.',
          );
        return env.asSuperuser({ reason: 'approval deadlines' }, (su) => runDeadlines(su));
      },
      { write: true },
    ),
  );

  // The confirmation page: the request, a comment, the three answers; its script (allowed by a nonce) posts.
  app.get(
    '/api/v1/public/approvals/:token',
    { config: { auth: false } },
    async (request, reply) => {
      const link = await linkFor(tokenOf(request.params));
      if (link === null)
        throw new HttpProblem(404, 'not-found', 'Not found', 'This link is used or has expired.');
      const nonce = randomBytes(16).toString('base64');
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'`,
        )
        .header('cache-control', 'no-store')
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(link.name)}</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}textarea{width:100%;min-height:5rem;font:inherit}
button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #888;cursor:pointer;margin:.5rem .5rem 0 0}.go{background:#16a34a;color:#fff;border-color:#16a34a}.no{background:#dc2626;color:#fff;border-color:#dc2626}</style></head>
<body><h1>${escapeHtml(link.name)}</h1><p>${escapeHtml(link.request.levelName)}${link.request.required > 1 ? ` — ${link.request.approvals} of ${link.request.required} approvals so far` : ''}</p>
<label for="c">Comment (needed to reject or send back)</label><textarea id="c" maxlength="2000"></textarea>
<div><button class="go" data-d="approve">Approve</button><button data-d="send_back">Send back for changes</button><button class="no" data-d="reject">Reject</button></div>
<p id="out" role="status"></p>
<script nonce="${nonce}">for(const b of document.querySelectorAll('button[data-d]')){b.addEventListener('click',async()=>{const out=document.getElementById('out');out.textContent='Sending…';
const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:b.dataset.d,comment:document.getElementById('c').value})});
let j={};try{j=await r.json()}catch{}out.textContent=r.ok?'Done — thank you.':(j.detail||'It could not be done.');if(r.ok)for(const x of document.querySelectorAll('button'))x.disabled=true;})}</script></body></html>`);
    },
  );

  // The decision, as the link's person (their rights and the engine's checks), once; audited with the address.
  app.post(
    '/api/v1/public/approvals/:token',
    { config: { auth: false }, bodyLimit: 8 * 1024 },
    async (request) => {
      const token = tokenOf(request.params);
      const body = (request.body ?? {}) as Row;
      const decision = String(body['decision'] ?? '') as Decision;
      if (!DECISIONS.has(decision))
        throw new HttpProblem(
          400,
          'invalid-decision',
          'Invalid decision',
          'approve, reject or send_back.',
        );
      const comment =
        typeof body['comment'] === 'string' ? body['comment'].slice(0, 2000) : undefined;
      const link = await linkFor(token);
      if (link === null)
        throw new HttpProblem(404, 'not-found', 'Not found', 'This link is used or has expired.');
      const company =
        link.request.company ??
        (await shutro.bootstrap({ reason: 'approval link: company' }, async (raw) => {
          const [u] = (
            await (raw as Env)
              .model('res.users' as never)
              .browse([link.user] as never)
              .load(['company' as never])
          ).read(['company' as never]) as Row[];
          return (u?.['company'] as number | null) ?? null;
        }));
      const groups = await shutro.bootstrap({ reason: 'approval link: groups' }, (raw) =>
        groupsOf(raw as Env, link.user, company),
      );
      const decided = await shutro.run(
        {
          user: link.user,
          ...(company === null ? {} : { company, companies: [company] }),
          groups,
          reason: 'approval decided from an email link',
        } as never,
        (env) => decide(env as Env, link.request.id, decision, comment, { ip: request.ip }),
      );
      await shutro.bootstrap({ reason: 'approval link used' }, (raw) =>
        (raw as Env).asSuperuser({ reason: 'approval link used' }, (su) => useLink(su, link.id)),
      );
      return { state: decided.state };
    },
  );

  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const workers = approvalMailWorkers(context);
  for (const w of workers) w.start();
  const run = async () => {
    try {
      const companies = await shutro.bootstrap(
        { reason: 'approval deadlines' },
        async (env) =>
          (await (env as Env).model('res.company' as never).search({} as never))
            .ids as unknown as number[],
      );
      for (const company of companies)
        await shutro.bootstrap({ reason: 'approval deadlines', company }, (env) =>
          (env as Env).asSuperuser({ reason: 'approval deadlines' }, (su) => runDeadlines(su)),
        );
    } catch (error) {
      app.log.error({ err: error }, 'approval deadlines');
    }
  };
  const timer = setInterval(() => void run(), 3_600_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const w of workers) await w.stop();
  });
}

export interface ApprovalsOptions {
  /** Who sends approvers their requests; default: SMTP from the environment (`SMTP_URL`), none without it. */
  readonly mailer?: Mailer | undefined;
  /** The API's public address, which email links point to (`KOSH_API_URL`). */
  readonly apiUrl?: string;
}

/** The Approvals app with explicit options (tests: a memory mailer). */
export function approvalsModule(options: ApprovalsOptions = {}): ReturnType<typeof defineModule> {
  configureMails({
    mailer: 'mailer' in options ? options.mailer : mailerFromEnv(),
    apiUrl: (options.apiUrl ?? process.env['KOSH_API_URL'] ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    ),
  });
  return defineModule({
    shutro: approvalsShutro,
    kosh: '^0.1.0',
    hooks: { demo: approvalsDemo },
    depends: [permissions, contacts, reporting],
    app: {
      code: 'approvals',
      label: 'Approvals',
      icon: 'approvals',
      sequence: 2,
      category: 'Productivity',
      summary: 'Everything waiting for your decision, in one place — and what you asked for',
    },
    importTemplates: [
      {
        key: 'approval_ask',
        model: 'approval.ask',
        label: 'Request',
        columns: [
          { header: 'Category', field: 'category' },
          { header: 'What for', field: 'title' },
          { header: 'Asked by', field: 'requester' },
          { header: 'Description', field: 'description' },
          { header: 'Amount', field: 'amount' },
          { header: 'From', field: 'dateFrom' },
          { header: 'Until', field: 'dateTo' },
          { header: 'Contact', field: 'partner' },
          { header: 'Location', field: 'location' },
          { header: 'Quantity', field: 'quantity' },
          { header: 'Lines › Description', field: 'lines.name' },
          { header: 'Lines › Quantity', field: 'lines.quantity' },
          { header: 'Lines › Unit price', field: 'lines.priceUnit' },
        ],
      },
    ],
    events: [{ topic: 'approval.ask.approved', model: 'approval.ask', label: 'Request approved' }],
    // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
    i18n: { bn: () => import('./i18n/bn.js') },
    overview: {
      cards: [
        {
          id: 'waiting',
          title: 'Requests waiting',
          kind: 'kpi',
          model: 'approval.ask',
          measure: 'count',
          filter: { state: 'submitted' },
          w: 3,
        },
        {
          id: 'approved',
          title: 'Approved this month',
          kind: 'kpi',
          model: 'approval.ask',
          measure: 'count',
          filter: { state: 'approved' },
          comparison: { field: 'approvedAt', mode: 'previous' },
          w: 3,
        },
        {
          id: 'refused',
          title: 'Refused',
          kind: 'kpi',
          model: 'approval.ask',
          measure: 'count',
          filter: { state: 'refused' },
          w: 3,
        },
        {
          id: 'amount',
          title: 'Amount waiting',
          kind: 'kpi',
          model: 'approval.ask',
          measure: 'sum:amount',
          filter: { state: 'submitted' },
          w: 3,
        },
        {
          id: 'by_category',
          title: 'Requests by category',
          kind: 'chart',
          model: 'approval.ask',
          measure: 'count',
          groupBy: 'category',
          chart: 'bar',
          w: 6,
        },
        {
          id: 'by_state',
          title: 'Requests by state',
          kind: 'chart',
          model: 'approval.ask',
          measure: 'count',
          groupBy: 'state',
          chart: 'pie',
          w: 6,
        },
      ],
    },
    accessLevels: {
      user: { label: 'Everyone (decide and ask)', groups: ['base.user'] },
      manager: {
        label: 'Manager (policies)',
        groups: ['approvals.manager'],
        implies: ['user'],
      },
    },
    routes: (context: ModuleContext) => {
      configureMails({ log: (message, error) => context.app.log.warn({ err: error }, message) });
      registerApprovalAppRoutes(context);
    },
    documents: [
      {
        key: 'approval_request',
        name: 'Request',
        model: 'approval.ask',
        layout: {
          paper: 'A4',
          header: '{{company.name}}',
          footer: 'Page {{page}} of {{pages}}',
          blocks: [
            { kind: 'heading', id: 'title', text: 'Request {{name}}: {{title}}', level: 1 },
            {
              kind: 'fields',
              id: 'ask',
              items: [
                { label: 'Category', bind: 'category.name' },
                { label: 'Asked by', bind: 'requester.name' },
                { label: 'Amount', bind: 'amount' },
                { label: 'From', bind: 'dateFrom' },
                { label: 'Until', bind: 'dateTo' },
                { label: 'Contact', bind: 'partner.name' },
                { label: 'Location', bind: 'location' },
                { label: 'Quantity', bind: 'quantity' },
                { label: 'Status', bind: 'state' },
                { label: 'Approved on', bind: 'approvedAt' },
              ],
            },
            { kind: 'text', id: 'about', text: '{{description}}' },
            {
              kind: 'table',
              id: 'lines',
              bind: 'lines',
              columns: [
                { label: 'Description', bind: 'name' },
                { label: 'Quantity', bind: 'quantity' },
                { label: 'Unit price', bind: 'priceUnit' },
                { label: 'Amount', bind: 'subtotal' },
              ],
            },
            {
              kind: 'fields',
              id: 'total',
              items: [
                { label: 'Lines total', bind: 'linesTotal' },
                { label: 'Made', bind: 'resultName' },
              ],
            },
            { kind: 'signature', id: 'sign', labels: ['Asked by', 'Approved by'] },
          ],
        },
      },
    ],
    actions: {
      'approvals.action_inbox': { type: 'client', page: 'approvals.Inbox', label: 'To approve' },
      'approvals.action_mine': { type: 'client', page: 'approvals.Mine', label: 'My requests' },
      'approvals.action_history': {
        type: 'client',
        page: 'approvals.History',
        label: 'What I decided',
      },
      'approvals.action_away': {
        model: 'approval.delegation',
        label: 'Away',
        views: ['list', 'form'],
      },
      'approvals.action_asks': action(ApprovalAsk, {
        label: 'Requests',
        views: ['list', 'kanban', 'form'],
      }),
      'approvals.action_categories': action(ApprovalCategory, {
        label: 'Request categories',
        views: ['kanban', 'list', 'form'],
      }),
      'approvals.action_policies': {
        model: 'approval.policy',
        label: 'Policies',
        views: ['list', 'form'],
        visibleTo: ['approvals.manager'],
      },
    },
    menus: [
      { id: 'approvals.root', label: 'Approvals', app: 'approvals' },
      {
        id: 'approvals.inbox',
        parent: 'approvals.root',
        label: 'To approve',
        action: 'approvals.action_inbox',
        sequence: 1,
      },
      {
        id: 'approvals.mine',
        parent: 'approvals.root',
        label: 'My requests',
        action: 'approvals.action_mine',
        sequence: 2,
      },
      {
        id: 'approvals.history',
        parent: 'approvals.root',
        label: 'What I decided',
        action: 'approvals.action_history',
        sequence: 3,
      },
      {
        id: 'approvals.asks',
        parent: 'approvals.root',
        label: 'Requests',
        action: 'approvals.action_asks',
        sequence: 2.5,
      },
      {
        id: 'approvals.away',
        parent: 'approvals.root',
        label: 'Away',
        action: 'approvals.action_away',
        sequence: 4,
      },
      {
        id: 'approvals.configuration',
        parent: 'approvals.root',
        label: 'Configuration',
        sequence: 9,
        visibleTo: ['approvals.manager'],
      },
      {
        id: 'approvals.categories',
        parent: 'approvals.configuration',
        label: 'Request categories',
        action: 'approvals.action_categories',
        sequence: 0.5,
        visibleTo: ['approvals.manager'],
      },
      {
        id: 'approvals.policies',
        parent: 'approvals.configuration',
        label: 'Policies',
        action: 'approvals.action_policies',
        sequence: 1,
        visibleTo: ['approvals.manager'],
      },
    ],
    views: {
      'approval.delegation.list': list('approval.delegation' as never, {
        columns: ['user', 'delegate', 'dateFrom', 'dateTo', 'note'] as never,
      }),
      'approval.delegation.form': form('approval.delegation' as never, (k) => ({
        sheet: [
          k.group('main', ['user', 'delegate', 'dateFrom', 'dateTo', 'note'] as never, {
            description:
              'While you are away, the person you choose decides your approvals — in their own name, for you. They never approve their own requests.',
          }),
        ],
      })),
      'approval.ask.list': list(ApprovalAsk, {
        columns: [
          'name',
          'category',
          'title',
          'requester',
          { field: 'amount', sum: true },
          'dateFrom',
          { field: 'state', widget: 'badge' },
        ],
        decorations: {
          warning: { state: 'submitted' },
          success: { state: 'approved' },
          danger: { state: 'refused' },
        },
      }),
      'approval.ask.kanban': kanban(ApprovalAsk, {
        groupBy: 'state',
        card: {
          title: 'title',
          subtitle: 'category',
          avatar: 'requester',
          footer: ['amount', 'name'],
        },
      }),
      'approval.ask.form': form(ApprovalAsk, (k) => ({
        header: {
          statusbar: 'state',
          buttons: [
            k.button('submit', { primary: true, label: 'Submit for approval' }),
            k.button('redraft', { label: 'Set to draft' }),
            k.button('cancel', { label: 'Cancel' }),
          ],
        },
        sheet: [
          k.group('main', ['category', 'title', 'name', 'requester']),
          k.component('approvals', 'approvals.Panel'),
          k.group(
            'details',
            [
              {
                field: 'amount',
                id: 'ask_amount',
                visibleWhen: { askAmount: { ne: 'none' } },
                requiredWhen: { askAmount: 'required' },
              },
              {
                field: 'dateFrom',
                id: 'ask_dateFrom',
                visibleWhen: { askPeriod: { ne: 'none' } },
                requiredWhen: { askPeriod: 'required' },
              },
              {
                field: 'dateTo',
                id: 'ask_dateTo',
                visibleWhen: { askPeriod: { ne: 'none' } },
                requiredWhen: { askPeriod: 'required' },
              },
              {
                field: 'partner',
                id: 'ask_partner',
                visibleWhen: { askPartner: { ne: 'none' } },
                requiredWhen: { askPartner: 'required' },
              },
              {
                field: 'location',
                id: 'ask_location',
                visibleWhen: { askLocation: { ne: 'none' } },
                requiredWhen: { askLocation: 'required' },
              },
              {
                field: 'quantity',
                id: 'ask_quantity',
                visibleWhen: { askQuantity: { ne: 'none' } },
                requiredWhen: { askQuantity: 'required' },
              },
            ],
            {
              label: 'Details',
              description:
                'What the category asks for; required ones are marked. A file, when asked for, goes in the chatter.',
            },
          ),
          k.group('about', ['description'], { columns: 1 }),
          {
            ...k.lines('lines', [
              { field: 'name', id: 'line_name' },
              { field: 'quantity', id: 'line_quantity' },
              { field: 'priceUnit', id: 'line_price' },
              { field: 'subtotal', id: 'line_subtotal', sum: true },
            ]),
            visibleWhen: { askLines: { ne: 'none' } },
          },
          k.group('result', ['approvedAt', 'resultName'], {
            label: 'Outcome',
            visibleWhen: { state: 'approved' },
          }),
        ],
        chatter: true,
      })),
      'approval.category.kanban': kanban(ApprovalCategory, {
        groupBy: 'outcome',
        card: { title: 'name', subtitle: 'description', footer: ['requestCount', 'code'] },
      }),
      'approval.category.list': list(ApprovalCategory, {
        columns: ['sequence', 'code', 'name', 'outcome', 'policy', 'requestCount'],
      }),
      'approval.category.form': form(ApprovalCategory, (k) => ({
        sheet: [
          k.group('main', ['name', 'code', 'sequence', 'company']),
          k.group('about', ['description'], { columns: 1 }),
          k.group(
            'fields',
            [
              'askAmount',
              'askPeriod',
              'askPartner',
              'askLocation',
              'askQuantity',
              'askLines',
              'askAttachment',
            ],
            {
              label: 'What a request asks for',
              description: 'Not asked, optional or required; submitting checks the required ones.',
            },
          ),
          k.group('decision', ['policy', 'outcome'], {
            label: 'Who decides and what follows',
            description:
              'The policy’s levels decide (made with the first request: the requester’s manager, else an Approvals manager); edit them on the policy. The outcome runs once approved.',
          }),
          k.component('category_policy', 'approvals.CategoryPolicy'),
        ],
      })),
      'approval.policy.list': list('approval.policy' as never, {
        columns: [
          'name',
          'targetModel',
          'company',
          'onApproved',
          'reasonRequired',
          'active',
        ] as never,
      }),
      'approval.policy.form': form('approval.policy' as never, (k) => ({
        sheet: [
          k.component('preview', 'approvals.PolicyPreview'),
          k.group('main', ['name', 'targetModel', 'company', 'sequence', 'condition'] as never, {
            description:
              'A record of the model gets one approval per level whose condition it meets; levels with a lower sequence are decided first, those with the same side by side.',
          }),
          k.group(
            'outcomes',
            [
              'onApproved',
              'onRejected',
              'onSentBack',
              'onWithdrawn',
              'reasonRequired',
              'whenNobody',
            ] as never,
            {
              label: 'What happens',
              description:
                'The transitions of the record run when it is approved, rejected, sent back or withdrawn.',
            },
          ),
          k.lines(
            'levels' as never,
            [
              { field: 'sequence', id: 'level_sequence' },
              { field: 'name', id: 'level_name' },
              { field: 'approverKind', id: 'level_kind' },
              { field: 'approverRole', id: 'level_role' },
              { field: 'approverUsers', id: 'level_users', widget: 'tags' },
              { field: 'approverField', id: 'level_field' },
              { field: 'extraUsers', id: 'level_extra', widget: 'tags' },
              { field: 'quorum', id: 'level_quorum' },
              { field: 'quorumCount', id: 'level_count' },
              { field: 'deadlineHours', id: 'level_deadline' },
              { field: 'escalateRole', id: 'level_escalate' },
            ] as never,
          ),
        ],
      })),
    },
    search: {
      'approval.delegation': search('approval.delegation' as never, {
        fields: ['user.name', 'delegate.name'] as never,
        groupBy: ['user', 'delegate'] as never,
      }),
      'approval.ask': search(ApprovalAsk, {
        fields: ['title', 'name', 'requester.name'],
        filters: {
          mine: { label: 'Mine', domain: { requester: { $env: 'uid' } } },
          waiting: {
            label: 'Waiting for approval',
            domain: { state: 'submitted' },
            group: 'state',
          },
          approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' },
        },
        groupBy: ['category', 'state', 'requester'],
      }),
      'approval.category': search(ApprovalCategory, {
        fields: ['name', 'code'],
        groupBy: ['outcome'],
      }),
      'approval.policy': search('approval.policy' as never, {
        fields: ['name', 'targetModel'] as never,
        groupBy: ['targetModel'] as never,
      }),
    },
  });
}

/** The Approvals app (mail from the environment). */
export const approvals: ReturnType<typeof defineModule> = approvalsModule();
