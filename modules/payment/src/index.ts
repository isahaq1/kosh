/**
 * @packageDocumentation
 * `@kosh/payment`: online payments (RFC 0017 §5.5, step 4). A company's payment providers (Accounting ›
 * Configuration), Pay now on the portal's open invoices, the provider's callbacks through an inbound webhook (logged,
 * idempotent, retried — `@kosh/integrations`), and the payment registered and reconciled in Accounting, once.
 * Routes:
 *
 * - `GET  /api/portal/v1/payments/providers`               the providers a portal user may pay with
 * - `POST /api/portal/v1/payments`                         `{ document, id, provider }`: a transaction; where to go
 * - `GET  /api/portal/v1/payments/:reference`              its state (asking the provider while it is pending)
 * - `GET  /api/v1/payment/fake/checkout/:reference`        the fake provider's checkout page
 * - `POST /api/v1/payment/fake/checkout/:reference?outcome=paid|declined`
 * - `GET|POST /api/v1/payment/return/:reference`             back from the provider: on to the portal
 *
 * The callbacks arrive at `POST /api/v1/hooks/<token>` (the provider's endpoint, made with its first payment).
 */

import { accountPortal } from '@kosh/account_portal';
import { accounting } from '@kosh/accounting';
import { integrations, receive } from '@kosh/integrations';
import { defineModule, type InboundWebhookSpec, type KoshModule } from '@kosh/modules-sdk';
import { portalDocuments } from '@kosh/portal';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { type Env as CoreEnv, orm } from '@kosh/server/orm';
import { action, form, list } from '@kosh/views';
import type { FastifyInstance } from 'fastify';
import type { Env } from './.kosh/bindings.js';
import { bkashFromEnvironment } from './bkash.js';
import { PaymentProvider, PaymentTransaction, paymentShutro } from './module.js';
import { ADAPTERS, FAKE_SIGNATURE, fakeAdapter, type PaymentAdapter } from './providers.js';
import { settle } from './settle.js';
import { sslcommerzFromEnvironment } from './sslcommerz.js';

export { type BkashOptions, bkashAdapter, bkashFromEnvironment } from './bkash.js';
export {
  newReference,
  PaymentProvider,
  PaymentTransaction,
  PROVIDERS,
  paymentShutro,
} from './module.js';
export {
  ADAPTERS,
  FAKE_SIGNATURE,
  fakeAdapter,
  type PaymentAdapter,
  type PaymentRequest,
  type PaymentResult,
  type PaymentStatus,
} from './providers.js';
export { type Settled, settle } from './settle.js';
export {
  type SslcommerzOptions,
  sslcommerzAdapter,
  sslcommerzFromEnvironment,
} from './sslcommerz.js';

type Row = Record<string, unknown>;
const typed = (env: CoreEnv): Env => env as unknown as Env;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A callback endpoint per adapter: verified by the adapter with the endpoint's secret, settled as the system. */
function callbackHooks(adapters: ReadonlyMap<string, PaymentAdapter>): InboundWebhookSpec[] {
  return [...adapters.values()].map((adapter) => ({
    key: adapter.code,
    label: `Payment callbacks (${adapter.code})`,
    verify: (call, secret) => adapter.verifyCallback(call, secret),
    handle: async (env, call) => {
      const result = adapter.readCallback(call);
      if (result === null) return 'Not a payment event.';
      const settled = await settle(typed(env as CoreEnv), result);
      return settled === null
        ? `No transaction ${result.reference} in this company.`
        : `${settled.reference}: ${settled.state}${settled.changed ? '' : ' (already)'}`;
    },
  }));
}

export interface PaymentOptions {
  /** The adapters by code (tests; default: the fake). */
  readonly adapters?: ReadonlyMap<string, PaymentAdapter>;
  /** The portal's address: where providers send customers back (`SHUTRO_ERP_PORTAL_URL`). */
  readonly portalUrl?: string;
  /** The API's public address: where providers call back (`SHUTRO_ERP_API_URL`). */
  readonly apiUrl?: string;
}

