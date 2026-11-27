/**
 * The data layer of Field service (RFC 0038, step 8): **visits** to customers — where (with coordinates, for the
 * map and the route), when, by which technician, what is wrong —; on site the technician works through the
 * **checklist**, writes what was done, notes the **parts and labour**, and the customer **signs** on the phone.
 *
 * A technician sees and works their own visits; a dispatcher plans everyone's. A visit is done only when every
 * item of its checklist is ticked, the report is written and the customer has signed (unless no signature is
 * asked). What other apps do with a done visit (the invoice) hangs on its hook `completed`.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  onchange,
  records,
} from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;
const me = { $env: 'uid' } as const;
const USER = 'field_service.user';
const MANAGER = 'field_service.manager';
const zero: Decimal = orm.toDecimal(0);

/** A technician's own visits, read and worked; a dispatcher's, every visit. */
const OWN_VISITS = {
  own: { groups: [USER], perms: ['read', 'write'], domain: { technician: me } },
  all: { groups: [MANAGER], perms: [...ALL], domain: {} },
} as const;
const OWN_LINES = {
  own: {
    groups: [USER],
    perms: ['read', 'write', 'create', 'unlink'],
    domain: { 'visit.technician': me },
  },
  all: { groups: [MANAGER], perms: [...ALL], domain: {} },
} as const;

export const FieldCheck = defineModel('field.visit.check', {
  label: 'Visit checklist item',
  order: ['sequence asc', 'id asc'],
  access: { [USER]: [...ALL], [MANAGER]: [...ALL, 'export'] },
  rules: OWN_LINES,
  fields: {
    visit: f.many2one('field.visit', { required: true, ondelete: 'cascade', index: true }),
    sequence: f.integer({ required: true, default: 10 }),
    name: f.char({ required: true, label: 'To do' }),
    done: f.boolean({ default: false, label: 'Done' }),
    note: f.char({ label: 'Note' }),
  },
});

