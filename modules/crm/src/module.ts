/**
 * The data layer of Pipeline (RFC 0021): deals moving through stages. A stage gives its probability and may require
 * fields before a deal enters it (checked by the server); a *won* stage wins the deal; a deal is lost with a reason
 * (unless App settings say otherwise) and reopened in one step. The weighted revenue — expected revenue × probability
 * — feeds the forecast. Salespeople see their own deals and unassigned ones; managers see all.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { installationSetting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  onchange,
  record,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;

export const CrmStage = defineModel('crm.stage', {
  label: 'Stage',
  recName: 'name',
  order: ['sequence asc', 'id asc'],
  access: { 'crm.user': READ, 'crm.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    sequence: f.integer({ required: true, default: 10 }),
    probability: f.integer({ required: true, default: 10, label: 'Probability (%)' }),
    /** Deals in this stage are won. */
    won: f.boolean({ default: false, label: 'Wins the deal' }),
    fold: f.boolean({ default: false, label: 'Folded on the board' }),
    /** Fields a deal must have to be in this stage, space separated (`expectedRevenue closeDate`). */
    requiredFields: f.char({ label: 'Required to enter' }),
  },
  sqlConstraints: {
    probabilityRange: {
      check: orm.sql`probability BETWEEN 0 AND 100`,
      message: 'A probability is from 0 to 100.',
    },
  },
});

export const CrmLostReason = defineModel('crm.lost.reason', {
  label: 'Lost reason',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'crm.user': READ, 'crm.manager': ALL },
  fields: { name: f.char({ required: true, translate: true }) },
});

/** Deal fields a stage may require, with the words shown when one is missing. */
export const REQUIRABLE: Readonly<Record<string, string>> = {
  partner: 'Customer',
  contactName: 'Contact name',
  email: 'Email',
  phone: 'Phone',
  expectedRevenue: 'Expected revenue',
  closeDate: 'Expected close date',
  salesperson: 'Salesperson',
  source: 'Source',
};

