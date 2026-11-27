/**
 * @packageDocumentation
 * `@kosh/marketing`: Campaigns (RFC 0038, step 3) — mailing lists and their subscribers, the never-email list,
 * and email campaigns to lists and tagged contacts, with two subjects to try, opens, clicks and unsubscribes.
 *
 * - `GET  /api/v1/public/campaigns/o/:token.gif`  the pixel that counts an open (no sign-in)
 * - `GET  /api/v1/public/campaigns/c/:token/:n`   counts a click and redirects to the campaign's link `n`
 * - `GET  /api/v1/public/campaigns/u/:token`      the unsubscribe page (changes nothing)
 * - `POST /api/v1/public/campaigns/u/:token`      unsubscribes (the page's button, a mail client's one click)
 * - `POST /api/v1/campaigns/:id/test`             `{ to }`: the message as one person would get it, not counted
 */
import { contacts } from '@kosh/contacts';
import { BOUNCE_TOPIC, type Mailer, mailerFromEnv } from '@kosh/mail';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, form, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { marketingDemo } from './demo.js';
import {
  bouncedDeliveries,
  companyOfToken,
  MarketingCampaign,
  MarketingDelivery,
  MarketingLink,
  MarketingList,
  MarketingSubscriber,
  MarketingSuppression,
  marketingShutro,
  markFailed,
  recordBounce,
  recordClick,
  recordOpen,
  SEND_JOB,
  START_JOB,
  saveProviderIds,
  setCampaignTransport,
  takeBatch,
  unsubscribe,
  unsubscribeView,
} from './module.js';
import { PAGE_SECURITY, renderUnsubscribe } from './page.js';
import { compose, emailKey, linksOf, type MailLanguage } from './render.js';

export {
  addressCampaign,
  bouncedDeliveries,
  hashToken,
  MarketingCampaign,
  MarketingDelivery,
  MarketingLink,
  MarketingList,
  MarketingSubscriber,
  MarketingSuppression,
  marketingShutro,
  markFailed,
  type Outgoing,
  recordBounce,
  recordClick,
  recordOpen,
  refreshStats,
  SEND_BATCH,
  SEND_JOB,
  START_JOB,
  saveProviderIds,
  setCampaignTransport,
  takeBatch,
  trackingOf,
  unsubscribe,
  unsubscribeView,
} from './module.js';
export { PAGE_SECURITY, renderUnsubscribe } from './page.js';
export {
  type Composed,
  compose,
  emailKey,
  linksOf,
  type MailLanguage,
  percent,
  personalize,
  type Recipient,
  type Tracking,
  variantOf,
} from './render.js';

