/**
 * @packageDocumentation
 * `@kosh/subscription` (RFC 0034 §2.5): the **Subscriptions** app. Plans (monthly, quarterly, yearly, a trial),
 * subscriptions with lines priced by a price list or by hand, usage recorded and billed, one invoice per period
 * made by itself — once —, a change in the middle of a period invoiced or credited for the days left, pause,
 * resume and closing with a reason; monthly recurring revenue and churn on the overview, retention as a cohort.
 *
 * - `POST /api/v1/subscriptions/run`   managers: invoices every subscription of the company that is due
 *
 * A running server does the same every hour for each company.
 */
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import { action, cohort, form, kanban, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { subscriptionDemo } from './demo.js';
import {
  invoiceDue,
  Subscription,
  SubscriptionPlan,
  SubscriptionUsage,
  subscriptionShutro,
} from './module.js';

export * from './billing.js';
export {
  applyChanges,
  invoiceDue,
  invoiceSubscription,
  MoveSubscription,
  Subscription,
  SubscriptionLine,
  SubscriptionPlan,
  SubscriptionUsage,
  subscriptionShutro,
} from './module.js';

function registerSubscriptionRoutes(context: ModuleContext): void {
  const { app } = context;
  app.post('/api/v1/subscriptions/run', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!(env.administrator || env.groups.has('subscription.manager')))
          throw new HttpProblem(
            403,
            'access',
            'Subscriptions managers',
            'Invoicing what is due needs the Subscriptions manager role.',
          );
        const invoices = await invoiceDue(env);
        await audit(env as never, {
          kind: 'subscription.run',
          summary: `${invoices} subscription invoice(s) made by hand.`,
          ip: request.ip,
        });
        return { invoices };
      },
      { write: true },
    ),
  );
  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  // Every hour, each company's subscriptions that are due: an invoice is made once per period, so a second
  // server doing the same finds nothing left.
  const due = async () => {
    try {
      const companies = await context.shutro.bootstrap({ reason: 'subscriptions due' }, (env) =>
        (env as unknown as Env)
          .model('res.company')
          .search({ where: {} })
          .then((found) => found.ids.map(Number)),
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'subscriptions due', company }, (env) =>
          invoiceDue(env as unknown as Env),
        );
    } catch (error) {
      app.log.warn({ err: error }, 'subscriptions were not invoiced');
    }
  };
  const timer = setInterval(() => void due(), 60 * 60 * 1000);
  timer.unref();
  const first = setTimeout(() => void due(), 2 * 60 * 1000);
  first.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearTimeout(first);
  });
}