function registerPaymentRoutes(
  context: ModuleContext,
  adapters: ReadonlyMap<string, PaymentAdapter>,
  urls: { readonly portal: string; readonly api: string },
): void {
  const { app } = context;
  const documents = portalDocuments(context.registry);

  const portalOnly = (env: CoreEnv) => {
    if (!env.groups.has('portal.user') || env.groups.has('base.user'))
      throw new HttpProblem(403, 'portal-only', 'Portal users only', 'This is the portal’s API.');
  };
  const adapterOf = (code: string): PaymentAdapter => {
    const adapter = adapters.get(code);
    if (adapter === undefined)
      throw new HttpProblem(
        409,
        'no-adapter',
        'Provider unavailable',
        `The ${code} adapter is not installed.`,
      );
    return adapter;
  };
  /** The provider's callback endpoint (made on first use), with its token. */
  const endpointOf = async (su: Env, provider: { id: number; name: string; code: string }) => {
    const [p] = await su
      .model('payment.provider')
      .browse([provider.id] as never)
      .load({ endpoint: true });
    if (p?.endpoint !== null && p?.endpoint !== undefined) return p.endpoint.token;
    const made = await su
      .model('webhook.endpoint')
      .create([{ name: `${provider.name} callbacks`, hook: `payment.${provider.code}` }]);
    await su
      .model('payment.provider')
      .browse([provider.id] as never)
      .write({ endpoint: made.ids[0] as never });
    const [e] = await made.load({});
    return e?.token ?? '';
  };

  app.get('/api/portal/v1/payments/providers', async (request) =>
    request.env(
      (env) => {
        portalOnly(env);
        return env.asSuperuser({ reason: 'portal: payment providers' }, async (su) => {
          const found = await typed(su)
            .model('payment.provider')
            .search({
              where: {
                state: { in: ['test', 'live'] },
                company: orm.asId(env.companyId, 'res.company'),
              },
            });
          return {
            providers: [...(await found.load({}))]
              .filter(
                (p) =>
                  adapters.get(p.code)?.configured(p.state === 'live' ? 'live' : 'test') === true,
              )
              .map((p) => ({ id: p.id, name: p.name, test: p.state === 'test' })),
          };
        });
      },
      { write: true },
    ),
  );

  app.post('/api/portal/v1/payments', async (request, reply) => {
    const body = (request.body ?? {}) as Row;
    const key = String(body['document'] ?? '');
    const id = Number(body['id']);
    const providerId = Number(body['provider']);
    const d = documents.get(key);
    if (d === undefined || d.spec.payment === undefined || d.model.name !== 'account.move')
      throw new HttpProblem(
        404,
        'not-found',
        'Not payable',
        `Documents '${key}' are not paid online.`,
      );
    const company = await request.env(
      async (env) => {
        portalOnly(env);
        // Theirs (the record rule) and payable now (the declaration), searched as the portal user.
        const theirs = await env.model(d.model.name as never).search({
          where: { and: [d.spec.domain ?? {}, { id }, d.spec.payment?.when ?? {}] },
          limit: 1,
        } as never);
        if (theirs.length === 0)
          throw new HttpProblem(
            409,
            'not-payable',
            'Nothing to pay',
            'This document is not open for payment.',
          );
        return env.companyId;
      },
      { write: true },
    );
    // Started by the system once the document is known to be the customer's (as the portal's own actions are).
    const started = await context.shutro.bootstrap(
      { reason: 'portal: start a payment', company },
      async (raw) => {
        const su = typed(raw);
        const [provider] = await (
          await su.model('payment.provider').search({
            where: {
              id: orm.asId(providerId, 'payment.provider'),
              state: { in: ['test', 'live'] },
              company: orm.asId(company, 'res.company'),
            },
            limit: 1,
          })
        ).load({});
        if (provider === undefined)
          throw new HttpProblem(
            422,
            'invalid-provider',
            'No such provider',
            'Choose one of the providers offered.',
          );
        const adapter = adapterOf(provider.code);
        if (provider.code === 'fake' && provider.state === 'live')
          throw new HttpProblem(
            409,
            'fake-live',
            'Test provider',
            'The test provider moves no money: it cannot be live.',
          );
        if (!adapter.configured(provider.state === 'live' ? 'live' : 'test'))
          throw new HttpProblem(
            409,
            'not-configured',
            'Provider not set up',
            `The ${provider.name} provider has no credentials for ${provider.state} payments on this server.`,
          );
        const [move] = await su
          .model('account.move')
          .browse([id] as never)
          .load({ partner: true, currency: true });
        if (move === undefined)
          throw new HttpProblem(404, 'not-found', 'No such document', 'No such document.');
        const due = move.amountResidual?.amount;
        if (due === undefined || !due.gt(0))
          throw new HttpProblem(
            409,
            'not-payable',
            'Nothing to pay',
            'Nothing is due on this document.',
          );
        const token = await endpointOf(su, provider);
        const created = await su.model('payment.transaction').create([
          {
            provider: provider.id as never,
            move: move.id as never,
            partner: (move.partner?.id ?? null) as never,
            currency: move.currency.id as never,
            amount: due.toFixed(),
            company: company as never,
          },
        ]);
        await su.flush(); // company checks run in this superuser scope, not at commit (Shutro request #11)
        const [tx] = await created.load({});
        const reference = tx?.reference ?? '';
        let started: Awaited<ReturnType<PaymentAdapter['createPayment']>>;
        try {
          started = await adapter.createPayment({
            reference,
            amount: due.toFixed(move.currency.decimalPlaces ?? 2),
            currency: move.currency.name,
            description: `${d.spec.label} ${move.name}`,
            customer: {
              name: move.partner?.name ?? '',
              email: move.partner?.email ?? null,
              phone: move.partner?.phone ?? move.partner?.mobile ?? null,
              street: move.partner?.street ?? null,
              city: move.partner?.city ?? null,
              zip: move.partner?.zip ?? null,
              country: move.partner?.country ?? null,
            },
            returnUrl: `${urls.api}/api/v1/payment/return/${encodeURIComponent(reference)}`,
            callbackUrl: `${urls.api}/api/v1/hooks/${token}`,
            mode: provider.state === 'live' ? 'live' : 'test',
          });
        } catch (error) {
          throw new HttpProblem(
            502,
            'provider-error',
            'The payment could not start',
            error instanceof Error ? error.message : String(error),
          );
        }
        if (started.providerReference !== undefined)
          await created.write({ providerReference: started.providerReference });
        await su.flush();
        return { reference, redirectUrl: started.redirectUrl };
      },
    );
    return reply.status(201).send(started);
  });

  app.get('/api/portal/v1/payments/:reference', async (request) => {
    const reference = String((request.params as Row)['reference'] ?? '');
    const found = await request.env(
      async (env) => {
        portalOnly(env);
        const tx = await env.asSuperuser({ reason: 'portal: a payment' }, async (raw) => {
          const [t] = await (
            await typed(raw)
              .model('payment.transaction')
              .search({
                where: { reference, company: orm.asId(env.companyId, 'res.company') },
                limit: 1,
              })
          ).load({ provider: true, currency: true });
          return t === undefined
            ? null
            : {
                move: t.move.id,
                state: t.state,
                amount: t.amount.amount.toFixed(t.currency.decimalPlaces ?? 2),
                currency: t.currency.name,
                code: t.provider.code,
                mode: t.provider.state === 'live' ? ('live' as const) : ('test' as const),
                providerReference: t.providerReference,
                error: t.error,
              };
        });
        // Theirs: the invoice is one they may read.
        if (
          tx === null ||
          (
            await env
              .model('account.move' as never)
              .search({ where: { id: tx.move }, limit: 1 } as never)
          ).length === 0
        )
          throw new HttpProblem(404, 'not-found', 'No such payment', `No payment ${reference}.`);
        return { ...tx, company: orm.asId(env.companyId, 'res.company') };
      },
      { write: true },
    );
    let state: string = found.state;
    let error = found.error;
    // Back before the callback: the provider's word settles it now (once; the callback then finds it settled).
    if (state === 'pending') {
      const result = await adapters
        .get(found.code)
        ?.status(reference, found.mode, found.providerReference)
        .catch(() => null);
      if (result !== null && result !== undefined && result.status !== 'pending') {
        const settled = await context.shutro.bootstrap(
          { reason: `payment ${reference}: the customer returned`, company: found.company },
          (env) => settle(typed(env), result),
        );
        state = settled?.state ?? state;
        error =
          settled?.state === 'failed'
            ? (result.error ?? 'The provider refused the payment.')
            : error;
      }
    }
    return { reference, state, amount: found.amount, currency: found.currency, error };
  });

  // The fake provider's checkout: no sign-in (the customer is on the provider's page), test transactions only.
  const fakeTx = (reference: string) =>
    context.shutro.bootstrap({ reason: 'fake payment checkout' }, (raw) =>
      raw.asSuperuser({ reason: 'fake payment checkout' }, async (su) => {
        const [t] = await (
          await typed(su.withFlags({ checkCompany: false }))
            .model('payment.transaction')
            .search({ where: { reference, state: 'pending' }, limit: 1 })
        ).load({ provider: { endpoint: true } });
        return t === undefined || t.provider.code !== 'fake' || t.provider.endpoint === null
          ? null
          : { token: t.provider.endpoint.token, secret: t.provider.endpoint.secret };
      }),
    );
  app.get(
    '/api/v1/payment/fake/checkout/:reference',
    { config: { auth: false } },
    async (request, reply) => {
      const reference = String((request.params as Row)['reference'] ?? '');
      const pending = fakeAdapter.pending(reference);
      if (pending === null || (await fakeTx(reference)) === null)
        throw new HttpProblem(404, 'not-found', 'No such payment', 'This payment is not waiting.');
      const action = (outcome: string) =>
        `/api/v1/payment/fake/checkout/${encodeURIComponent(reference)}?outcome=${outcome}`;
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        )
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test payment</title><style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}button{font:inherit;padding:.6rem 1rem;margin:.25rem .5rem 0 0;border-radius:.5rem;border:1px solid #888;cursor:pointer}
.pay{background:#16a34a;color:#fff;border-color:#16a34a}.note{font-size:.85rem;opacity:.75}</style></head>
<body><h1>Test payment</h1><p class="note">Test provider: no money moves.</p>
<p>${escapeHtml(pending.description)}</p><p><strong>${escapeHtml(pending.amount)} ${escapeHtml(pending.currency)}</strong></p>
<form method="post" action="${escapeHtml(action('paid'))}"><button class="pay" type="submit">Pay</button></form>
<form method="post" action="${escapeHtml(action('declined'))}"><button type="submit">Decline</button></form></body></html>`);
    },
  );
  // Browsers come back from providers (and the fake checkout's forms) with form posts: any body is accepted and
  // ignored — the provider's word comes from its callback or its API, never from the customer's browser.
  app.register(async (scope: FastifyInstance) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_req, _body, done) => done(null, null),
    );
    // Back from the provider (GET or POST): on to the document in the portal, which shows the payment's state.
    const payable =
      [...documents.values()].find(
        (d) => d.model.name === 'account.move' && d.spec.payment !== undefined,
      )?.spec.key ?? 'invoices';
    scope.route({
      method: ['GET', 'POST'],
      url: '/api/v1/payment/return/:reference',
      config: { auth: false },
      handler: async (request, reply) => {
        const reference = String((request.params as Row)['reference'] ?? '');
        const tx = await context.shutro.bootstrap({ reason: 'payment return' }, (raw) =>
          raw.asSuperuser({ reason: 'payment return: which invoice' }, async (su) => {
            const [t] = await (
              await typed(su.withFlags({ checkCompany: false }))
                .model('payment.transaction')
                .search({ where: { reference }, limit: 1 })
            ).load({ provider: true });
            return t === undefined
              ? null
              : {
                  move: t.move.id,
                  company: t.company.id,
                  state: t.state,
                  code: t.provider.code,
                  mode: t.provider.state === 'live' ? ('live' as const) : ('test' as const),
                  providerReference: t.providerReference,
                };
          }),
        );
        // Providers that complete a payment on the merchant's request (bKash) do it now; the adapter asks the
        // provider itself — what the browser brings is only a hint.
        const adapter = tx === null ? undefined : adapters.get(tx.code);
        if (tx !== null && tx.state !== 'done' && adapter?.returned !== undefined) {
          const query = Object.fromEntries(
            Object.entries((request.query ?? {}) as Row).map(([k, v]) => [k, String(v)]),
          );
          try {
            const result = await adapter.returned({
              reference,
              providerReference: tx.providerReference,
              mode: tx.mode,
              query,
            });
            if (result !== null)
              await context.shutro.bootstrap(
                { reason: `payment ${reference}: the customer returned`, company: tx.company },
                (env) => settle(typed(env), result),
              );
          } catch (error) {
            request.log.warn(
              { err: error, reference },
              'payment return: the provider did not answer',
            );
          }
        }
        const move = tx?.move ?? null;
        return reply.redirect(
          move === null
            ? `${urls.portal}/`
            : `${urls.portal}/d/${encodeURIComponent(payable)}/${move}?payment=${encodeURIComponent(reference)}`,
          303,
        );
      },
    });
    scope.post(
      '/api/v1/payment/fake/checkout/:reference',
      { config: { auth: false } },
      async (request, reply) => {
        const reference = String((request.params as Row)['reference'] ?? '');
        const paid = (request.query as Row)['outcome'] === 'paid';
        const pending = fakeAdapter.pending(reference);
        const tx = await fakeTx(reference);
        if (pending === null || tx === null)
          throw new HttpProblem(
            404,
            'not-found',
            'No such payment',
            'This payment is not waiting.',
          );
        const callback = fakeAdapter.complete(reference, paid, tx.secret);
        if (callback !== null)
          // The provider calls back (in process: the fake has no network of its own).
          await receive(context, tx.token, {
            headers: { 'content-type': 'application/json', [FAKE_SIGNATURE]: callback.signature },
            query: {},
            body: callback.body,
            json: JSON.parse(callback.body),
          });
        return reply.redirect(pending.returnUrl, 303);
      },
    );
  });
}

/** Online payments with explicit options (tests, installations wiring their own adapters). */
export function paymentModule(options: PaymentOptions = {}): KoshModule {
  const adapters =
    options.adapters ??
    new Map([
      ...ADAPTERS,
      ['sslcommerz', sslcommerzFromEnvironment()],
      ['bkash', bkashFromEnvironment()],
    ]);
  return defineModule({
    shutro: paymentShutro,
    kosh: '^0.1.0',
    depends: [accounting, accountPortal, integrations],
    accessLevels: {
      manager: { label: 'Payment providers', groups: ['account.manager'] },
    },
    inboundWebhooks: callbackHooks(adapters),
    actions: {
      'payment.action_providers': action(PaymentProvider, {
        label: 'Payment providers',
        views: ['list', 'form'],
      }),
      'payment.action_transactions': action(PaymentTransaction, {
        label: 'Online payments',
        views: ['list', 'form'],
      }),
    },
    menus: [
      {
        id: 'payment.transactions',
        parent: 'accounting.root',
        label: 'Online payments',
        action: 'payment.action_transactions',
        sequence: 3.5,
      },
      {
        id: 'payment.providers',
        parent: 'accounting.configuration',
        label: 'Payment providers',
        action: 'payment.action_providers',
        sequence: 3.7,
      },
    ],
    views: {
      'payment.provider.list': list(PaymentProvider, {
        columns: ['name', 'code', 'state', 'journal'],
      }),
      'payment.provider.form': form(PaymentProvider, (k) => ({
        sheet: [
          k.group('main', ['name', 'code', 'state']),
          k.group('accounting', ['journal', 'sequence', 'endpoint']),
        ],
      })),
      'payment.transaction.list': list(PaymentTransaction, {
        columns: ['reference', 'move', 'partner', 'provider', 'amount', 'state', 'doneAt'],
      }),
      'payment.transaction.form': form(PaymentTransaction, (k) => ({
        sheet: [
          k.group('main', ['reference', 'move', 'partner', 'provider']),
          k.group('outcome', [
            'amount',
            'state',
            'providerReference',
            'payment',
            'doneAt',
            'error',
          ]),
        ],
        readonlyWhen: { id: { ne: 0 } },
      })),
    },
    routes: (context: ModuleContext) =>
      registerPaymentRoutes(context, adapters, {
        portal: (
          options.portalUrl ??
          process.env['KOSH_PORTAL_URL'] ??
          'http://localhost:5174'
        ).replace(/\/$/, ''),
        api: (options.apiUrl ?? process.env['KOSH_API_URL'] ?? 'http://localhost:3000').replace(
          /\/$/,
          '',
        ),
      }),
  });
}

/** Online payments (the fake adapter; addresses from the environment). */
export const payment: KoshModule = paymentModule();