/** What `shutro.work` gives back: a worker tests drain and the server starts. */
interface Worker {
  drain(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

interface Transport {
  readonly mailer: Mailer | undefined;
  /** The address people reach the server at: the links of a message start with it. */
  readonly baseUrl: string;
}

/**
 * The worker of Campaigns: each job takes one batch of a campaign in its own transaction — the messages marked
 * sent —, enqueues the next, and hands the batch to the mailer once it has committed; what the mail server
 * refuses is marked so. A scheduled campaign is started at its time, as the person who scheduled it.
 */
export function campaignWorker(
  context: Pick<ModuleContext, 'shutro'> & {
    readonly log?: (message: string, error: unknown) => void;
  },
  transport: Transport,
): Worker {
  const { mailer } = transport;
  const base = transport.baseUrl.replace(/\/+$/, '');
  return context.shutro.work(
    {
      [SEND_JOB]: async (payload, raw) => {
        if (mailer === undefined || base === '') return;
        const { campaign, round } = payload as { campaign: number; round?: number };
        const env = raw as unknown as Env;
        const { mails, more } = await env.asSuperuser({ reason: 'campaign batch' }, (su) =>
          takeBatch(su as unknown as Env, campaign, base),
        );
        const next = (round ?? 0) + 1;
        if (more)
          await env.enqueue(
            SEND_JOB,
            { campaign, round: next },
            { key: `${SEND_JOB}:${campaign}:${next}` },
          );
        env.afterCommit(async () => {
          const failures: { delivery: number; error: string }[] = [];
          const named: { delivery: number; id: string }[] = [];
          for (const m of mails)
            await mailer
              .send({
                to: m.to,
                subject: m.subject,
                text: m.text,
                html: m.html,
                headers: m.headers,
                ...(m.replyTo === null || m.replyTo.trim() === '' ? {} : { replyTo: m.replyTo }),
              })
              .then((sent) => {
                if (sent.id !== null) named.push({ delivery: m.delivery, id: sent.id });
              })
              .catch((error: unknown) => {
                failures.push({
                  delivery: m.delivery,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          if (failures.length === 0 && named.length === 0) return;
          await context.shutro
            .bootstrap({ reason: 'campaign messages handed over' }, async (su) => {
              await saveProviderIds(su as unknown as Env, named);
              if (failures.length > 0) await markFailed(su as unknown as Env, failures);
            })
            .catch((error: unknown) => context.log?.('campaign failures not recorded', error));
        });
      },
      [START_JOB]: async (payload, raw) => {
        const { campaign, at } = payload as { campaign: number; at: string };
        const env = raw as unknown as Env;
        const [c] = await env
          .model('marketing.campaign')
          .browse([campaign] as never)
          .load(['state', 'scheduledAt']);
        // Unscheduled, or scheduled again for another time: that time has its own job.
        if (c === undefined || c.state !== 'scheduled' || c.scheduledAt === null) return;
        if (new Date(c.scheduledAt as unknown as string | Date).toISOString() !== at) return;
        await env
          .model('marketing.campaign')
          .browse([campaign] as never)
          .send();
      },
    },
    { pollMs: 1000 },
  ) as unknown as Worker;
}

/**
 * The subscriber of bounces (`mail.bounced`, announced by inbound email): a campaign message that came back is
 * marked so, in its company; an address that will never take mail leaves the lists for good.
 */
export function bounceWorker(context: Pick<ModuleContext, 'shutro'>): Worker {
  return context.shutro.subscribe(
    'marketing.bounces',
    BOUNCE_TOPIC,
    async (event, env) => {
      const payload = (event.payload ?? {}) as {
        messageIds?: unknown;
        permanent?: unknown;
        subject?: unknown;
      };
      const ids = (Array.isArray(payload.messageIds) ? payload.messageIds : []).map(String);
      const found = await (env as unknown as Env).asSuperuser({ reason: 'campaign bounce' }, (su) =>
        bouncedDeliveries(su, ids),
      );
      for (const d of found)
        await context.shutro.bootstrap({ reason: 'campaign bounce', company: d.company }, (su) =>
          recordBounce(
            su as unknown as Env,
            d.id,
            payload.permanent === true,
            `Bounced: ${String(payload.subject ?? '')}`,
          ),
        );
    },
    { pollMs: 5000 },
  ) as unknown as Worker;
}

/** A transparent 1×1 GIF. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function registerCampaignRoutes(context: ModuleContext, transport: Transport): void {
  const { app, shutro } = context;
  const pub = { config: { auth: false } };
  const tokenOf = (params: unknown): string =>
    String((params as { token?: unknown }).token ?? '').slice(0, 200);
  // A recipient has no rights of their own: their message is found by the secret in its links alone.
  const asSystem = <T>(reason: string, fn: (env: Env) => Promise<T>): Promise<T> =>
    shutro.bootstrap({ reason }, (env) => fn(env as unknown as Env));
  const languageOf = (header: unknown): MailLanguage =>
    /^bn\b/i.test(String(header ?? '')) ? 'bn' : 'en';

  app.get('/api/v1/public/campaigns/o/:token', pub, async (request, reply) => {
    const token = tokenOf(request.params).replace(/\.gif$/i, '');
    // The picture is served whatever the secret is: nothing to learn from asking.
    await asSystem('a campaign message opened', (env) => recordOpen(env, token)).catch(
      (error: unknown) => app.log.error({ err: error }, 'campaign open not counted'),
    );
    return reply
      .type('image/gif')
      .header('cache-control', 'no-store, private')
      .header('x-content-type-options', 'nosniff')
      .send(PIXEL);
  });

  app.get('/api/v1/public/campaigns/c/:token/:n', pub, async (request, reply) => {
    const n = Number((request.params as { n?: unknown }).n);
    const url = await asSystem('a campaign link followed', (env) =>
      recordClick(env, tokenOf(request.params), n),
    );
    if (url === null)
      throw new HttpProblem(404, 'not-found', 'Not found', 'This link does not lead anywhere.');
    return reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .redirect(url, 302);
  });

  const page = async (
    request: { params: unknown; headers: Record<string, unknown> },
    reply: {
      type(t: string): unknown;
      headers(h: Readonly<Record<string, string>>): unknown;
      code(n: number): { send(body: string): unknown };
    },
    act: boolean,
  ) => {
    const token = tokenOf(request.params);
    if (act) {
      // In the message's own company: its subscriber and its never-email list are that company's.
      const company = await asSystem('unsubscribe', (env) => companyOfToken(env, token));
      if (company !== null)
        await shutro.bootstrap({ reason: 'unsubscribe', company }, (env) =>
          unsubscribe(env as unknown as Env, token),
        );
    }
    const view = await asSystem('unsubscribe', (env) => unsubscribeView(env, token));
    reply.type('text/html; charset=utf-8');
    reply.headers(PAGE_SECURITY);
    return reply
      .code(view === null ? 404 : 200)
      .send(
        renderUnsubscribe(
          view,
          view?.language ?? languageOf(request.headers['accept-language']),
          `/api/v1/public/campaigns/u/${encodeURIComponent(token)}`,
        ),
      );
  };
  app.get('/api/v1/public/campaigns/u/:token', pub, (request, reply) =>
    page(request as never, reply as never, false),
  );
  // The page's form and a mail client's one-click post (`List-Unsubscribe=One-Click`): a form body, not JSON.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/api/v1/public/campaigns/u/:token', pub, (request, reply) =>
      page(request as never, reply as never, true),
    );
  });

  app.post('/api/v1/campaigns/:id/test', async (request) => {
    const id = Number((request.params as { id?: unknown }).id);
    const to = emailKey(String((request.body as { to?: unknown } | null)?.to ?? ''));
    if (!Number.isInteger(id) || to === null)
      throw new HttpProblem(400, 'invalid-body', 'Invalid request', 'Send { "to": an address }.');
    const { mailer } = transport;
    if (mailer === undefined)
      throw new HttpProblem(
        409,
        'no-mailer',
        'Email is not set up',
        'Set SMTP_URL on the server, then start it again.',
      );
    return request.env(async (raw) => {
      const env = raw as unknown as Env;
      // Read as the user: only someone who may read the campaign sends its test.
      const [c] = await env
        .model('marketing.campaign')
        .search({ where: { id } as never, limit: 1 })
        .then((r) => r.load({ company: true }));
      if (c === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `There is no campaign ${id}.`);
      const mail = compose({
        subject: `[Test] ${c.subject}`,
        preheader: c.preheader,
        body: c.body ?? '',
        who: { name: '', email: to },
        links: linksOf(c.body ?? ''),
        tracking: null,
        language: 'en',
        sender: c.company.name,
      });
      await mailer.send({ to, subject: mail.subject, text: mail.text, html: mail.html });
      return { sent: to };
    });
  });
}

export interface MarketingOptions {
  /** Sends the campaigns (default: from the environment; none: campaigns cannot be sent). */
  readonly mailer?: Mailer | undefined;
  /** The server's public address, for the links of a message (default: `KOSH_BASE_URL`). */
  readonly baseUrl?: string | undefined;
  /** Start the worker (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
}

const STATES = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
} as const;

let configured: MarketingOptions = {};
/**
 * Says how Campaigns sends, before the server starts (tests and the E2E server: a memory mailer, the worker
 * drained by hand). There is one Campaigns module — its bridges depend on it —, so this is not a factory.
 */
export function configureCampaigns(options: MarketingOptions): void {
  configured = options;
}

export const marketing: ReturnType<typeof defineModule> = defineModule({
  shutro: marketingShutro,
  kosh: '^0.1.0',
  hooks: { demo: marketingDemo },
  depends: [contacts, messaging, reporting],
  app: {
    code: 'campaigns',
    label: 'Campaigns',
    icon: 'campaigns',
    sequence: 63,
    category: 'Marketing',
    summary:
      'Mailing lists, email campaigns with two subjects to try, opens, clicks and unsubscribes',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User (writes campaigns, keeps subscribers)', groups: ['marketing.user'] },
    manager: {
      label: 'Manager (lists, the never-email list, sends campaigns)',
      groups: ['marketing.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => {
    const options = configured;
    const mailer = 'mailer' in options ? options.mailer : mailerFromEnv();
    const baseUrl = options.baseUrl ?? process.env['KOSH_BASE_URL'] ?? '';
    const transport: Transport = { mailer, baseUrl };
    setCampaignTransport(mailer !== undefined && baseUrl !== '');
    registerCampaignRoutes(context, transport);
    if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
    const worker = campaignWorker(
      {
        shutro: context.shutro,
        log: (message, error) => context.app.log.error({ err: error }, message),
      },
      transport,
    );
    const bounces = bounceWorker({ shutro: context.shutro });
    worker.start();
    bounces.start();
    context.app.addHook('onClose', async () => {
      await worker.stop();
      await bounces.stop();
    });
  },
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'marketing.campaign',
        reason:
          'A campaign is its message — rich text written on screen — and its figures; there is nothing to import.',
      },
    ],
  },
  events: [
    {
      topic: 'marketing.campaign.sending',
      model: 'marketing.campaign',
      label: 'Campaign started',
    },
    { topic: 'marketing.campaign.sent', model: 'marketing.campaign', label: 'Campaign sent' },
    {
      topic: 'marketing.delivery.unsubscribed',
      model: 'marketing.delivery',
      label: 'Recipient unsubscribed',
    },
  ],
  documents: [
    {
      key: 'marketing_campaign',
      name: 'Campaign results',
      model: 'marketing.campaign',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'what',
            items: [
              { label: 'Subject', bind: 'subject' },
              { label: 'Subject B', bind: 'subjectB' },
              { label: 'Started at', bind: 'startedAt' },
              { label: 'Finished at', bind: 'sentAt' },
            ],
          },
          {
            kind: 'fields',
            id: 'figures',
            items: [
              { label: 'Recipients', bind: 'recipients' },
              { label: 'Left out', bind: 'skipped' },
              { label: 'Sent', bind: 'sent' },
              { label: 'Not sent', bind: 'failed' },
              { label: 'Opened', bind: 'opened' },
              { label: 'Opened %', bind: 'openRate' },
              { label: 'Clicked', bind: 'clicked' },
              { label: 'Clicked %', bind: 'clickRate' },
              { label: 'Unsubscribed', bind: 'unsubscribed' },
              { label: 'Bounced', bind: 'bounced' },
            ],
          },
          {
            kind: 'fields',
            id: 'subjects',
            items: [
              { label: 'Sent with A', bind: 'sentA' },
              { label: 'Opened % with A', bind: 'openRateA' },
              { label: 'Sent with B', bind: 'sentB' },
              { label: 'Opened % with B', bind: 'openRateB' },
            ],
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'marketing_lists',
      model: 'marketing.list',
      label: 'Mailing lists',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'What it is for', field: 'description' },
      ],
    },
    {
      key: 'marketing_subscribers',
      model: 'marketing.subscriber',
      label: 'Subscribers',
      columns: [
        { header: 'List', field: 'list' },
        { header: 'Email', field: 'email' },
        { header: 'Name', field: 'name' },
        { header: 'Phone', field: 'phone' },
        { header: 'Language', field: 'language' },
        { header: 'Status', field: 'state' },
      ],
    },
    {
      key: 'marketing_never',
      model: 'marketing.suppression',
      label: 'Never-email addresses',
      columns: [
        { header: 'Email', field: 'email' },
        { header: 'Why', field: 'reason' },
        { header: 'Note', field: 'note' },
      ],
    },
  ],
  overview: {
    cards: [
      {
        id: 'subscribers',
        title: 'Subscribers',
        kind: 'kpi',
        model: 'marketing.subscriber',
        measure: 'count',
        filter: { state: 'subscribed' },
        w: 3,
      },
      {
        id: 'sent',
        title: 'Messages sent',
        kind: 'kpi',
        model: 'marketing.campaign',
        measure: 'sum:sent',
        w: 3,
      },
      {
        id: 'opened',
        title: 'Opened',
        kind: 'kpi',
        model: 'marketing.campaign',
        measure: 'sum:opened',
        w: 3,
      },
      {
        id: 'unsubscribed',
        title: 'Unsubscribed',
        kind: 'kpi',
        model: 'marketing.subscriber',
        measure: 'count',
        filter: { state: 'unsubscribed' },
        w: 3,
      },
      {
        id: 'by_campaign',
        title: 'Opened by campaign',
        kind: 'pivot',
        model: 'marketing.campaign',
        measure: 'sum:opened',
        groupBy: 'name',
        w: 6,
      },
      {
        id: 'subscribers_by_list',
        title: 'Subscribers by list',
        kind: 'chart',
        model: 'marketing.subscriber',
        measure: 'count',
        groupBy: 'list',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'subscribers_by_status',
        title: 'Subscribers by status',
        kind: 'chart',
        model: 'marketing.subscriber',
        measure: 'count',
        groupBy: 'state',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'clicks_by_link',
        title: 'Clicks by link',
        kind: 'pivot',
        model: 'marketing.link',
        measure: 'sum:clicks',
        groupBy: 'url',
        w: 6,
      },
    ],
  },
  actions: {
    'marketing.action_campaigns': action(MarketingCampaign, {
      label: 'Campaigns',
      views: ['list', 'form'],
    }),
    'marketing.action_lists': action(MarketingList, {
      label: 'Mailing lists',
      views: ['list', 'form'],
    }),
    'marketing.action_subscribers': action(MarketingSubscriber, {
      label: 'Subscribers',
      views: ['list', 'form'],
    }),
    'marketing.action_deliveries': action(MarketingDelivery, {
      label: 'Messages',
      views: ['list', 'form'],
    }),
    'marketing.action_links': action(MarketingLink, { label: 'Links', views: ['list', 'form'] }),
    'marketing.action_never': action(MarketingSuppression, {
      label: 'Never-email list',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'marketing.root', label: 'Campaigns', app: 'campaigns' },
    {
      id: 'marketing.campaigns',
      parent: 'marketing.root',
      label: 'Campaigns',
      action: 'marketing.action_campaigns',
      sequence: 1,
    },
    {
      id: 'marketing.lists',
      parent: 'marketing.root',
      label: 'Mailing lists',
      action: 'marketing.action_lists',
      sequence: 2,
    },
    {
      id: 'marketing.subscribers',
      parent: 'marketing.root',
      label: 'Subscribers',
      action: 'marketing.action_subscribers',
      sequence: 3,
    },
    {
      id: 'marketing.deliveries',
      parent: 'marketing.root',
      label: 'Messages',
      action: 'marketing.action_deliveries',
      sequence: 4,
    },
    {
      id: 'marketing.never',
      parent: 'marketing.root',
      label: 'Never-email list',
      action: 'marketing.action_never',
      sequence: 5,
    },
  ],
  views: {
    'marketing.campaign.list': list(MarketingCampaign, {
      columns: [
        'name',
        'subject',
        { field: 'state', widget: 'badge' },
        'scheduledAt',
        { field: 'sent', sum: true },
        'openRate',
        'clickRate',
        { field: 'unsubscribed', sum: true },
      ],
      decorations: {
        info: { state: { in: ['scheduled', 'sending'] } },
        success: { state: 'sent' },
        neutral: { state: 'cancel' },
      },
    }),
    'marketing.campaign.form': form(MarketingCampaign, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('send', { primary: true, label: 'Send now' }),
          k.button('schedule', { label: 'Schedule' }),
          k.button('unschedule', { label: 'Back to draft' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      readonlyWhen: { state: { in: ['sending', 'sent', 'cancel'] } },
      sheet: [
        k.stats('related', [
          {
            id: 'campaign_messages',
            label: 'Messages',
            model: MarketingDelivery,
            where: { campaign: { $record: 'id' } },
            action: 'marketing.action_deliveries',
          },
          {
            id: 'campaign_opened',
            label: 'Opened',
            model: MarketingDelivery,
            where: { campaign: { $record: 'id' }, openedAt: { isNull: false } },
            action: 'marketing.action_deliveries',
          },
          {
            id: 'campaign_clicked',
            label: 'Clicked',
            model: MarketingDelivery,
            where: { campaign: { $record: 'id' }, clickedAt: { isNull: false } },
            action: 'marketing.action_deliveries',
          },
          {
            id: 'campaign_links',
            label: 'Links',
            model: MarketingLink,
            where: { campaign: { $record: 'id' } },
            action: 'marketing.action_links',
          },
        ]),
        k.group('main', ['name', 'replyTo']),
        k.group('audience', ['lists', 'tags', 'scheduledAt'], {
          label: 'To whom, and when',
          description:
            'Each address is written to once, whichever list or tag it comes from. Addresses that unsubscribed or stand on the never-email list are left out by the server.',
        }),
        k.group('message', ['subject', 'subjectB', 'preheader', 'body'], {
          label: 'The message',
          columns: 1,
          description:
            '{{name}}, {{first_name}} and {{email}} are filled per person. With a Subject B, every other recipient gets it.',
        }),
        k.group(
          'figures',
          [
            'recipients',
            'skipped',
            'sent',
            'failed',
            'opened',
            'openRate',
            'clicked',
            'clickRate',
            'unsubscribed',
            'bounced',
            'startedAt',
            'sentAt',
          ],
          {
            label: 'Figures',
            description: 'Counted by the server as the messages go out and are read.',
          },
        ),
        k.group('subjects', ['sentA', 'openRateA', 'clickedA', 'sentB', 'openRateB', 'clickedB'], {
          label: 'Subject A against B',
        }),
      ],
      chatter: true,
    })),
    'marketing.list.list': list(MarketingList, { columns: ['name', 'description'] }),
    'marketing.list.form': form(MarketingList, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.stats('related', [
          {
            id: 'list_subscribed',
            label: 'Subscribed',
            model: MarketingSubscriber,
            where: { list: { $record: 'id' }, state: 'subscribed' },
            action: 'marketing.action_subscribers',
          },
          {
            id: 'list_unsubscribed',
            label: 'Unsubscribed',
            model: MarketingSubscriber,
            where: { list: { $record: 'id' }, state: 'unsubscribed' },
            action: 'marketing.action_subscribers',
          },
        ]),
        k.group('main', ['name', 'description'], { columns: 1 }),
      ],
    })),
    'marketing.subscriber.list': list(MarketingSubscriber, {
      columns: [
        'email',
        'name',
        'list',
        { field: 'state', widget: 'badge' },
        'language',
        'partner',
        'unsubscribedAt',
      ],
      decorations: { neutral: { state: 'unsubscribed' }, danger: { state: 'bounced' } },
    }),
    'marketing.subscriber.form': form(MarketingSubscriber, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['list', 'email', 'name', 'phone', 'partner', 'language']),
        k.group('status', ['state', 'unsubscribedAt', 'note'], { label: 'Subscription' }),
      ],
    })),
    'marketing.suppression.list': list(MarketingSuppression, {
      columns: ['email', { field: 'reason', widget: 'badge' }, 'note'],
    }),
    'marketing.suppression.form': form(MarketingSuppression, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['email', 'reason', 'note'], {
          description:
            'No campaign writes to an address on this list, whichever list or tag it comes from.',
        }),
      ],
    })),
    'marketing.delivery.list': list(MarketingDelivery, {
      columns: [
        'campaign',
        'email',
        'name',
        { field: 'state', widget: 'badge' },
        'variant',
        'sentAt',
        'openedAt',
        'clickedAt',
        'unsubscribedAt',
      ],
      decorations: {
        danger: { state: 'failed' },
        warning: { state: 'bounced' },
        neutral: { state: 'skipped' },
      },
    }),
    'marketing.delivery.form': form(MarketingDelivery, (k) => ({
      header: { buttons: [] },
      readonlyWhen: {},
      sheet: [
        k.group('main', ['campaign', 'email', 'name', 'partner', 'subscriber', 'language']),
        k.group('what', ['state', 'variant', 'sentAt', 'error'], { label: 'The message' }),
        k.group('read', ['openedAt', 'opens', 'clickedAt', 'clicks', 'unsubscribedAt'], {
          label: 'What they did',
        }),
      ],
    })),
    'marketing.link.list': list(MarketingLink, {
      columns: ['campaign', 'position', 'url', { field: 'clicks', sum: true }],
    }),
    'marketing.link.form': form(MarketingLink, (k) => ({
      header: { buttons: [] },
      readonlyWhen: {},
      sheet: [k.group('main', ['campaign', 'position', 'url', 'clicks'])],
    })),
  },
  search: {
    'marketing.campaign': search(MarketingCampaign, {
      fields: ['name', 'subject'],
      filters: Object.fromEntries(
        Object.entries(STATES).map(([state, label]) => [
          state,
          { label, domain: { state }, group: 'state' },
        ]),
      ),
      groupBy: ['state'],
    }),
    'marketing.list': search(MarketingList, { fields: ['name'] }),
    'marketing.subscriber': search(MarketingSubscriber, {
      fields: ['email', 'name', 'list.name'],
      filters: {
        subscribed: { label: 'Subscribed', domain: { state: 'subscribed' }, group: 'state' },
        unsubscribed: {
          label: 'Unsubscribed',
          domain: { state: 'unsubscribed' },
          group: 'state',
        },
        bounced: { label: 'Bounced', domain: { state: 'bounced' }, group: 'state' },
      },
      groupBy: ['list', 'state', 'language'],
    }),
    'marketing.suppression': search(MarketingSuppression, {
      fields: ['email', 'note'],
      groupBy: ['reason'],
    }),
    'marketing.delivery': search(MarketingDelivery, {
      fields: ['email', 'name', 'campaign.name'],
      filters: {
        sent: { label: 'Sent', domain: { state: 'sent' }, group: 'state' },
        failed: { label: 'Not sent', domain: { state: 'failed' }, group: 'state' },
        bounced: { label: 'Bounced', domain: { state: 'bounced' }, group: 'state' },
        skipped: { label: 'Left out', domain: { state: 'skipped' }, group: 'state' },
        opened: { label: 'Opened', domain: { openedAt: { isNull: false } }, group: 'read' },
        clicked: { label: 'Clicked', domain: { clickedAt: { isNull: false } }, group: 'read' },
      },
      groupBy: ['campaign', 'state', 'variant'],
    }),
    'marketing.link': search(MarketingLink, {
      fields: ['url', 'campaign.name'],
      groupBy: ['campaign'],
    }),
  },
});
