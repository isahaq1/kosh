/**
 * The automation builder's models (RFC 0011): rules ("when X, then Y", edited in the Automation app), runs (what
 * a rule did on a record, or why it did not), and the audit cursor of the engine. Rules and runs are served by
 * the generated API under the module's groups; the cursor is private.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const { defineGroup, defineModel, defineModule, f } = orm;

export const TRIGGERS = [
  'created',
  'updated',
  'deleted',
  'transition',
  'event',
  'date',
  'schedule',
] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const ACTION_KINDS = [
  'set',
  'transition',
  'activity',
  'notify',
  'note',
  'comment',
  'create',
  'webhook',
  'action',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** A rule: the trigger, its condition, the actions, who they run as. */
const Rule = defineModel('automation.rule', {
  label: 'Automation rule',
  recName: 'name',
  archivable: true,
  companyScoped: { required: true },
  order: ['targetModel asc', 'sequence asc', 'id asc'],
  tracking: ['enabled', 'trigger', 'targetModel', 'runAs'],
  access: { 'automation.manager': ALL, 'automation.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    targetModel: f.char({ required: true, label: 'Model' }),
    sequence: f.integer({ required: true, default: 10 }),
    enabled: f.boolean({ default: true }),
    trigger: f.selection(
      {
        created: 'Record created',
        updated: 'Record updated',
        deleted: 'Record deleted',
        transition: 'State transition',
        event: 'Event emitted',
        date: 'Date reached',
        schedule: 'Schedule',
      },
      { required: true, default: 'created' },
    ),
    /** `updated`: the fields that must have changed (tracked ones); `transition`: the state field. */
    watchFields: f.json({ label: 'Watched fields' }),
    /** `updated` / `transition`: the new values that fire it (`{ state: 'sale' }`). */
    toValues: f.json({ label: 'When it becomes' }),
    /** `updated` / `transition`: the old values that fire it (`{ state: 'draft' }`). */
    fromValues: f.json({ label: 'When it was' }),
    /** `event`: the outbox topic. */
    topic: f.char(),
    /** `date`: the date field and the offset in days. */
    dateField: f.char(),
    dateOffsetDays: f.integer({ default: 0 }),
    /** `schedule`: a cron expression (UTC; `0 2 * * *`, `@daily`). */
    cron: f.char(),
    /** Signs the rule's webhooks (`X-Kosh-Signature`); made on first use. */
    webhookSecret: f.char({ label: 'Webhook secret' }),
    /** A Shutro domain the record must match after the change. */
    condition: f.json(),
    /** The ordered actions: `[{ kind, ...params }]`. */
    actions: f.json({ required: true, default: [] }),
    runAs: f.selection(
      { actor: 'The user whose change fired it', system: 'The system' },
      { required: true, default: 'actor' },
    ),
    /** `date` and `schedule` triggers without an actor: this user, else the system. */
    runAsUser: f.many2one('res.users', { ondelete: 'set null' }),
    /** Post "Rule X did Y" on the record's chatter after a run. */
    logOnRecord: f.boolean({ default: false }),
    description: f.text(),
    lastRunAt: f.datetime(),
  },
});

/** One run of a rule on a record: done, failed, or skipped with the reason. */
const Run = defineModel('automation.run', {
  label: 'Automation run',
  order: ['id desc'],
  companyScoped: { required: true },
  access: { 'automation.manager': ['read', 'write', 'unlink'], 'automation.user': ['read'] },
  indexes: [{ fields: ['rule', 'tx', 'targetId'], unique: true }, { fields: ['state'] }],
  fields: {
    rule: f.many2one('automation.rule', { required: true, ondelete: 'cascade' }),
    trigger: f.char({ required: true }),
    targetModel: f.char({ required: true, label: 'Model' }),
    targetId: f.integer({ label: 'Record' }),
    /** The transaction (audit) or event id that fired it; a retry gets `retry:<run id>`. */
    tx: f.char({ required: true }),
    actor: f.many2one('res.users', { ondelete: 'set null' }),
    startedAt: f.datetime({ required: true }),
    finishedAt: f.datetime(),
    state: f.selection(
      { done: 'Done', failed: 'Failed', skipped: 'Skipped', queued: 'Queued' },
      { required: true, default: 'queued' },
    ),
    /** Why it was skipped (`condition`, `loop`, `depth`, `untracked`, `no-actor`). */
    reason: f.char(),
    /** `[{ kind, outcome, error? }]`. */
    outcomes: f.json({ default: [] }),
    error: f.text(),
  },
});

/** The engine's position on the audit trail (one row per feed). Private. */
const Cursor = defineModel('automation.cursor', {
  fields: {
    name: f.char({ required: true, index: 'unique' }),
    position: f.integer({ required: true, default: 0 }),
  },
});

export const automationShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'automation',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
    defineGroup({ code: 'automation.user', label: 'Automation (runs)', implies: ['base.user'] }),
    defineGroup({
      code: 'automation.manager',
      label: 'Automation manager (rules)',
      implies: ['automation.user'],
    }),
  ],
  models: [Rule, Run, Cursor],
});
