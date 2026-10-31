/**
 * @packageDocumentation
 * `@kosh/trade_finance` (RFC 0021): the **Trade Finance** app. Import and export letters of credit under UCP 600,
 * their amendments (binding once accepted), document presentations with their discrepancies and maturities, and the
 * limits banks give.
 *
 * - `GET /api/v1/trade/alerts`   issued LCs whose latest shipment or expiry falls within the alert window
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import type { ModuleContext } from '@kosh/server';
import { action, form, kanban, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { tradeFinanceDemo } from './demo.js';
import {
  addDays,
  alertDays,
  iso,
  TradeAmendment,
  TradeLc,
  TradeLimit,
  TradePresentation,
  TradeShipment,
  tradeFinanceShutro,
} from './module.js';

export {
  alertDays,
  INCOTERMS,
  TradeAmendment,
  TradeLc,
  TradeLimit,
  TradePresentation,
  TradeShipment,
  tradeFinanceShutro,
} from './module.js';

function registerTradeRoutes({ app }: ModuleContext): void {
  app.get('/api/v1/trade/alerts', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as Env;
        const days = await alertDays(env);
        const today = iso(env.today());
        const until = addDays(today, days);
        const lcs = await (await env.model('trade.lc').search({ where: { state: 'issued' } })).load(
          {
            partner: true,
            bank: true,
          },
        );
        const alerts: {
          lc: number;
          name: string;
          what: 'shipment' | 'expiry';
          date: string;
          daysLeft: number;
        }[] = [];
        for (const lc of lcs)
          for (const [what, date] of [
            ['shipment', iso(lc.latestShipmentDate)],
            ['expiry', iso(lc.expiryDate)],
          ] as const)
            if (date <= until)
              alerts.push({
                lc: lc.id,
                name: lc.bankReference ?? lc.name,
                what,
                date,
                daysLeft: Math.round(
                  (new Date(`${date}T00:00:00`).getTime() -
                    new Date(`${today}T00:00:00`).getTime()) /
                    86_400_000,
                ),
              });
        alerts.sort((a, b) => a.date.localeCompare(b.date));
        return { days, alerts };
      },
      // Reading the alert window is an audited superuser read: not in a read-only transaction.
      { write: true },
    ),
  );
}

export const tradeFinance: ReturnType<typeof defineModule> = defineModule({
  shutro: tradeFinanceShutro,
  kosh: '^0.1.0',
  hooks: { demo: tradeFinanceDemo },
  depends: [contacts, messaging, reporting],
  app: {
    code: 'tradefinance',
    label: 'Trade Finance',
    icon: 'tradefinance',
    sequence: 31,
    category: 'Finance',
    summary: 'Letters of credit: amendments, presentations and discrepancies, bank limits, alerts',
  },
  accessLevels: {
    user: { label: 'User (LCs, presentations)', groups: ['trade_finance.user'] },
    manager: {
      label: 'Manager (limits, issuing, amendments, everything)',
      groups: ['trade_finance.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerTradeRoutes(context),
  settings: {
    sections: [
      {
        key: 'alerts',
        label: 'Alerts',
        description: 'How far ahead shipment and expiry dates are flagged.',
        keywords: 'lc letter of credit expiry shipment alert days',
        scope: 'installation',
        editors: ['trade_finance.manager'],
        fields: [
          {
            key: 'alertDays',
            type: 'integer',
            label: 'Days ahead',
            default: 15,
            min: 0,
            max: 120,
            help: 'Issued LCs whose latest shipment or expiry is this close are flagged.',
          },
        ],
      },
    ],
  },
  // The Overview (RFC 0022 step 2).
  overview: {
    cards: [
      {
        id: 'issued',
        title: 'LCs issued',
        kind: 'kpi',
        model: 'trade.lc',
        measure: 'count',
        filter: { state: 'issued' },
        w: 3,
      },
      {
        id: 'outstanding',
        title: 'Outstanding',
        kind: 'kpi',
        model: 'trade.lc',
        measure: 'sum:amount',
        filter: { state: 'issued' },
        w: 3,
      },
      {
        id: 'applied',
        title: 'Applied, not issued',
        kind: 'kpi',
        model: 'trade.lc',
        measure: 'count',
        filter: { state: 'applied' },
        w: 3,
      },
      {
        id: 'settled_month',
        title: 'Settled this month',
        kind: 'kpi',
        model: 'trade.lc',
        measure: 'sum:amount',
        filter: { state: 'settled' },
        comparison: { field: 'expiryDate', mode: 'previous' },
        w: 3,
      },
      {
        id: 'by_bank',
        title: 'Outstanding by bank',
        kind: 'pivot',
        model: 'trade.lc',
        measure: 'sum:amount',
        groupBy: 'bank',
        filter: { state: 'issued' },
        w: 6,
      },
      {
        id: 'by_direction',
        title: 'Import and export',
        kind: 'chart',
        model: 'trade.lc',
        measure: 'count',
        groupBy: 'direction',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'expiring',
        title: 'Expiring by month',
        kind: 'chart',
        model: 'trade.lc',
        measure: 'sum:amount',
        groupBy: 'expiryDate:month',
        filter: { state: 'issued' },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'biggest',
        title: 'Biggest open LCs',
        kind: 'list',
        model: 'trade.lc',
        measure: 'sum:amount',
        filter: { state: { in: ['applied', 'issued'] } },
        w: 6,
      },
    ],
  },
  actions: {
    'tradefinance.action_lcs': action(TradeLc, {
      label: 'Letters of credit',
      views: ['list', 'kanban', 'form'],
      defaultFilters: ['open'],
    }),
    'tradefinance.action_presentations': action(TradePresentation, {
      label: 'Presentations',
      views: ['list', 'form'],
    }),
    'tradefinance.action_shipments': action(TradeShipment, {
      label: 'Shipments',
      views: ['list', 'form'],
    }),
    'tradefinance.action_amendments': action(TradeAmendment, {
      label: 'Amendments',
      views: ['list', 'form'],
    }),
    'tradefinance.action_limits': action(TradeLimit, {
      label: 'Bank limits',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'tradefinance.root', label: 'Trade Finance', app: 'tradefinance' },
    {
      id: 'tradefinance.lcs',
      parent: 'tradefinance.root',
      label: 'Letters of credit',
      action: 'tradefinance.action_lcs',
      sequence: 1,
    },
    {
      id: 'tradefinance.presentations',
      parent: 'tradefinance.root',
      label: 'Presentations',
      action: 'tradefinance.action_presentations',
      sequence: 2,
    },
    {
      id: 'tradefinance.shipments',
      parent: 'tradefinance.root',
      label: 'Shipments',
      action: 'tradefinance.action_shipments',
      sequence: 2,
    },
    {
      id: 'tradefinance.amendments',
      parent: 'tradefinance.root',
      label: 'Amendments',
      action: 'tradefinance.action_amendments',
      sequence: 3,
    },
    {
      id: 'tradefinance.limits',
      parent: 'tradefinance.root',
      label: 'Bank limits',
      action: 'tradefinance.action_limits',
      sequence: 4,
    },
  ],
  views: {
    'trade.lc.list': list(TradeLc, {
      columns: [
        'name',
        'bankReference',
        'direction',
        'partner',
        'bank',
        'amount',
        'latestShipmentDate',
        'expiryDate',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'trade.lc.kanban': kanban(TradeLc, {
      groupBy: 'state',
      card: {
        title: 'name',
        subtitle: 'partner',
        footer: ['amount', 'expiryDate'],
        badges: [{ field: 'direction', widget: 'badge' }],
      },
    }),
    'trade.lc.form': form(TradeLc, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('apply', { primary: true, label: 'Apply' }),
          k.button('issue', { primary: true, label: 'Issued by the bank' }),
          k.button('settle', { label: 'Close' }),
          k.button('cancel', { label: 'Cancel' }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('parties', ['direction', 'bank', 'bankReference', 'partner', 'origin']),
        k.group('money', [
          'currency',
          'amount',
          'tolerance',
          'payment',
          'usanceDays',
          'marginPercent',
        ]),
        k.group('dates', [
          'applicationDate',
          'issueDate',
          'latestShipmentDate',
          'expiryDate',
          'expiryPlace',
        ]),
        k.group('shipping', ['incoterm', 'partialShipment', 'transshipment']),
        k.group('drawings', ['maxDrawable', 'shipped', 'drawn', 'paid', 'outstanding']),
        k.group('docs', ['documents'], { columns: 1 }),
        k.lines('shipments', [
          { field: 'date', id: 'shipment_date' },
          { field: 'blNumber', id: 'shipment_bl' },
          { field: 'vessel', id: 'shipment_vessel' },
          { field: 'eta', id: 'shipment_eta' },
          { field: 'value', id: 'shipment_value' },
        ]),
        k.lines('presentations', [
          { field: 'date', id: 'presentation_date' },
          { field: 'amount', id: 'presentation_amount' },
          { field: 'waived', id: 'presentation_waived' },
          { field: 'maturityDate', id: 'presentation_maturity' },
          { field: 'state', id: 'presentation_state' },
        ]),
        k.lines('amendments', [
          { field: 'date', id: 'amendment_date' },
          { field: 'newAmount', id: 'amendment_amount' },
          { field: 'newExpiryDate', id: 'amendment_expiry' },
          { field: 'state', id: 'amendment_state' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'trade.lc.presentation.list': list(TradePresentation, {
      columns: [
        'lc',
        'date',
        'amount',
        'maturityDate',
        'paidOn',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'trade.lc.presentation.form': form(TradePresentation, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('accept', { primary: true, label: 'Accept' }),
          k.button('pay', { primary: true, label: 'Paid' }),
          k.button('refuse', { label: 'Refuse' }),
        ],
      },
      sheet: [
        k.group('main', ['lc', 'date', 'amount']),
        k.group('docs', ['documents', 'discrepancies', 'waived'], { columns: 1 }),
        k.group('dates', ['acceptedOn', 'maturityDate', 'paidOn']),
      ],
    })),
    'trade.lc.amendment.list': list(TradeAmendment, {
      columns: [
        'lc',
        'date',
        'newAmount',
        'newExpiryDate',
        'newShipmentDate',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'trade.lc.amendment.form': form(TradeAmendment, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('accept', { primary: true, label: 'Accepted' }),
          k.button('refuse', { label: 'Refused' }),
        ],
      },
      sheet: [
        k.group('main', ['lc', 'date']),
        k.group('changes', ['newAmount', 'newExpiryDate', 'newShipmentDate']),
        k.group('about', ['note'], { columns: 1 }),
      ],
    })),
    'trade.lc.shipment.list': list(TradeShipment, {
      columns: ['lc', 'date', 'blNumber', 'vessel', 'portDischarge', 'eta', 'value'],
    }),
    'trade.lc.shipment.form': form(TradeShipment, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['lc', 'date', 'value']),
        k.group('transport', ['blNumber', 'vessel', 'portLoading', 'portDischarge', 'eta']),
        k.group('about', ['note'], { columns: 1 }),
      ],
    })),
    'trade.lc.limit.list': list(TradeLimit, { columns: ['bank', 'currency', 'amount'] }),
    'trade.lc.limit.form': form(TradeLimit, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['bank', 'currency', 'amount']),
        k.group('about', ['note'], { columns: 1 }),
      ],
    })),
  },
  search: {
    'trade.lc': search(TradeLc, {
      fields: ['name', 'bankReference', 'partner.name', 'bank.name'],
      filters: {
        open: {
          label: 'Open',
          domain: { state: { in: ['draft', 'applied', 'issued'] } },
          group: 'state',
        },
        issued: { label: 'Issued', domain: { state: 'issued' }, group: 'state' },
        imports: { label: 'Import', domain: { direction: 'import' }, group: 'direction' },
        exports: { label: 'Export', domain: { direction: 'export' }, group: 'direction' },
      },
      groupBy: ['bank', 'partner', 'currency', 'state'],
    }),
    'trade.lc.presentation': search(TradePresentation, {
      fields: ['lc.name', 'lc.bankReference'],
      filters: {
        due: { label: 'Accepted, not paid', domain: { state: 'accepted' } },
      },
      groupBy: ['lc', 'state'],
    }),
    'trade.lc.amendment': search(TradeAmendment, { fields: ['lc.name'], groupBy: ['lc', 'state'] }),
    'trade.lc.shipment': search(TradeShipment, {
      fields: ['blNumber', 'vessel', 'lc.name', 'lc.bankReference'],
      groupBy: ['lc', 'portDischarge'],
    }),
    'trade.lc.limit': search(TradeLimit, { fields: ['bank.name'], groupBy: ['bank'] }),
  },
});
