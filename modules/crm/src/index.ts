/**
 * @packageDocumentation
 * `@kosh/crm` (RFC 0021): the **Pipeline** app. Deals on a board of stages with their probability and stage rules
 * (fields a deal needs to enter a stage), won by reaching a winning stage, lost with a reason and reopened in one
 * step, duplicates found on demand, and the weighted forecast by salesperson and month.
 *
 * - `POST /api/v1/pipeline/deals/:id/lose`        `{ reason?: id }`: lost (the reason required unless switched off)
 * - `POST /api/v1/pipeline/deals/:id/reopen`      open again, in its stage
 * - `GET  /api/v1/pipeline/deals/:id/duplicates`  other deals and contacts with the same email, phone or company
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { action, form, kanban, list, pivot, search } from '@kosh/views';
import { crmDemo } from './demo.js';
import { CrmDeal, CrmLostReason, CrmStage, crmShutro } from './module.js';

export { CrmDeal, CrmLostReason, CrmStage, crmShutro, REQUIRABLE } from './module.js';

type Row = Record<string, unknown>;
interface Records {
  readonly length: number;
  readonly ids: readonly number[];
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
}
const find = async (env: Env, model: string, where: unknown, keys: readonly string[]) => {
  const set = await (
    env.model(model as never) as unknown as { search(q: unknown): Promise<Records> }
  ).search({
    where,
    limit: 20,
  });
  return { set, rows: set.length === 0 ? [] : (await set.load(keys)).read(['id', ...keys]) };
};
const idOf = (params: unknown) => {
  const id = Number((params as { id?: string }).id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'A deal id.');
  return id;
};

function registerPipelineRoutes({ app }: ModuleContext): void {
  /** The deal as the user may change it (their rules apply), or 404. */
  const deal = async (env: Env, id: number) => {
    const found = await find(env, 'crm.deal', { id }, [
      'name',
      'email',
      'phone',
      'companyName',
      'partner',
    ]);
    if (found.rows.length === 0)
      throw new HttpProblem(404, 'missing-record', 'Not found', `There is no deal ${id}.`);
    return found;
  };

  app.post('/api/v1/pipeline/deals/:id/lose', async (request) => {
    const id = idOf(request.params);
    const reason = (request.body as Row | null)?.['reason'];
    if (
      reason !== undefined &&
      reason !== null &&
      !(Number.isSafeInteger(reason) && (reason as number) > 0)
    )
      throw new HttpProblem(422, 'invalid-reason', 'Invalid reason', 'reason is a lost reason id.');
    return request.env(async (env) => {
      const { set } = await deal(env, id);
      await set.write({ lost: true, lostReason: reason ?? null });
      return { id, status: 'lost' };
    });
  });

  app.post('/api/v1/pipeline/deals/:id/reopen', async (request) => {
    const id = idOf(request.params);
    return request.env(async (env) => {
      const { set } = await deal(env, id);
      await set.write({ lost: false, lostReason: null });
      return { id, status: 'open' };
    });
  });

  app.get('/api/v1/pipeline/deals/:id/duplicates', async (request) => {
    const id = idOf(request.params);
    return request.env(async (env) => {
      const [d] = (await deal(env, id)).rows;
      const email = String(d?.['email'] ?? '').trim();
      const phone = String(d?.['phone'] ?? '').replace(/[^\d+]/g, '');
      const company = String(d?.['companyName'] ?? '').trim();
      const same: unknown[] = [];
      if (email !== '') same.push({ email: { ilike: email } });
      if (phone.length >= 6) same.push({ phone: { ilike: `%${phone.slice(-8)}%` } });
      if (company !== '') same.push({ companyName: { ilike: company } });
      if (same.length === 0) return { deals: [], contacts: [] };
      // As the user: only what they may read is offered.
      const deals = await find(env, 'crm.deal', { id: { ne: id }, or: same }, ['name', 'status']);
      const partnerSame: unknown[] = [];
      if (email !== '') partnerSame.push({ email: { ilike: email } });
      if (phone.length >= 6) partnerSame.push({ phone: { ilike: `%${phone.slice(-8)}%` } });
      if (company !== '') partnerSame.push({ name: { ilike: company } });
      const partners = await find(env, 'res.partner', { or: partnerSame }, ['name', 'email']);
      return {
        deals: deals.rows.map((r) => ({ id: r['id'], name: r['name'], status: r['status'] })),
        contacts: partners.rows.map((r) => ({
          id: r['id'],
          name: r['name'],
          email: r['email'] ?? null,
        })),
      };
    });
  });
}