export const FieldLine = defineModel('field.visit.line', {
  label: 'Visit line',
  order: ['id asc'],
  access: { [USER]: [...ALL], [MANAGER]: [...ALL, 'export'] },
  rules: OWN_LINES,
  fields: {
    visit: f.many2one('field.visit', { required: true, ondelete: 'cascade', index: true }),
    kind: f.selection(
      { part: 'Part', labour: 'Labour' },
      {
        required: true,
        default: 'part',
        label: 'What',
        help: 'A part used on site, or the hours worked.',
      },
    ),
    product: f.many2one('product.product', { ondelete: 'restrict', label: 'Product' }),
    name: f.char({ required: true, label: 'Description' }),
    quantity: f.decimal({ scale: 2, required: true, default: '1', label: 'Quantity' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Unit price' }),
    subtotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Amount',
      help: 'The quantity at the unit price.',
      ...compute('field.visit.line', 'subtotal', ['quantity', 'priceUnit'], (lines) => {
        for (const l of lines)
          l.subtotal = (l.quantity ?? zero).times(l.priceUnit ?? zero).toDecimalPlaces(2);
      }),
    }),
  },
  onchange: {
    product: onchange('field.visit.line', async (d) => {
      const p = await d.record('product');
      if (p === null || p === undefined) return;
      d.set('name', p.name);
      d.set('priceUnit', p.listPrice);
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`quantity > 0 AND price_unit >= 0`,
      message: 'A line has a quantity above zero and a price that is not negative.',
    },
  },
  constraints: {
    partNamed: {
      ...check('field.visit.line', ['kind', 'product'], (lines) =>
        [...lines].filter((l) => l.kind === 'part' && l.product === null).map((l) => l.id),
      ),
      message: 'A part is a product: choose it.',
    },
    // What was signed for is what is invoiced.
    asSigned: {
      ...check('field.visit.line', ['kind', 'product', 'quantity', 'priceUnit'], async (lines) =>
        [...(await lines.load({ visit: true }))]
          .filter((l) => l.visit.signedAt !== null || l.visit.state === 'done')
          .map((l) => l.id),
      ),
      message: 'The customer signed for these lines: they no longer change.',
    },
  },
});

/** The visits among these whose work is not finished: an item to do, no report, or no signature asked for. */
const unfinished = records('field.visit', async (visits) =>
  [...(await visits.load({ checks: true }))]
    .filter(
      (v) =>
        [...v.checks].some((c) => c.done !== true) ||
        (v.report ?? '').trim() === '' ||
        (v.signatureRequired === true && v.signedAt === null),
    )
    .map((v) => v.id),
);

export const FieldVisit = defineModel('field.visit', {
  label: 'Field visit',
  recName: 'name',
  order: ['plannedStart asc', 'id asc'],
  companyScoped: { required: true },
  tracking: ['state', 'technician', 'plannedStart'],
  access: {
    [USER]: ['read', 'write'],
    [MANAGER]: [...ALL, 'export', 'import'],
  },
  rules: OWN_VISITS,
  fields: {
    name: f.char({ required: true, sequence: 'field.visit', label: 'Reference' }),
    partner: f.many2one('res.partner', {
      required: true,
      ondelete: 'restrict',
      index: true,
      label: 'Customer',
    }),
    address: f.char({ label: 'Address', help: 'Where to go: from the customer, or typed.' }),
    latitude: f.decimal({
      scale: 6,
      label: 'Latitude',
      help: 'From the customer when chosen. Places the visit on the map and in the route.',
    }),
    longitude: f.decimal({ scale: 6, label: 'Longitude' }),
    technician: f.many2one('res.users', {
      ondelete: 'set null',
      index: true,
      label: 'Technician',
      help: 'Who goes: they see and work the visit on their phone.',
    }),
    plannedStart: f.datetime({ required: true, label: 'Planned for' }),
    hours: f.decimal({ scale: 2, required: true, default: '1', label: 'Planned hours' }),
    problem: f.text({ required: true, label: 'What is wrong' }),
    report: f.text({ label: 'What was done', help: 'Written by the technician on site.' }),
    checks: f.one2many('field.visit.check', 'visit', { label: 'Checklist' }),
    lines: f.one2many('field.visit.line', 'visit', { label: 'Parts and labour' }),
    billable: f.boolean({
      default: true,
      label: 'Charged',
      help: 'Off: a visit under contract or warranty — nothing is invoiced.',
    }),
    signatureRequired: f.boolean({
      default: true,
      label: 'Customer signs',
      help: 'The visit is done only once the customer has signed on the technician’s phone.',
    }),
    signature: f.text({ label: 'Signature', groups: { write: [...SYSTEM] } }),
    signedBy: f.char({ label: 'Signed by', groups: { write: [...SYSTEM] } }),
    signedAt: f.datetime({ label: 'Signed at', groups: { write: [...SYSTEM] } }),
    startedAt: f.datetime({ label: 'Started at', groups: { write: [...SYSTEM] } }),
    finishedAt: f.datetime({ label: 'Finished at', groups: { write: [...SYSTEM] } }),
    amountTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Amount',
      help: 'Parts and labour, before taxes.',
      ...compute('field.visit', 'amountTotal', ['lines.subtotal'], (visits) => {
        for (const v of visits)
          v.amountTotal = [...v.lines].reduce((s, l) => s.plus(l.subtotal ?? zero), zero);
      }),
    }),
    state: f.state({
      states: { planned: 'Planned', started: 'On site', done: 'Done', cancel: 'Cancelled' },
      initial: 'planned',
      help: 'Planned by the dispatcher, started by the technician on site, done once the checklist is ticked, the report written and the customer has signed.',
      transitions: {
        begin: emitting('field.visit.started', {
          from: ['planned'],
          to: 'started',
          guard: records('field.visit', async (visits) =>
            [...(await visits.load(['technician']))]
              .filter((v) => v.technician === null)
              .map((v) => v.id),
          ),
          message: 'Give the visit to a technician first.',
          after: records('field.visit', async (visits): Promise<void> => {
            const env = visits.env as unknown as Env;
            await env.asSuperuser({ reason: 'visit started' }, async (su) => {
              await su
                .model('field.visit')
                .browse(visits.ids)
                .write({ startedAt: new Date() } as never);
              await su.flush();
            });
          }),
        }),
        finish: emitting('field.visit.done', {
          from: ['started'],
          to: 'done',
          guard: unfinished,
          message:
            'Not finished: tick every item of the checklist, write what was done, and have the customer sign.',
          after: records('field.visit', async (visits): Promise<void> => {
            const env = visits.env as unknown as Env;
            await env.asSuperuser({ reason: 'visit done' }, async (su) => {
              await su
                .model('field.visit')
                .browse(visits.ids)
                .write({ finishedAt: new Date() } as never);
              await su.flush();
            });
            await env.model('field.visit').browse(visits.ids).completed();
          }),
        }),
        cancel: { from: ['planned', 'started'], to: 'cancel' },
        replan: { from: ['cancel'], to: 'planned' },
      },
    }),
  },
  methods: {
    /** Runs once these visits are done. Nothing here; `field_service_account` drafts the invoice. */
    completed: method('field.visit', async (): Promise<void> => undefined),
  },
  onchange: {
    // Where to go: the customer's address and place, to start with.
    partner: onchange('field.visit', async (d) => {
      const p = await d.record('partner');
      if (p === null || p === undefined) return;
      const address = [p.street, p.city].filter((x) => x !== null && x !== '').join(', ');
      if (address !== '') d.set('address', address);
      if (p.latitude !== null) d.set('latitude', p.latitude);
      if (p.longitude !== null) d.set('longitude', p.longitude);
    }),
  },
  sqlConstraints: {
    hours: { check: orm.sql`hours > 0`, message: 'A visit is planned for some time.' },
    place: {
      check: orm.sql`(latitude IS NULL OR latitude BETWEEN -90 AND 90)
        AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)`,
      message: 'A latitude is between -90 and 90, a longitude between -180 and 180.',
    },
  },
  constraints: {
    // A technician works the visit; the dispatcher decides who goes, where and when.
    planningIsTheDispatchers: {
      ...check(
        'field.visit',
        ['technician', 'plannedStart', 'partner', 'billable', 'signatureRequired'],
        async (visits) => {
          const env = visits.env as unknown as Env;
          if (env.su || env.access.has('field_service.dispatch')) return [];
          return visits.ids.map(Number);
        },
      ),
      message: 'Who goes, where and when are the dispatcher’s to decide.',
    },
  },
});

