/**
 * @packageDocumentation
 * `@kosh/integrations` (RFC 0017): the Integrations app. Step 2: outbound webhook subscriptions — events of records
 * and of modules, delivered signed, retried, logged, replayable. Routes:
 *
 * - `GET  /api/v1/webhooks/events`                         the events subscriptions may want here
 * - `POST /api/v1/webhooks/subscriptions`                  `{ name, url, events, runAs? }` (URL and events checked)
 * - `POST /api/v1/webhooks/subscriptions/:id/ping`         a test delivery
 * - `POST /api/v1/webhooks/subscriptions/:id/rotate-secret` a new signing secret
 * - `POST /api/v1/webhooks/deliveries/:id/replay`          the same payload, delivered again
 *
 * Subscriptions are also edited through the generated API (`webhook.subscription`); deliveries are read there.
 */
import { randomUUID } from 'node:crypto';
import { defineModule, type KoshModule } from '@kosh/modules-sdk';
import { base, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env, Worker } from '@kosh/server/orm';
import { action, form, list } from '@kosh/views';
import { integrationsShutro, newSecret } from './models.js';
import {
  CHANGE_EVENTS,
  CHANGE_TOPIC,
  DELIVER_JOB,
  deliver,
  fanOut,
  type IntegrationsContext,
  PING_EVENT,
  queue,
  ref,
  urlProblem,
  webhookEvents,
} from './webhooks.js';

export { integrationsShutro, newSecret } from './models.js';
export {
  CHANGE_EVENTS,
  DELIVER_JOB,
  deliver,
  fanOut,
  type IntegrationsContext,
  PING_EVENT,
  signature,
  urlProblem,
  type WebhookEvent,
  webhookEvents,
  webhookHosts,
} from './webhooks.js';

const idOf = (params: unknown) => {
  const id = Number((params as { id?: string }).id);
  if (!(Number.isInteger(id) && id > 0))
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The id is a positive integer.');
  return id;
};

/** The subscription `id` the caller may change, with its company. */
async function subscriptionOf(env: Env, id: number) {
  env.access.check('webhook.subscription' as never, 'write');
  const set = await ref(env, 'webhook.subscription').search({ where: { id }, limit: 1 });
  const [row] = set.length === 0 ? [] : (await set.load(['company'])).read(['id', 'company']);
  if (row === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', `There is no webhook ${id}.`);
  return { id, company: row['company'] as number };
}

function registerWebhookRoutes(context: ModuleContext, integrations: IntegrationsContext): void {
  const { app } = context;
  const known = () => new Set(webhookEvents(context.registry).map((e) => e.event));

  app.get('/api/v1/webhooks/events', async (request) =>
    request.env(async (env) => {
      env.access.check('webhook.subscription' as never, 'read');
      return { events: webhookEvents(context.registry) };
    }),
  );

  app.post('/api/v1/webhooks/subscriptions', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const url = String(body['url'] ?? '').trim();
    const problem = urlProblem(url);
    if (problem !== null) throw new HttpProblem(422, 'invalid-url', 'Invalid URL', problem);
    const events = (
      Array.isArray(body['events']) ? body['events'] : String(body['events'] ?? '').split(/[\s,]+/)
    )
      .map(String)
      .filter((e) => e !== '');
    const unknown = events.filter((e) => !known().has(e));
    if (events.length === 0 || unknown.length > 0)
      throw new HttpProblem(
        422,
        'invalid-events',
        'Invalid events',
        events.length === 0
          ? 'Choose at least one event.'
          : `Unknown events: ${unknown.join(', ')}.`,
      );
    const created = await request.env(
      async (env) => {
        const rows = await ref(env, 'webhook.subscription').create([
          {
            name: String(body['name'] ?? '').trim() || url,
            url,
            events: [...new Set(events)].join(' '),
            ...(body['runAs'] === undefined ? {} : { runAs: Number(body['runAs']) }),
          },
        ]);
        const id = rows.ids[0] as number;
        const [row] = (
          await ref(env, 'webhook.subscription')
            .browse([id])
            .load(['name', 'url', 'events', 'secret'])
        ).read(['id', 'name', 'url', 'events', 'secret']);
        return row;
      },
      { write: true },
    );
    return reply.status(201).send(created);
  });

  app.post('/api/v1/webhooks/subscriptions/:id/ping', async (request, reply) => {
    const id = idOf(request.params);
    const sub = await request.env((env) => subscriptionOf(env, id));
    const delivery = await queue(integrations, sub.id, sub.company, PING_EVENT, {
      id: randomUUID(),
      event: PING_EVENT,
      occurredAt: new Date().toISOString(),
      data: { subscription: sub.id },
    });
    return reply.status(202).send({ delivery });
  });

  app.post('/api/v1/webhooks/subscriptions/:id/rotate-secret', async (request) => {
    const id = idOf(request.params);
    return request.env(
      async (env) => {
        await subscriptionOf(env, id);
        const secret = newSecret();
        await ref(env, 'webhook.subscription').browse([id]).write({ secret });
        return { secret };
      },
      { write: true },
    );
  });

  app.post('/api/v1/webhooks/deliveries/:id/replay', async (request, reply) => {
    const id = idOf(request.params);
    const original = await request.env(async (env) => {
      env.access.check('webhook.subscription' as never, 'write');
      const set = await ref(env, 'webhook.delivery').search({ where: { id }, limit: 1 });
      const [row] =
        set.length === 0
          ? []
          : (await set.load(['subscription', 'event', 'payload', 'company'])).read([
              'subscription',
              'event',
              'payload',
              'company',
            ]);
      if (row === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `There is no delivery ${id}.`);
      return row;
    });
    const delivery = await queue(
      integrations,
      original['subscription'] as number,
      original['company'] as number,
      String(original['event']),
      original['payload'] as Record<string, unknown>,
      id,
    );
    return reply.status(202).send({ delivery });
  });
}