export const crm: ReturnType<typeof defineModule> = defineModule({
  shutro: crmShutro,
  kosh: '^0.1.0',
  hooks: { demo: crmDemo },
  depends: [contacts, messaging],
  app: {
    code: 'pipeline',
    label: 'Pipeline',
    icon: 'pipeline',
    sequence: 8,
    category: 'Sales',
    summary: 'Deals on a board, stage rules and the weighted forecast',
  },
  accessLevels: {
    user: { label: 'Salesperson (own and unassigned deals)', groups: ['crm.user'] },
    manager: { label: 'Manager (every deal, stages)', groups: ['crm.manager'], implies: ['user'] },
  },
  settings: {
    sections: [
      {
        key: 'deals',
        label: 'Deals',
        description: 'How deals are closed.',
        keywords: 'lost reason pipeline crm opportunity',
        scope: 'installation',
        editors: ['crm.manager'],
        fields: [
          {
            key: 'requireLostReason',
            type: 'boolean',
            label: 'A lost deal needs a reason',
            default: true,
            help: 'The reasons tell what to improve; switch off to lose deals without one.',
          },
        ],
      },
    ],
  },
  routes: (context: ModuleContext) => registerPipelineRoutes(context),
  actions: {
    'pipeline.action_deals': action(CrmDeal, {
      label: 'Deals',
      views: ['kanban', 'list', 'form', 'pivot'],
      defaultFilters: ['open'],
    }),
    'pipeline.action_forecast': action(CrmDeal, {
      label: 'Forecast',
      views: ['pivot', 'list'],
      defaultFilters: ['open'],
    }),
    'pipeline.action_stages': action(CrmStage, { label: 'Stages', views: ['list', 'form'] }),
    'pipeline.action_reasons': action(CrmLostReason, {
      label: 'Lost reasons',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'pipeline.root', label: 'Pipeline', app: 'pipeline' },
    {
      id: 'pipeline.deals',
      parent: 'pipeline.root',
      label: 'Deals',
      action: 'pipeline.action_deals',
      sequence: 1,
    },
    {
      id: 'pipeline.forecast',
      parent: 'pipeline.root',
      label: 'Forecast',
      action: 'pipeline.action_forecast',
      sequence: 2,
    },
    { id: 'pipeline.configuration', parent: 'pipeline.root', label: 'Configuration', sequence: 9 },
    {
      id: 'pipeline.stages',
      parent: 'pipeline.configuration',
      label: 'Stages',
      action: 'pipeline.action_stages',
      sequence: 1,
    },
    {
      id: 'pipeline.reasons',
      parent: 'pipeline.configuration',
      label: 'Lost reasons',
      action: 'pipeline.action_reasons',
      sequence: 2,
    },
  ],
  views: {
    'crm.deal.kanban': kanban(CrmDeal, {
      groupBy: 'stage',
      card: {
        title: 'name',
        subtitle: 'partner',
        footer: ['expectedRevenue', { field: 'priority', widget: 'priority' }],
        avatar: 'salesperson',
        color: 'stage',
      },
    }),
    'crm.deal.list': list(CrmDeal, {
      columns: [
        'name',
        'partner',
        'companyName',
        'salesperson',
        'stage',
        { field: 'expectedRevenue', sum: true },
        'probability',
        { field: 'weightedRevenue', sum: true },
        { field: 'priority', widget: 'priority' },
        'closeDate',
        { field: 'status', widget: 'badge' },
      ],
      inlineEdit: ['stage', 'salesperson', 'closeDate'],
      decorations: { success: { status: 'won' }, neutral: { status: 'lost' } },
    }),
    'crm.deal.form': form(CrmDeal, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('deal', ['name', 'stage', 'salesperson', 'priority', 'status']),
        k.group('money', [
          'expectedRevenue',
          'probability',
          'weightedRevenue',
          'closeDate',
          'source',
        ]),
        k.group('who', ['partner', 'companyName', 'contactName', 'email', 'phone']),
        k.group('outcome', ['lost', 'lostReason']),
        k.group('about', ['description'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'crm.deal.pivot': pivot(CrmDeal, {
      rows: ['salesperson'],
      cols: ['closeDate:month'],
      measures: [{ sum: 'weightedRevenue' }, { sum: 'expectedRevenue' }],
    }),
    'crm.stage.list': list(CrmStage, {
      columns: ['sequence', 'name', 'probability', 'won', 'fold', 'requiredFields'],
      inlineEdit: ['name', 'probability', 'won', 'fold', 'requiredFields'],
    }),
    'crm.stage.form': form(CrmStage, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'sequence', 'probability', 'won', 'fold', 'requiredFields']),
      ],
    })),
    'crm.lost.reason.list': list(CrmLostReason, { columns: ['name'], inlineEdit: ['name'] }),
    'crm.lost.reason.form': form(CrmLostReason, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name'])],
    })),
  },
  search: {
    'crm.deal': search(CrmDeal, {
      fields: ['name', 'partner.name', 'companyName', 'contactName', 'email'],
      filters: {
        open: { label: 'Open', domain: { status: 'open' }, group: 'status' },
        won: { label: 'Won', domain: { status: 'won' }, group: 'status' },
        lost: { label: 'Lost', domain: { status: 'lost' }, group: 'status' },
        mine: { label: 'Mine', domain: { salesperson: { $env: 'uid' } } },
        unassigned: { label: 'Unassigned', domain: { salesperson: { isNull: true } } },
      },
      groupBy: ['stage', 'salesperson', 'source', 'closeDate:month'],
    }),
    'crm.stage': search(CrmStage, { fields: ['name'] }),
    'crm.lost.reason': search(CrmLostReason, { fields: ['name'] }),
  },
});