/**
 * The customer signs: the drawing and their name are kept on the visit, with when — once, while the technician is
 * on site. As the person asking, so that only the visit's technician (or a dispatcher) can.
 */
export async function signVisit(
  env: Env,
  id: number,
  name: string,
  image: string,
): Promise<'signed' | 'missing' | 'not-on-site' | 'signed-already'> {
  const [v] = await env
    .model('field.visit')
    .search({ where: { id } as never, limit: 1 })
    .then((r) => r.load(['state', 'signedAt']));
  if (v === undefined) return 'missing';
  if (v.state !== 'started') return 'not-on-site';
  if (v.signedAt !== null) return 'signed-already';
  await env.asSuperuser({ reason: 'customer signed' }, async (su) => {
    await su
      .model('field.visit')
      .browse([id] as never)
      .write({ signature: image, signedBy: name.slice(0, 120), signedAt: new Date() } as never);
    await su.flush();
  });
  return 'signed';
}

export const fieldServiceShutro = defineModule({
  name: 'field_service',
  version: '0.1.0',
  depends: [contactsShutro, productShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: USER,
      label: 'Field service: technician',
      implies: ['contacts.user', 'product.user'],
    }),
    orm.defineGroup({ code: MANAGER, label: 'Field service: dispatcher', implies: [USER] }),
  ],
  permissions: [
    orm.definePermission({
      code: 'field_service.dispatch',
      label: 'Plan visits: who goes, where and when',
      groups: [MANAGER],
    }),
  ],
  sequences: [
    orm.defineSequence({ code: 'field.visit', prefix: 'FS/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [FieldVisit, FieldCheck, FieldLine],
});