export const CrmDeal = defineModel('crm.deal', {
  label: 'Deal',
  recName: 'name',
  order: ['id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['stage', 'salesperson', 'expectedRevenue', 'lost'],
  access: { 'crm.user': ['read', 'write', 'create'], 'crm.manager': [...ALL, 'export', 'import'] },
  rules: {
    own: {
      groups: ['crm.user'],
      perms: ['read', 'write', 'create'],
      domain: { or: [{ salesperson: { $env: 'uid' } }, { salesperson: { isNull: true } }] },
    },
    all: { groups: ['crm.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Deal' }),
    partner: f.many2one('res.partner', { checkCompany: true, label: 'Customer' }),
    companyName: f.char({ label: 'Company (prospect)' }),
    contactName: f.char({ label: 'Contact name' }),
    email: f.char(),
    phone: f.char(),
    salesperson: f.many2one('res.users', { default: (env: Env) => env.userId }),
    stage: f.many2one('crm.stage', { ondelete: 'restrict' }),
    expectedRevenue: f.decimal({ scale: 2, label: 'Expected revenue' }),
    probability: f.integer({ default: 10, label: 'Probability (%)' }),
    weightedRevenue: f.decimal({
      scale: 2,
      store: true,
      label: 'Weighted revenue',
      ...compute('crm.deal', 'weightedRevenue', ['expectedRevenue', 'probability'], (deals) => {
        for (const d of deals)
          d.weightedRevenue =
            d.expectedRevenue === null
              ? null
              : d.expectedRevenue
                  .times(d.probability ?? 0)
                  .div(100)
                  .toDecimalPlaces(2);
      }),
    }),
    closeDate: f.date({ label: 'Expected close date' }),
    source: f.selection(
      {
        website: 'Website',
        referral: 'Referral',
        email: 'Email',
        phone: 'Phone call',
        event: 'Event',
        partner: 'Partner',
        other: 'Other',
      },
      {},
    ),
    priority: f.selection(
      { normal: 'Normal', good: 'Good', very_good: 'Very good', excellent: 'Excellent' },
      { required: true, default: 'normal' },
    ),
    lost: f.boolean({ default: false }),
    lostReason: f.many2one('crm.lost.reason', { ondelete: 'restrict', label: 'Lost because' }),
    status: f.selection(
      { open: 'Open', won: 'Won', lost: 'Lost' },
      {
        store: true,
        ...compute('crm.deal', 'status', ['stage.won', 'lost'], (deals) => {
          for (const d of deals)
            d.status = d.lost ? 'lost' : d.stage?.won === true ? 'won' : 'open';
        }),
      },
    ),
    description: f.text({ label: 'Notes' }),
  },
  constraints: {
    // Stage rules: a stage names the fields a deal must have to be in it.
    stageRules: {
      ...check('crm.deal', ['stage', ...Object.keys(REQUIRABLE)], async (deals) => {
        // The stages' rules, read once (a constraint depends on the deal's own fields only).
        const stageIds = [
          ...new Set([...deals].flatMap((d) => (d.stage === null ? [] : [d.stage.id]))),
        ];
        const rules = new Map<number, string[]>();
        if (stageIds.length > 0)
          for (const st of (
            await deals.env.model('crm.stage').browse(stageIds).load(['requiredFields'])
          ).read(['id', 'requiredFields']))
            rules.set(
              st['id'] as number,
              String(st['requiredFields'] ?? '')
                .split(/\s+/)
                .filter((k) => k in REQUIRABLE),
            );
        const failing: number[] = [];
        for (const d of deals) {
          const wanted = d.stage === null ? [] : (rules.get(d.stage.id) ?? []);
          const values = d as unknown as Record<string, unknown>;
          if (wanted.some((k) => values[k] === null || values[k] === undefined || values[k] === ''))
            failing.push(d.id);
        }
        return failing;
      }),
      message: 'This stage needs more details: see the stage’s required fields.',
    },
    lostWithReason: {
      ...check('crm.deal', ['lost', 'lostReason'], async (deals) => {
        if (!(await installationSetting(deals.env, 'crm.requireLostReason', true))) return [];
        return [...deals].filter((d) => d.lost && d.lostReason === null).map((d) => d.id);
      }),
      message: 'A lost deal says why it was lost.',
    },
  },
  onchange: {
    // A new stage brings its probability.
    stage: onchange('crm.deal', async (d) => {
      const stage = await d.record('stage');
      if (stage !== null) d.set('probability', stage.probability);
    }),
    // A known customer fills the contact details left empty.
    partner: onchange('crm.deal', async (d) => {
      const p = await d.record('partner');
      if (p === null) return;
      if ((d.get('email') ?? '') === '' && p.email) d.set('email', p.email);
      if ((d.get('phone') ?? '') === '' && p.phone) d.set('phone', p.phone);
    }),
  },
});

export const crmShutro = defineModule({
  name: 'crm',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'crm.user',
      label: 'Salesperson (pipeline)',
      implies: ['contacts.user', 'messaging.user'],
    }),
    orm.defineGroup({ code: 'crm.manager', label: 'Pipeline manager', implies: ['crm.user'] }),
  ],
  models: [CrmStage, CrmLostReason, CrmDeal],
  // The board every installation starts with, and the usual reasons (theirs to change afterwards).
  data: [
    record(
      'crm.stage',
      'stage_new',
      { name: 'New', sequence: 1, probability: 10 },
      { noupdate: true },
    ),
    record(
      'crm.stage',
      'stage_qualified',
      { name: 'Qualified', sequence: 2, probability: 30 },
      { noupdate: true },
    ),
    record(
      'crm.stage',
      'stage_proposal',
      {
        name: 'Proposal',
        sequence: 3,
        probability: 60,
        requiredFields: 'expectedRevenue closeDate',
      },
      { noupdate: true },
    ),
    record(
      'crm.stage',
      'stage_negotiation',
      {
        name: 'Negotiation',
        sequence: 4,
        probability: 80,
        requiredFields: 'expectedRevenue closeDate',
      },
      { noupdate: true },
    ),
    record(
      'crm.stage',
      'stage_won',
      { name: 'Won', sequence: 5, probability: 100, won: true, fold: true },
      { noupdate: true },
    ),
    record('crm.lost.reason', 'reason_price', { name: 'Too expensive' }, { noupdate: true }),
    record(
      'crm.lost.reason',
      'reason_competitor',
      { name: 'Chose a competitor' },
      { noupdate: true },
    ),
    record('crm.lost.reason', 'reason_budget', { name: 'No budget' }, { noupdate: true }),
    record('crm.lost.reason', 'reason_silent', { name: 'Stopped answering' }, { noupdate: true }),
  ],
});
