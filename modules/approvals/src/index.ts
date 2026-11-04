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
 */
import { randomBytes } from 'node:crypto';
import { type Mailer, mailerFromEnv } from '@kosh/mail';
import { defineModule } from '@kosh/modules-sdk';
import {
  type Decision,
  decide,
  groupsOf,
  linkOf,
  permissions,
  sweepDeadlines,
  useLink,
} from '@kosh/permissions';
import { digest, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env, Worker } from '@kosh/server/orm';
import { form, list, search } from '@kosh/views';
import { configureMails, mailDeciders, mailTurn } from './mails.js';
import { approvalsShutro } from './module.js';

export { mailDeciders, mailTurn } from './mails.js';
export { approvalsShutro } from './module.js';

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
    depends: [permissions],
    app: {
      code: 'approvals',
      label: 'Approvals',
      icon: 'approvals',
      sequence: 2,
      category: 'Productivity',
      summary: 'Everything waiting for your decision, in one place — and what you asked for',
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
          k.group('main', ['name', 'targetModel', 'company', 'sequence'] as never, {
            description:
              'A record of the model gets one approval per level whose condition it meets; levels with a lower sequence are decided first, those with the same side by side.',
          }),
          k.group(
            'outcomes',
            ['onApproved', 'onRejected', 'onSentBack', 'onWithdrawn', 'reasonRequired'] as never,
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
      'approval.policy': search('approval.policy' as never, {
        fields: ['name', 'targetModel'] as never,
        groupBy: ['targetModel'] as never,
      }),
    },
  });
}

/** The Approvals app (mail from the environment). */
export const approvals: ReturnType<typeof defineModule> = approvalsModule();
