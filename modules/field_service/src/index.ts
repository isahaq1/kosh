/**
 * @packageDocumentation
 * `@kosh/field_service`: Field service (RFC 0038, step 8) — visits at customers on a map and a short route, a
 * checklist and a report on the technician's phone, parts and labour, the customer's signature.
 *
 * - `GET  /api/v1/field-service/route?date=YYYY-MM-DD[&technician=]`  the day's visits in a short order
 * - `POST /api/v1/field-service/visits/:id/sign`  `{ name, image }`: the customer's drawn signature (a data address)
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, calendar, form, kanban, list, map, search, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { fieldServiceDemo } from './demo.js';
import { FieldCheck, FieldLine, FieldVisit, fieldServiceShutro, signVisit } from './module.js';
import { isSignature, routeOf } from './route.js';

export {
  FieldCheck,
  FieldLine,
  FieldVisit,
  fieldServiceShutro,
  signVisit,
} from './module.js';
export { distanceKm, isSignature, routeOf, SIGNATURE_LIMIT, type Stop } from './route.js';

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(String(v));

function registerFieldRoutes(context: ModuleContext): void {
  const { app } = context;

  app.get('/api/v1/field-service/route', async (request) => {
    const q = request.query as { date?: unknown; technician?: unknown };
    const date = String(q.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new HttpProblem(400, 'invalid-query', 'Invalid day', 'Give date as YYYY-MM-DD.');
    return request.env(async (raw) => {
      const env = raw as unknown as Env;
      const technician = q.technician === undefined ? env.uid : Number(q.technician);
      const from = new Date(`${date}T00:00:00Z`);
      const to = new Date(from.getTime() + 86_400_000);
      // As the person asking: a technician sees their own visits, a dispatcher anyone's.
      const visits = await env
        .model('field.visit')
        .search({
          where: {
            technician,
            state: { in: ['planned', 'started'] },
            plannedStart: { gte: from.toISOString(), lt: to.toISOString() },
          } as never,
          order: ['plannedStart asc', 'id asc'],
        })
        .then((r) => r.load({ partner: true }));
      const list = [...visits];
      const order = routeOf(
        list.map((v) => ({
          id: v.id as number,
          latitude: num(v.latitude),
          longitude: num(v.longitude),
        })),
      );
      const byId = new Map(list.map((v) => [v.id as number, v]));
      let km = 0;
      const stops = order.map((o, i) => {
        const v = byId.get(o.id);
        km += o.legKm ?? 0;
        return {
          position: i + 1,
          id: o.id,
          name: v?.name,
          customer: v?.partner.name,
          address: v?.address,
          plannedStart: v?.plannedStart,
          state: v?.state,
          legKm: o.legKm,
        };
      });
      return { date, technician, stops, totalKm: Math.round(km * 10) / 10 };
    });
  });

  app.post('/api/v1/field-service/visits/:id/sign', { bodyLimit: 512 * 1024 }, async (request) => {
    const id = Number((request.params as { id?: unknown }).id);
    const body = (request.body ?? {}) as { name?: unknown; image?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!Number.isInteger(id) || name === '' || !isSignature(body.image))
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid signature',
        'Send { name, image }: who signs, and the drawing as a PNG or JPEG data address.',
      );
    const image = body.image;
    return request.env(
      async (raw) => {
        const outcome = await signVisit(raw as unknown as Env, id, name, image);
        if (outcome === 'missing')
          throw new HttpProblem(404, 'missing-record', 'Not found', `There is no visit ${id}.`);
        if (outcome === 'not-on-site')
          throw new HttpProblem(
            409,
            'not-on-site',
            'Not on site',
            'The customer signs while the visit is under way.',
          );
        if (outcome === 'signed-already')
          throw new HttpProblem(409, 'signed', 'Signed already', 'The customer has signed.');
        return { signed: true };
      },
      { write: true },
    );
  });
}

const OPEN = ['planned', 'started'];

export const fieldService: ReturnType<typeof defineModule> = defineModule({
  shutro: fieldServiceShutro,
  kosh: '^0.1.0',
  hooks: { demo: fieldServiceDemo },
  depends: [contacts, product, messaging, reporting],
  app: {
    code: 'field_service',
    label: 'Field service',
    icon: 'field_service',
    sequence: 19,
    category: 'Operations',
    summary:
      'Visits on a map and a short route, worksheets on the phone, parts, the customer’s signature',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Technician (one’s own visits)', groups: ['field_service.user'] },
    manager: {
      label: 'Dispatcher (plans everyone’s visits)',
      groups: ['field_service.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerFieldRoutes(context),
  events: [
    { topic: 'field.visit.started', model: 'field.visit', label: 'Visit started' },
    { topic: 'field.visit.done', model: 'field.visit', label: 'Visit done' },
  ],
  documents: [
    {
      key: 'field_visit',
      name: 'Visit report',
      model: 'field.visit',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Visit report {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Customer', bind: 'partner.name' },
              { label: 'Address', bind: 'address' },
              { label: 'Technician', bind: 'technician.name' },
              { label: 'Started at', bind: 'startedAt' },
              { label: 'Finished at', bind: 'finishedAt' },
            ],
          },
          { kind: 'text', id: 'problem', text: '{{problem}}' },
          { kind: 'text', id: 'report', text: '{{report}}' },
          {
            kind: 'table',
            id: 'checks',
            bind: 'checks',
            columns: [
              { label: 'To do', bind: 'name' },
              { label: 'Done', bind: 'done' },
              { label: 'Note', bind: 'note' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'What', bind: 'kind' },
              { label: 'Description', bind: 'name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Unit price', bind: 'priceUnit' },
              { label: 'Amount', bind: 'subtotal' },
            ],
          },
          {
            kind: 'fields',
            id: 'signed',
            items: [
              { label: 'Signed by', bind: 'signedBy' },
              { label: 'Signed at', bind: 'signedAt' },
            ],
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'field_visits',
      model: 'field.visit',
      label: 'Field visits',
      columns: [
        { header: 'Customer', field: 'partner' },
        { header: 'Address', field: 'address' },
        { header: 'Latitude', field: 'latitude' },
        { header: 'Longitude', field: 'longitude' },
        { header: 'Technician', field: 'technician' },
        { header: 'Planned for', field: 'plannedStart' },
        { header: 'Planned hours', field: 'hours' },
        { header: 'What is wrong', field: 'problem' },
        { header: 'Charged', field: 'billable' },
      ],
    },
  ],
  overview: {
    cards: [
      {
        id: 'planned',
        title: 'Planned',
        kind: 'kpi',
        model: 'field.visit',
        measure: 'count',
        filter: { state: 'planned' },
        w: 3,
      },
      {
        id: 'on_site',
        title: 'On site now',
        kind: 'kpi',
        model: 'field.visit',
        measure: 'count',
        filter: { state: 'started' },
        w: 3,
      },
      {
        id: 'done_month',
        title: 'Done this month',
        kind: 'kpi',
        model: 'field.visit',
        measure: 'count',
        filter: { state: 'done' },
        comparison: { field: 'plannedStart', mode: 'previous' },
        w: 3,
      },
      {
        id: 'charged',
        title: 'Charged',
        kind: 'kpi',
        model: 'field.visit',
        measure: 'sum:amountTotal',
        filter: { state: 'done', billable: true },
        w: 3,
      },
      {
        id: 'by_technician',
        title: 'Open visits by technician',
        kind: 'pivot',
        model: 'field.visit',
        measure: 'count',
        groupBy: 'technician',
        filter: { state: { in: OPEN } },
        w: 6,
      },
      {
        id: 'by_state',
        title: 'Visits by state',
        kind: 'chart',
        model: 'field.visit',
        measure: 'count',
        groupBy: 'state',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_month',
        title: 'Visits by month',
        kind: 'chart',
        model: 'field.visit',
        measure: 'count',
        groupBy: 'plannedStart:month',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_customer',
        title: 'Visits by customer',
        kind: 'pivot',
        model: 'field.visit',
        measure: 'count',
        groupBy: 'partner',
        w: 6,
      },
    ],
  },
  actions: {
    'field_service.action_visits': action(FieldVisit, {
      label: 'Visits',
      views: ['list', 'kanban', 'calendar', 'map', 'form'],
    }),
    'field_service.action_lines': action(FieldLine, {
      label: 'Parts and labour',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'field_service.root', label: 'Field service', app: 'field_service' },
    {
      id: 'field_service.visits',
      parent: 'field_service.root',
      label: 'Visits',
      action: 'field_service.action_visits',
      sequence: 1,
    },
    {
      id: 'field_service.lines',
      parent: 'field_service.root',
      label: 'Parts and labour',
      action: 'field_service.action_lines',
      sequence: 2,
    },
  ],
  viewExtensions: [
    {
      view: 'res.partner.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'partner_visits',
              label: 'Field visits',
              model: FieldVisit,
              where: { partner: { $record: 'id' } },
              action: 'field_service.action_visits',
            }),
          ],
        },
      ],
    },
  ],
  views: {
    'field.visit.list': list(FieldVisit, {
      columns: [
        'name',
        'plannedStart',
        'partner',
        'address',
        'technician',
        { field: 'amountTotal', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      decorations: {
        info: { state: 'started' },
        success: { state: 'done' },
        neutral: { state: 'cancel' },
      },
    }),
    'field.visit.kanban': kanban(FieldVisit, {
      groupBy: 'state',
      card: {
        title: 'partner',
        subtitle: 'address',
        footer: ['name', 'plannedStart', 'technician'],
      },
    }),
    'field.visit.calendar': calendar(FieldVisit, {
      dateStart: 'plannedStart',
      title: 'partner',
      color: 'technician',
      mode: 'week',
    }),
    'field.visit.map': map(FieldVisit, {
      latitude: 'latitude',
      longitude: 'longitude',
      title: 'partner',
      subtitle: 'address',
    }),
    'field.visit.form': form(FieldVisit, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('begin', { primary: true, label: 'Start the visit' }),
          k.button('finish', { primary: true, label: 'Done' }),
          k.button('cancel', { label: 'Cancel' }),
          k.button('replan', { label: 'Plan again' }),
        ],
      },
      readonlyWhen: { state: { in: ['done', 'cancel'] } },
      sheet: [
        k.group('main', ['name', 'partner', 'technician', 'plannedStart', 'hours'], {
          description: 'Who goes, where and when are the dispatcher’s to decide.',
        }),
        k.group('place', ['address', 'latitude', 'longitude'], { label: 'Where' }),
        k.group('work', ['problem', 'report'], { label: 'The work', columns: 1 }),
        k.lines('checks', [
          { field: 'name', id: 'check_name' },
          { field: 'done', id: 'check_done' },
          { field: 'note', id: 'check_note' },
        ]),
        k.lines('lines', [
          { field: 'kind', id: 'line_kind' },
          { field: 'product', id: 'line_product' },
          { field: 'name', id: 'line_name' },
          { field: 'quantity', id: 'line_quantity' },
          { field: 'priceUnit', id: 'line_price' },
          { field: 'subtotal', id: 'line_subtotal' },
        ]),
        k.group('money', ['billable', 'amountTotal'], { label: 'Charge' }),
        k.group('signing', ['signatureRequired', 'signedBy', 'signedAt'], {
          label: 'Customer’s signature',
          description:
            'Signed on the technician’s phone while the visit is under way. The lines no longer change once signed.',
        }),
        k.group('times', ['startedAt', 'finishedAt'], { label: 'When' }),
      ],
      chatter: true,
    })),
    'field.visit.line.list': list(FieldLine, {
      columns: [
        'visit',
        'kind',
        'product',
        'name',
        'quantity',
        'priceUnit',
        { field: 'subtotal', sum: true },
      ],
    }),
    'field.visit.line.form': form(FieldLine, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['visit', 'kind', 'product', 'name', 'quantity', 'priceUnit'])],
    })),
    'field.visit.check.list': list(FieldCheck, { columns: ['visit', 'name', 'done', 'note'] }),
    'field.visit.check.form': form(FieldCheck, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['visit', 'name', 'done', 'note'])],
    })),
  },
  search: {
    'field.visit': search(FieldVisit, {
      fields: ['name', 'partner.name', 'address', 'technician.name'],
      filters: {
        mine: { label: 'Mine', domain: { technician: { $env: 'uid' } }, group: 'who' },
        planned: { label: 'Planned', domain: { state: 'planned' }, group: 'state' },
        started: { label: 'On site', domain: { state: 'started' }, group: 'state' },
        done: { label: 'Done', domain: { state: 'done' }, group: 'state' },
      },
      groupBy: ['state', 'technician', 'partner', 'plannedStart:day'],
    }),
    'field.visit.line': search(FieldLine, {
      fields: ['name', 'product.name', 'visit.name'],
      groupBy: ['kind', 'product'],
    }),
    'field.visit.check': search(FieldCheck, { fields: ['name', 'visit.name'], groupBy: ['done'] }),
  },
});