/** The workers: events to deliveries (change events and the modules' events), and the delivery jobs. */
export function webhookWorkers(integrations: IntegrationsContext): Worker[] {
  const { shutro, registry } = integrations;
  const changes = shutro.subscribe(
    'integrations.webhooks.changes',
    CHANGE_TOPIC,
    async (event, env) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const verb = CHANGE_EVENTS[String(payload['action'])];
      const model = String(payload['model'] ?? '');
      const ids = Array.isArray(payload['ids']) ? (payload['ids'] as number[]) : [];
      if (verb === undefined || model === '' || ids.length === 0) return;
      await fanOut(integrations, {
        event: `${model}.${verb}`,
        model,
        ids,
        company: env.companyId, // the handler runs as whoever emitted the event, in their company
      });
    },
    { pollMs: 2000 },
  );
  const declared = (registry.loaded.modules as readonly KoshModule[]).flatMap((m) =>
    (m.events ?? []).map((e) =>
      shutro.subscribe(
        `integrations.webhooks.${e.topic}`,
        e.topic,
        async (event, env) => {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          const id = Number(payload['id']);
          if (!Number.isInteger(id)) return;
          const { id: _id, ...extra } = payload;
          await fanOut(integrations, {
            event: e.topic,
            model: e.model,
            ids: [id],
            company: env.companyId, // the handler runs as whoever emitted the event, in their company
            extra,
          });
        },
        { pollMs: 2000 },
      ),
    ),
  );
  const jobs = shutro.work(
    {
      [DELIVER_JOB]: async (payload, _env, job) => {
        const p = (payload ?? {}) as { delivery?: number; company?: number };
        await deliver(integrations, Number(p.delivery), Number(p.company), {
          number: job.attempt,
          last: job.attempt >= job.maxAttempts,
        });
      },
    },
    { pollMs: 2000 },
  );
  return [changes, ...declared, jobs];
}

export interface IntegrationsOptions {
  /** The HTTP client deliveries use (tests). */
  readonly fetch?: typeof fetch;
  /** Start the workers (default: unless `SHUTRO_ERP_SCHEDULES=off`). */
  readonly workers?: boolean;
}

/** The Integrations app with explicit options (tests, installations wiring their own). */
export function integrationsModule(options: IntegrationsOptions = {}): KoshModule {
  return defineModule({
    shutro: integrationsShutro,
    kosh: '^0.1.0',
    depends: [base],
    app: {
      code: 'integrations',
      label: 'Integrations',
      icon: 'plug',
      sequence: 900,
      category: 'Administration',
      summary: 'Webhooks: tell other systems what happens here',
    },
    accessLevels: {
      manager: { label: 'Integrations manager', groups: ['integrations.manager'] },
    },
    // Webhooks may want any served model's changes: every one emits Shutro change events.
    changeEvents: '*',
    actions: {
      'integrations.action_webhooks': action('webhook.subscription', {
        label: 'Webhooks',
        views: ['list', 'form'],
      }),
      'integrations.action_deliveries': action('webhook.delivery', {
        label: 'Deliveries',
        views: ['list', 'form'],
      }),
    },
    menus: [
      { id: 'integrations.root', label: 'Integrations', app: 'integrations' },
      {
        id: 'integrations.webhooks',
        parent: 'integrations.root',
        label: 'Webhooks',
        action: 'integrations.action_webhooks',
        sequence: 1,
      },
      {
        id: 'integrations.deliveries',
        parent: 'integrations.root',
        label: 'Deliveries',
        action: 'integrations.action_deliveries',
        sequence: 2,
      },
    ],
    views: {
      'webhook.subscription.list': list('webhook.subscription', {
        columns: ['name', 'url', 'events', 'active', 'failures', 'lastDeliveryAt'],
      }),
      'webhook.subscription.form': form('webhook.subscription', (k) => ({
        sheet: [
          k.group('main', ['name', 'url', 'active', 'runAs']),
          k.group('events_group', ['events']),
          k.group('state', ['failures', 'lastDeliveryAt', 'secret']),
          k.component('webhook_tools', 'integrations.WebhookTools'),
        ],
      })),
      'webhook.delivery.list': list('webhook.delivery', {
        columns: ['subscription', 'event', 'state', 'attempts', 'responseStatus', 'deliveredAt'],
      }),
      'webhook.delivery.form': form('webhook.delivery', (k) => ({
        sheet: [
          k.group('main', ['subscription', 'event', 'state', 'replayOf']),
          k.group('outcome', ['attempts', 'responseStatus', 'durationMs', 'deliveredAt', 'error']),
          k.group('content', ['payload', 'responseBody']),
          k.component('delivery_tools', 'integrations.DeliveryTools'),
        ],
        readonlyWhen: { id: { ne: 0 } },
      })),
    },
    routes: (context: ModuleContext) => {
      const integrations: IntegrationsContext = {
        shutro: context.shutro,
        registry: context.registry,
        auth: context.auth,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      };
      registerWebhookRoutes(context, integrations);
      if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
      const workers = webhookWorkers(integrations);
      for (const w of workers) w.start();
      context.app.addHook('onClose', async () => {
        await Promise.all(workers.map((w) => w.stop()));
      });
    },
  });
}

/** The Integrations app (providers and workers from the environment). */
export const integrations: KoshModule = integrationsModule();