export const subscription: ReturnType<typeof defineModule> = defineModule({
  shutro: subscriptionShutro,
  kosh: '^0.1.0',
  hooks: { demo: subscriptionDemo },
  depends: [accounting, product, contacts, messaging, reporting],
  app: {
    code: 'subscriptions',
    label: 'Subscriptions',
    icon: 'subscriptions',
    sequence: 34,
    category: 'Sales',
    summary: 'Plans, recurring invoices made by themselves, usage, trials, MRR and churn',
  },
  routes: (context: ModuleContext) => registerSubscriptionRoutes(context),
  documents: [
    {
      key: 'subscription',
      name: 'Subscription',
      model: 'subscription.subscription',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Subscription {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Customer', bind: 'partner.name' },
              { label: 'Plan', bind: 'plan.name' },
              { label: 'Starts', bind: 'dateStart' },
              { label: 'Next invoice', bind: 'nextInvoiceDate' },
              { label: 'Per period', bind: 'recurring' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Billed', bind: 'kind' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Unit price', bind: 'priceUnit' },
              { label: 'Discount %', bind: 'discount' },
              { label: 'Amount', bind: 'subtotal' },
            ],
          },
        ],
      },
    },
  ],
  events: [
    {
      topic: 'subscription.subscription.started',
      model: 'subscription.subscription',
      label: 'Subscription started',
    },
    {
      topic: 'subscription.subscription.invoiced',
      model: 'subscription.subscription',
      label: 'Subscription invoiced',
    },
    {
      topic: 'subscription.subscription.closed',
      model: 'subscription.subscription',
      label: 'Subscription closed',
    },
  ],
  importTemplates: [
    {
      key: 'subscription_plan',
      model: 'subscription.plan',
      label: 'Subscription plan',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Bills every', field: 'unit' },
        { header: 'Every', field: 'interval' },
        { header: 'Trial (days)', field: 'trialDays' },
        { header: 'Post the invoices', field: 'autoPost' },
      ],
    },
    {
      key: 'subscription',
      model: 'subscription.subscription',
      label: 'Subscription',
      columns: [
        { header: 'Customer', field: 'partner' },
        { header: 'Plan', field: 'plan' },
        { header: 'Starts', field: 'dateStart' },
        { header: 'Price list', field: 'pricelist' },
        { header: 'Lines › Product', field: 'lines.product' },
        { header: 'Lines › Billed', field: 'lines.kind' },
        { header: 'Lines › Quantity', field: 'lines.quantity' },
        { header: 'Lines › Your price', field: 'lines.manualPrice' },
        { header: 'Lines › Discount %', field: 'lines.discount' },
      ],
    },
    {
      key: 'subscription_usage',
      model: 'subscription.usage',
      label: 'Usage',
      columns: [
        { header: 'Line', field: 'line' },
        { header: 'Date', field: 'date' },
        { header: 'Quantity', field: 'quantity' },
        { header: 'Note', field: 'note' },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User (subscriptions and usage)', groups: ['subscription.user'] },
    manager: {
      label: 'Manager (plans, invoicing what is due)',
      groups: ['subscription.manager'],
      implies: ['user'],
    },
  },
  // The Overview (RFC 0022 step 2): revenue that recurs, and who left.
  overview: {
    cards: [
      {
        id: 'mrr',
        title: 'MRR',
        kind: 'kpi',
        model: 'subscription.subscription',
        measure: 'sum:mrr',
        filter: { state: 'active' },
        w: 3,
      },
      {
        id: 'running',
        title: 'Running',
        kind: 'kpi',
        model: 'subscription.subscription',
        measure: 'count',
        filter: { state: 'active' },
        w: 3,
      },
      {
        id: 'started',
        title: 'Started this month',
        kind: 'kpi',
        model: 'subscription.subscription',
        measure: 'count',
        filter: { state: { in: ['active', 'paused', 'closed'] } },
        comparison: { field: 'dateStart', mode: 'previous' },
        w: 3,
      },
      {
        id: 'churned',
        title: 'Closed this month',
        kind: 'kpi',
        model: 'subscription.subscription',
        measure: 'count',
        filter: { state: 'closed' },
        comparison: { field: 'dateEnd', mode: 'previous' },
        w: 3,
      },
      {
        id: 'mrr_by_plan',
        title: 'MRR by plan',
        kind: 'chart',
        model: 'subscription.subscription',
        measure: 'sum:mrr',
        groupBy: 'plan',
        filter: { state: 'active' },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'why_closed',
        title: 'Why they left',
        kind: 'chart',
        model: 'subscription.subscription',
        measure: 'count',
        groupBy: 'closeReason',
        filter: { state: 'closed' },
        chart: 'pie',
        w: 6,
      },
      {
        id: 'top',
        title: 'Largest subscriptions',
        kind: 'pivot',
        model: 'subscription.subscription',
        measure: 'sum:mrr',
        groupBy: 'partner',
        filter: { state: 'active' },
        w: 12,
      },
    ],
  },
  actions: {
    'subscriptions.action_subscriptions': action(Subscription, {
      label: 'Subscriptions',
      views: ['list', 'kanban', 'form', 'cohort'],
    }),
    'subscriptions.action_usage': action(SubscriptionUsage, {
      label: 'Usage',
      views: ['list', 'form'],
    }),
    'subscriptions.action_plans': action(SubscriptionPlan, {
      label: 'Plans',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'subscriptions.root', label: 'Subscriptions', app: 'subscriptions' },
    {
      id: 'subscriptions.subscriptions',
      parent: 'subscriptions.root',
      label: 'Subscriptions',
      action: 'subscriptions.action_subscriptions',
      sequence: 1,
    },
    {
      id: 'subscriptions.usage',
      parent: 'subscriptions.root',
      label: 'Usage',
      action: 'subscriptions.action_usage',
      sequence: 2,
    },
    {
      id: 'subscriptions.configuration',
      parent: 'subscriptions.root',
      label: 'Configuration',
      sequence: 9,
    },
    {
      id: 'subscriptions.plans',
      parent: 'subscriptions.configuration',
      label: 'Plans',
      action: 'subscriptions.action_plans',
      sequence: 1,
    },
  ],
  views: {
    'subscription.subscription.list': list(Subscription, {
      columns: [
        'name',
        'partner',
        'plan',
        'recurring',
        'mrr',
        { field: 'nextInvoiceDate', widget: 'daysLeft' },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['id desc'],
      decorations: {
        success: { state: 'active' },
        warning: { state: 'paused' },
        neutral: { state: 'closed' },
      },
    }),
    'subscription.subscription.kanban': kanban(Subscription, {
      groupBy: 'state',
      card: {
        title: 'partner',
        subtitle: 'name',
        footer: ['recurring', 'nextInvoiceDate'],
        badges: [{ field: 'plan', widget: 'badge' }],
      },
    }),
    // Retention: of those who started in a month, how many are still there each month after.
    'subscription.subscription.cohort': cohort(Subscription, {
      dateStart: 'dateStart',
      dateStop: 'dateEnd',
      interval: 'month',
      mode: 'retention',
    }),
    'subscription.subscription.form': form(Subscription, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('begin', { primary: true, label: 'Start' }),
          k.button('amend', {
            label: 'Apply changes',
            confirm:
              'Invoice or credit the changes of the lines for the days left in the period paid for?',
          }),
          k.button('pause', { label: 'Pause' }),
          k.button('resume', { primary: true, label: 'Resume' }),
          k.button('close', {
            label: 'Close',
            confirm: 'Close this subscription for good? No more invoices are made.',
          }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'partner', 'plan', 'dateStart', 'pricelist', 'paymentTerm']),
        k.lines('lines', [
          'product',
          { field: 'name', id: 'line_name' },
          'kind',
          'quantity',
          'manualPrice',
          'priceUnit',
          'discount',
          'taxes',
          'subtotal',
        ]),
        k.group('totals', ['recurring', 'mrr'], { label: 'Worth' }),
        k.group('billing', ['nextInvoiceDate', 'periodStart', 'periodEnd', 'periodsBilled'], {
          label: 'Billing',
          description:
            'An invoice is made for each period on its first day, by itself. A change of the lines takes effect at the next invoice, or now with Apply changes.',
        }),
        k.group('closing', ['closeReason', 'dateEnd'], {
          label: 'Closing',
          description: 'Choose the reason, then press Close.',
        }),
        k.lines(
          'invoices',
          [
            { field: 'name', id: 'invoice_name' },
            'date',
            'subscriptionPeriod',
            'amountTotal',
            { field: 'state', id: 'invoice_state' },
          ],
          { readonlyWhen: {} },
        ),
      ],
      chatter: true,
    })),
    'subscription.usage.list': list(SubscriptionUsage, {
      columns: ['date', 'line', 'quantity', 'note', 'invoice'],
      decorations: { neutral: { invoice: { isNull: false } } },
    }),
    'subscription.usage.form': form(SubscriptionUsage, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['line', 'date', 'quantity', 'note', 'invoice'])],
    })),
    'subscription.plan.list': list(SubscriptionPlan, {
      columns: ['name', 'interval', 'unit', 'trialDays', 'autoPost'],
    }),
    'subscription.plan.form': form(SubscriptionPlan, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'interval', 'unit', 'trialDays', 'autoPost'])],
    })),
  },
  search: {
    'subscription.subscription': search(Subscription, {
      fields: ['name', 'partner.name'],
      filters: {
        running: { label: 'Running', domain: { state: 'active' }, group: 'state' },
        paused: { label: 'Paused', domain: { state: 'paused' }, group: 'state' },
        closed: { label: 'Closed', domain: { state: 'closed' }, group: 'state' },
        draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
      },
      groupBy: ['plan', 'state', 'closeReason', 'dateStart:month'],
    }),
    'subscription.usage': search(SubscriptionUsage, {
      fields: ['note'],
      filters: {
        open: { label: 'Not invoiced yet', domain: { invoice: { isNull: true } } },
      },
      groupBy: ['line', 'date:month'],
    }),
    'subscription.plan': search(SubscriptionPlan, { fields: ['name'], groupBy: ['unit'] }),
  },
});
