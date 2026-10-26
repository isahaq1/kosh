/**
 * The automation engine (RFC 0011 §5.2–5.4): changes come from Shutro's audit trail (a cursor, one worker at a
 * time) and from outbox events; the rules of the changed model are evaluated (trigger, watched fields, from / to
 * values, condition) and their actions run as the actor whose change fired them or as the system, in one
 * transaction per run, with a run row that keeps the outcome and makes a re-run after a crash a no-op. The
 * engine's own writes carry the reason `automation:<rule>:<depth>`, which keeps a rule from firing on itself
 * and bounds chains.
 */
import { type ChatterContext, postMessage, scheduleActivity } from '@kosh/messaging';
import type { AutomationActionSpec } from '@kosh/modules-sdk';
import { type AuthService, HttpProblem, type KoshRegistry } from '@kosh/server';
import type { Driver, Env, Shutro } from '@kosh/server/orm';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec: unknown): Promise<Rows & { read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
async function rows(
  env: Env,
  model: string,
  where: unknown,
  keys: readonly string[],
  extra: { order?: readonly string[]; limit?: number } = {},
): Promise<Row[]> {
  const found = await ref(env, model).search({ where, ...extra });
  return found.length === 0 ? [] : (await found.load(keys)).read(['id', ...keys]);
}

/** What the engine needs from the server. */
export interface AutomationContext {
  readonly shutro: Shutro;
  readonly driver: Driver;
  readonly registry: KoshRegistry;
  readonly auth: AuthService | undefined;
  readonly chatter: ChatterContext;
  /** The actions modules declare (`automationActions`), by key. */
  readonly actions: ReadonlyMap<string, AutomationActionSpec>;
  readonly log?: ((message: string, error?: unknown) => void) | undefined;
}

/** One change of one record in one transaction, as the audit trail tells it. */
export interface Change {
  readonly tx: string;
  readonly model: string;
  readonly id: number;
  readonly action: 'create' | 'write' | 'unlink';
  readonly uid: number;
  readonly company: number;
  readonly su: boolean;
  readonly reason: string | null;
  /** The tracked fields that changed, with their old and new values. */
  readonly fields: ReadonlyMap<string, { readonly old: unknown; readonly new: unknown }>;
  /** `event` triggers: the topic and the payload. */
  readonly topic?: string | undefined;
  readonly payload?: unknown;
}

export interface RuleRow {
  readonly id: number;
  readonly name: string;
  readonly targetModel: string;
  readonly trigger: string;
  readonly watchFields: readonly string[];
  readonly toValues: Row | null;
  readonly fromValues: Row | null;
  readonly topic: string | null;
  readonly condition: Row | null;
  readonly actions: readonly Row[];
  readonly runAs: 'actor' | 'system';
  readonly runAsUser: number | null;
  readonly logOnRecord: boolean;
  readonly company: number;
}

export interface Outcome {
  readonly kind: string;
  readonly outcome: 'done' | 'failed' | 'skipped';
  readonly detail?: string | undefined;
  readonly error?: string | undefined;
}

export const MAX_DEPTH = 5;
const CURSOR = 'audit';
const LOCK = "hashtext('automation.audit')";
const RULE_KEYS = [
  'name',
  'targetModel',
  'trigger',
  'watchFields',
  'toValues',
  'fromValues',
  'topic',
  'condition',
  'actions',
  'runAs',
  'runAsUser',
  'logOnRecord',
  'company',
];

const asRule = (r: Row): RuleRow => ({
  id: r['id'] as number,
  name: String(r['name']),
  targetModel: String(r['targetModel']),
  trigger: String(r['trigger']),
  watchFields: Array.isArray(r['watchFields']) ? (r['watchFields'] as string[]) : [],
  toValues: (r['toValues'] as Row | null) ?? null,
  fromValues: (r['fromValues'] as Row | null) ?? null,
  topic: (r['topic'] as string | null) ?? null,
  condition: (r['condition'] as Row | null) ?? null,
  actions: Array.isArray(r['actions']) ? (r['actions'] as Row[]) : [],
  runAs: r['runAs'] === 'system' ? 'system' : 'actor',
  runAsUser: (r['runAsUser'] as number | null) ?? null,
  logOnRecord: r['logOnRecord'] === true,
  company: r['company'] as number,
});

/** The enabled rules of every company, straight from the table (the engine matches each change to its company). */
export async function loadRules(context: AutomationContext): Promise<RuleRow[]> {
  const found = await context.driver.query<Record<string, unknown>>({
    text: `SELECT id, name, target_model, trigger, watch_fields, to_values, from_values, topic, condition, actions,
                  run_as, run_as_user_id, log_on_record, company_id
           FROM automation_rule WHERE enabled = true AND active = true ORDER BY sequence, id`,
    params: [],
  });
  return found.map((r) =>
    asRule({
      id: Number(r['id']),
      name: r['name'],
      targetModel: r['target_model'],
      trigger: r['trigger'],
      watchFields: r['watch_fields'],
      toValues: r['to_values'],
      fromValues: r['from_values'],
      topic: r['topic'],
      condition: r['condition'],
      actions: r['actions'],
      runAs: r['run_as'],
      runAsUser: r['run_as_user_id'] === null ? null : Number(r['run_as_user_id']),
      logOnRecord: r['log_on_record'],
      company: Number(r['company_id']),
    }),
  );
}

/** The fields the audit trail tracks for a model (what an `updated` rule may watch). */
export function trackedFields(context: AutomationContext, model: string): readonly string[] {
  const registered = context.registry.registry.models.get(model as never) as
    | {
        readonly model: {
          readonly tracking?: readonly string[];
          readonly fields?: Readonly<Record<string, { readonly tracking?: boolean }>>;
        };
      }
    | undefined;
  const definition = registered?.model;
  if (definition === undefined) return [];
  const out = new Set<string>(definition.tracking ?? []);
  for (const [key, field] of Object.entries(definition.fields ?? {}))
    if (field.tracking === true) out.add(key);
  return [...out];
}

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The loop guard: the rule and depth a change's reason names. */
export function chainOf(reason: string | null): { rule: number; depth: number } | null {
  const m = /^automation:(\d+):(\d+)/.exec(reason ?? '');
  return m === null ? null : { rule: Number(m[1]), depth: Number(m[2]) };
}

/** Whether a change fires a rule, before its condition: `null` when it does, else why not. */
export function triggerMismatch(rule: RuleRow, change: Change): string | null {
  const chain = chainOf(change.reason);
  if (chain !== null && chain.rule === rule.id) return 'loop';
  if (chain !== null && chain.depth >= MAX_DEPTH) return 'depth';
  switch (rule.trigger) {
    case 'created':
      return change.action === 'create' ? null : 'trigger';
    case 'deleted':
      return change.action === 'unlink' ? null : 'trigger';
    case 'event':
      return change.topic !== undefined && change.topic === rule.topic ? null : 'trigger';
    case 'updated':
    case 'transition': {
      if (change.action !== 'write') return 'trigger';
      const watched =
        rule.trigger === 'transition' && rule.watchFields.length === 0
          ? ['state']
          : rule.watchFields;
      if (watched.length > 0 && !watched.some((f) => change.fields.has(f))) return 'fields';
      for (const [key, value] of Object.entries(rule.toValues ?? {}))
        if (!change.fields.has(key) || !sameValue(change.fields.get(key)?.new, value)) return 'to';
      for (const [key, value] of Object.entries(rule.fromValues ?? {}))
        if (!change.fields.has(key) || !sameValue(change.fields.get(key)?.old, value))
          return 'from';
      return null;
    }
    default:
      return 'trigger';
  }
}

/** The condition on the record as it is now (a deleted record has none to check). */
async function conditionHolds(
  context: AutomationContext,
  rule: RuleRow,
  change: Change,
): Promise<boolean> {
  const condition = rule.condition;
  if (condition === null || Object.keys(condition).length === 0 || change.action === 'unlink')
    return true;
  return context.shutro.bootstrap(
    { reason: 'automation condition', company: change.company },
    async (su) => {
      const found = await ref(su, rule.targetModel).search({
        where: { and: [{ id: change.id }, condition] },
        limit: 1,
      });
      return found.length > 0;
    },
  );
}

/** `{{path}}` templates: fields of the record (`partner.name`), `today`, `actor.name`, `record.url`. */
export async function render(
  env: Env,
  model: string,
  id: number | null,
  text: string,
  extra: { readonly actor?: { readonly name: string } | undefined },
  chatterModels?: ChatterContext['models'],
): Promise<string> {
  const paths = [...text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1] as string);
  if (paths.length === 0) return text;
  let record: Row | null = null;
  const relations = new Map<string, Row | null>();
  const value = async (path: string): Promise<string> => {
    if (path === 'today') return env.today();
    if (path === 'actor.name') return extra.actor?.name ?? '';
    if (path === 'record.url') return id === null ? '' : `/open/${encodeURIComponent(model)}/${id}`;
    if (id === null) return '';
    const [head, ...rest] = path.split('.');
    if (head === undefined) return '';
    if (record === null) {
      const [row] = (await ref(env, model).browse([id]).load([head])).read([head]);
      record = row ?? {};
    } else if (!(head in record)) {
      const [row] = (await ref(env, model).browse([id]).load([head])).read([head]);
      record = { ...record, ...row };
    }
    const direct = record[head];
    if (rest.length === 0) return direct === null || direct === undefined ? '' : String(direct);
    if (typeof direct !== 'number') return '';
    const key = `${head}.${rest.join('.')}`;
    if (!relations.has(key)) {
      // The related record: its model from the served field metadata, its row by the id just read.
      const target = chatterModels?.get(model)?.get(head)?.target ?? null;
      if (target === null) relations.set(key, null);
      else {
        const sub = rest[0] as string;
        const [related] = (await ref(env, target).browse([direct]).load([sub])).read([sub]);
        relations.set(key, related ?? null);
      }
    }
    const related = relations.get(key) ?? null;
    const sub = rest[0] as string;
    const v = related?.[sub];
    return v === null || v === undefined ? '' : String(v);
  };
  let out = text;
  for (const path of paths)
    out = out.replace(
      new RegExp(`\\{\\{\\s*${path.replace(/\./g, '\\.')}\\s*\\}\\}`, 'g'),
      await value(path),
    );
  return out;
}

const SINGLE = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

/** The record's value at a path (a field, or `relation.field`), as the ORM reads it; `undefined` when absent. */
export async function resolvePath(
  env: Env,
  model: string,
  id: number | null,
  path: string,
  chatterModels?: ChatterContext['models'],
): Promise<unknown> {
  if (id === null) return undefined;
  const [head, ...rest] = path.split('.');
  if (head === undefined) return undefined;
  const [row] = (await ref(env, model).browse([id]).load([head])).read([head]);
  const direct = row?.[head];
  if (rest.length === 0) return direct;
  if (typeof direct !== 'number') return undefined;
  const target = chatterModels?.get(model)?.get(head)?.target ?? null;
  if (target === null) return undefined;
  const sub = rest[0] as string;
  const [related] = (await ref(env, target).browse([direct]).load([sub])).read([sub]);
  return related?.[sub];
}

async function renderValues(
  env: Env,
  model: string,
  id: number | null,
  values: Row,
  extra: Parameters<typeof render>[4],
  chatterModels?: ChatterContext['models'],
): Promise<Row> {
  const out: Row = {};
  for (const [key, v] of Object.entries(values)) {
    if (typeof v !== 'string' || !v.includes('{{')) {
      out[key] = v;
      continue;
    }
    const single = SINGLE.exec(v);
    const path = single?.[1];
    out[key] =
      path !== undefined && path !== 'today' && !path.startsWith('actor.') && path !== 'record.url'
        ? ((await resolvePath(env, model, id, path, chatterModels)) ?? null)
        : await render(env, model, id, v, extra, chatterModels);
  }
  return out;
}

/** The users an action names: ids, `field:<key>` (a user field of the record), `role:<group code>`. */
async function resolveUsers(
  env: Env,
  model: string,
  id: number | null,
  spec: unknown,
  company: number,
): Promise<number[]> {
  const list = Array.isArray(spec) ? spec : [spec];
  const out = new Set<number>();
  for (const item of list) {
    if (typeof item === 'number') out.add(item);
    else if (typeof item === 'string' && item.startsWith('field:') && id !== null) {
      const key = item.slice('field:'.length);
      const [row] = (await ref(env, model).browse([id]).load([key])).read([key]);
      if (typeof row?.[key] === 'number') out.add(row[key] as number);
    } else if (typeof item === 'string' && item.startsWith('role:')) {
      const group = item.slice('role:'.length);
      for (const r of await rows(
        env,
        'auth.user_group',
        { group, or: [{ company: null }, { company }] },
        ['user'],
      ))
        if (typeof r['user'] === 'number') out.add(r['user']);
    }
  }
  return [...out];
}

/** Runs the rule's actions in `env` (the run's scope), in order; stops at the first failure. */
export async function runActions(
  context: AutomationContext,
  env: Env,
  rule: RuleRow,
  change: Pick<Change, 'model' | 'id' | 'company' | 'action'>,
  actor: { readonly name: string } | undefined,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const id = change.action === 'unlink' ? null : change.id;
  const extra = { actor };
  for (const action of rule.actions) {
    const kind = String(action['kind'] ?? '');
    try {
      switch (kind) {
        case 'set': {
          if (id === null) throw new Error('No record to write (deleted).');
          const values = await renderValues(
            env,
            change.model,
            id,
            (action['values'] as Row | undefined) ?? {},
            extra,
            context.chatter.models,
          );
          await ref(env, change.model).browse([id]).write(values);
          outcomes.push({ kind, outcome: 'done', detail: Object.keys(values).join(', ') });
          break;
        }
        case 'transition': {
          if (id === null) throw new Error('No record (deleted).');
          const name = String(action['name'] ?? '');
          const target = ref(env, change.model).browse([id]) as unknown as Record<
            string,
            () => Promise<void>
          >;
          const fn = target[name];
          if (typeof fn !== 'function')
            throw new Error(`No transition '${name}' on ${change.model}.`);
          await fn.call(target);
          outcomes.push({ kind, outcome: 'done', detail: name });
          break;
        }
        case 'activity': {
          if (id === null) throw new Error('No record (deleted).');
          const typeName = String(action['type'] ?? 'To-do');
          const [type] = await rows(env, 'mail.activity.type', { name: typeName }, []);
          if (type === undefined) throw new Error(`No activity type '${typeName}'.`);
          const users = await resolveUsers(
            env,
            change.model,
            id,
            action['assignee'] ?? env.uid,
            change.company,
          );
          const deadline = new Date();
          deadline.setUTCDate(deadline.getUTCDate() + Number(action['inDays'] ?? 0));
          for (const user of users)
            await scheduleActivity(env, context.chatter, change.model, id, {
              type: type['id'],
              summary: await render(
                env,
                change.model,
                id,
                String(action['summary'] ?? rule.name),
                extra,
                context.chatter.models,
              ),
              note:
                action['note'] === undefined
                  ? undefined
                  : await render(
                      env,
                      change.model,
                      id,
                      String(action['note']),
                      extra,
                      context.chatter.models,
                    ),
              deadline: deadline.toISOString().slice(0, 10),
              assignee: user,
            });
          outcomes.push({
            kind,
            outcome: 'done',
            detail: `${users.length} activit${users.length === 1 ? 'y' : 'ies'}`,
          });
          break;
        }
        case 'note':
        case 'comment': {
          if (id === null) throw new Error('No record (deleted).');
          await postMessage(env, context.chatter, change.model, id, {
            kind: kind === 'note' ? 'note' : 'comment',
            text: await render(
              env,
              change.model,
              id,
              String(action['text'] ?? ''),
              extra,
              context.chatter.models,
            ),
          });
          outcomes.push({ kind, outcome: 'done' });
          break;
        }
        case 'notify': {
          const users = await resolveUsers(
            env,
            change.model,
            id,
            action['users'] ?? [],
            change.company,
          );
          const text = await render(
            env,
            change.model,
            id,
            String(action['text'] ?? rule.name),
            extra,
            context.chatter.models,
          );
          await env.emit('automation.notify', {
            model: change.model,
            id: id ?? 0,
            users,
            text,
            rule: rule.id,
          });
          outcomes.push({ kind, outcome: 'done', detail: `${users.length} user(s)` });
          break;
        }
        case 'create': {
          const target = String(action['model'] ?? '');
          if (target === '') throw new Error('create: no model.');
          const values = await renderValues(
            env,
            change.model,
            id,
            (action['values'] as Row | undefined) ?? {},
            extra,
            context.chatter.models,
          );
          const created = await ref(env, target).create([values]);
          outcomes.push({ kind, outcome: 'done', detail: `${target} #${String(created.ids[0])}` });
          break;
        }
        case 'action': {
          const key = String(action['key'] ?? '');
          const spec = context.actions.get(key);
          if (spec === undefined) throw new Error(`No module action '${key}'.`);
          if (spec.model !== undefined && spec.model !== change.model)
            throw new Error(`The action '${key}' is for ${spec.model}, not ${change.model}.`);
          const result = await spec.run(
            env,
            { model: change.model, id },
            (action['params'] as Row | undefined) ?? {},
          );
          outcomes.push({
            kind,
            outcome: 'done',
            detail: result === undefined ? key : `${key}: ${result}`,
          });
          break;
        }
        case 'webhook':
          outcomes.push({ kind, outcome: 'skipped', detail: 'webhooks come with step 3' });
          break;
        default:
          throw new Error(`Unknown action '${kind}'.`);
      }
    } catch (error) {
      outcomes.push({
        kind,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new RunFailed(outcomes);
    }
  }
  return outcomes;
}

class RunFailed extends Error {
  constructor(readonly outcomes: Outcome[]) {
    super(outcomes.at(-1)?.error ?? 'failed');
    this.name = 'RunFailed';
  }
}

/** The identity a rule runs as for a change: the actor (their rights), or the system. `null`: no actor to run as. */
async function scopeFor(
  context: AutomationContext,
  rule: RuleRow,
  change: Change,
  depth: number,
): Promise<{
  run: <T>(fn: (env: Env) => Promise<T>) => Promise<T>;
  actor: { readonly id: number; readonly name: string } | null;
} | null> {
  const reason = `automation:${rule.id}:${depth}`;
  const uid = rule.runAs === 'actor' ? (change.su ? null : change.uid) : (rule.runAsUser ?? null);
  const actorName = async (id: number) =>
    context.shutro.bootstrap({ reason: 'automation actor' }, async (su) => {
      const [u] = await rows(su, 'res.users', { id, active: { in: [true, false] } }, ['name']);
      return String(u?.['name'] ?? '');
    });
  if (rule.runAs === 'system' && uid === null)
    return {
      actor: change.su ? null : { id: change.uid, name: await actorName(change.uid) },
      run: (fn) => context.shutro.bootstrap({ reason, company: change.company }, fn),
    };
  if (uid === null) return null;
  const info = await context.auth?.verify(uid).catch(() => null);
  if (info === null || info === undefined) return null;
  const companies = info.companies.includes(change.company)
    ? info.companies
    : [change.company, ...info.companies];
  const name = await actorName(uid);
  return {
    actor: { id: uid, name },
    run: (fn) =>
      context.shutro.run(
        {
          user: uid,
          company: change.company,
          companies,
          groups: info.groups,
          ...(info.grants === undefined ? {} : { grants: info.grants }),
          reason,
        },
        fn,
      ),
  };
}

/** Evaluates one rule for one change: a run row (queued → done / failed / skipped), once per `(rule, tx, record)`. */
export async function applyRule(
  context: AutomationContext,
  rule: RuleRow,
  change: Change,
): Promise<Outcome[] | string> {
  const tx = change.tx;
  const started = new Date();
  // 1. The run row: exactly once.
  const existing = await context.shutro.bootstrap(
    { reason: 'automation run', company: change.company },
    async (su) => {
      const [row] = await rows(su, 'automation.run', { rule: rule.id, tx, targetId: change.id }, [
        'state',
      ]);
      if (row !== undefined) return String(row['state']);
      await ref(su, 'automation.run').create([
        {
          rule: rule.id,
          trigger: rule.trigger,
          targetModel: change.model,
          targetId: change.id,
          tx,
          actor: change.su ? null : change.uid,
          startedAt: started,
          state: 'queued',
        },
      ]);
      return null;
    },
  );
  if (existing !== null) return `already ${existing}`;
  const finish = (values: Row) =>
    context.shutro.bootstrap({ reason: 'automation run', company: change.company }, async (su) => {
      const [row] = await rows(
        su,
        'automation.run',
        { rule: rule.id, tx, targetId: change.id },
        [],
      );
      if (row !== undefined)
        await ref(su, 'automation.run')
          .browse([row['id'] as number])
          .write({ ...values, finishedAt: new Date() });
      await ref(su, 'automation.rule').browse([rule.id]).write({ lastRunAt: new Date() });
    });
  // 2. Skips: the trigger, watched fields, the loop guard, the condition, the actor.
  if ((rule.trigger === 'updated' || rule.trigger === 'transition') && change.action === 'write') {
    const tracked = trackedFields(context, rule.targetModel);
    const untracked = rule.watchFields.filter((f) => !tracked.includes(f));
    if (untracked.length > 0) {
      await finish({
        state: 'skipped',
        reason: 'untracked',
        error: `Not tracked: ${untracked.join(', ')}`,
      });
      return 'untracked';
    }
  }
  const mismatch = triggerMismatch(rule, change);
  if (mismatch !== null) {
    await finish({ state: 'skipped', reason: mismatch });
    return mismatch;
  }
  try {
    return await decideAndRun(context, rule, change, finish);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish({ state: 'failed', error: message.slice(0, 2000) }).catch(() => undefined);
    context.log?.(
      `automation: rule ${rule.id} could not run on ${change.model} #${change.id}`,
      error,
    );
    return message;
  }
}

async function decideAndRun(
  context: AutomationContext,
  rule: RuleRow,
  change: Change,
  finish: (values: Row) => Promise<void>,
): Promise<Outcome[] | string> {
  if (!(await conditionHolds(context, rule, change))) {
    await finish({ state: 'skipped', reason: 'condition' });
    return 'condition';
  }
  const chain = chainOf(change.reason);
  const scope = await scopeFor(context, rule, change, (chain?.depth ?? 0) + 1);
  if (scope === null) {
    await finish({ state: 'skipped', reason: 'no-actor' });
    return 'no-actor';
  }
  // 3. The actions, in one transaction of the run's scope.
  try {
    const outcomes = await scope.run((env) =>
      runActions(context, env, rule, change, scope.actor ?? undefined),
    );
    if (rule.logOnRecord && change.action !== 'unlink')
      await context.shutro.bootstrap(
        { reason: `automation:${rule.id}:log`, company: change.company },
        (su) =>
          postMessage(su, context.chatter, change.model, change.id, {
            kind: 'note',
            text: `Rule "${rule.name}": ${outcomes.map((o) => o.detail ?? o.kind).join(', ')}`,
          }).then(() => undefined),
      );
    await finish({ state: 'done', outcomes });
    return outcomes;
  } catch (error) {
    const outcomes = error instanceof RunFailed ? error.outcomes : [];
    const message = error instanceof Error ? error.message : String(error);
    await finish({ state: 'failed', outcomes, error: message.slice(0, 2000) });
    context.log?.(`automation: rule ${rule.id} failed on ${change.model} #${change.id}`, error);
    return outcomes;
  }
}

/** Applies every enabled rule of the change's model and company. */
export async function applyChange(
  context: AutomationContext,
  rules: readonly RuleRow[],
  change: Change,
): Promise<number> {
  let runs = 0;
  for (const rule of rules) {
    if (rule.targetModel !== change.model || rule.company !== change.company) continue;
    if (rule.trigger === 'event' ? change.topic === undefined : change.topic !== undefined)
      continue;
    const result = await applyRule(context, rule, change);
    if (typeof result !== 'string') runs += 1;
  }
  return runs;
}

interface AuditRow extends Record<string, unknown> {
  readonly id: string;
  readonly tx: string;
  readonly uid: string;
  readonly company_id: string;
  readonly su: boolean;
  readonly reason: string | null;
  readonly action: string;
  readonly model: string;
  readonly record_id: string | null;
  readonly field: string | null;
  readonly old: unknown;
  readonly new: unknown;
}

/** Audit rows grouped into changes: one per transaction, model and record. */
export function changesOf(audit: readonly AuditRow[]): Change[] {
  const out = new Map<
    string,
    { change: Omit<Change, 'fields'>; fields: Map<string, { old: unknown; new: unknown }> }
  >();
  for (const r of audit) {
    if (r.record_id === null || !['create', 'write', 'unlink'].includes(r.action)) continue;
    const key = `${r.tx}|${r.model}|${r.record_id}`;
    let entry = out.get(key);
    if (entry === undefined) {
      entry = {
        change: {
          tx: r.tx,
          model: r.model,
          id: Number(r.record_id),
          action: r.action as Change['action'],
          uid: Number(r.uid),
          company: Number(r.company_id),
          su: r.su,
          reason: r.reason,
        },
        fields: new Map(),
      };
      out.set(key, entry);
    }
    // A record created and written in one transaction is one creation; a deletion wins over writes.
    if (r.action === 'unlink') entry.change = { ...entry.change, action: 'unlink' };
    else if (r.action === 'create' && entry.change.action !== 'unlink')
      entry.change = { ...entry.change, action: 'create' };
    if (r.field !== null) {
      const previous = entry.fields.get(r.field);
      entry.fields.set(r.field, { old: previous === undefined ? r.old : previous.old, new: r.new });
    }
  }
  return [...out.values()].map((e) => ({ ...e.change, fields: e.fields }));
}

/**
 * Reads the audit trail past the cursor once, applies the rules, and advances the cursor; `null` when another
 * worker holds the lock. Each run commits on its own; the cursor moves at the end, so a crash re-reads the batch
 * and the run rows make the re-run a no-op.
 */
export async function pollAudit(
  context: AutomationContext,
  options: { readonly limit?: number } = {},
): Promise<{ readonly changes: number; readonly runs: number } | null> {
  const limit = options.limit ?? 500;
  return context.driver.transaction({}, async (conn) => {
    const [lock] = await conn.query<{ ok: boolean }>({
      text: `SELECT pg_try_advisory_xact_lock(${LOCK}) AS ok`,
      params: [],
    });
    if (lock?.ok !== true) return null;
    await conn.query({
      text: 'INSERT INTO automation_cursor (name, position, created_at, updated_at) SELECT $1, 0, now(), now() WHERE NOT EXISTS (SELECT 1 FROM automation_cursor WHERE name = $1)',
      params: [CURSOR],
    });
    const [cursor] = await conn.query<{ position: string }>({
      text: 'SELECT position FROM automation_cursor WHERE name = $1 FOR UPDATE',
      params: [CURSOR],
    });
    const from = Number(cursor?.position ?? 0);
    const audit = await conn.query<AuditRow>({
      text: `SELECT id::text, tx, uid::text, company_id::text, su, reason, action, model, record_id::text, field, old, new
             FROM shutro_audit WHERE id > $1 AND model IS NOT NULL AND model NOT LIKE 'automation.%'
             ORDER BY id LIMIT $2`,
      params: [from, limit],
    });
    if (audit.length === 0) return { changes: 0, runs: 0 };
    const changes = changesOf(audit);
    const models = new Set(changes.map((c) => c.model));
    const rules = (await loadRules(context)).filter(
      (r) => models.has(r.targetModel) && r.trigger !== 'event',
    );
    let runs = 0;
    if (rules.length > 0)
      for (const change of changes) runs += await applyChange(context, rules, change);
    const last = audit[audit.length - 1]?.id;
    await conn.query({
      text: 'UPDATE automation_cursor SET position = $2, updated_at = now() WHERE name = $1',
      params: [CURSOR, Number(last)],
    });
    return { changes: changes.length, runs };
  });
}

const OUTBOX_CURSOR = 'outbox';
const OUTBOX_LOCK = "hashtext('automation.outbox')";

/**
 * Reads the outbox past the engine's cursor once (the topics the enabled `event` rules name) and applies those
 * rules; `null` when another worker holds the lock. A cursor of its own, like the audit trail's: no scope of the
 * engine's runs is nested in a subscriber's.
 */
export async function pollOutbox(
  context: AutomationContext,
  options: { readonly limit?: number } = {},
): Promise<{ readonly events: number; readonly runs: number } | null> {
  const limit = options.limit ?? 500;
  return context.driver.transaction({}, async (conn) => {
    const [lock] = await conn.query<{ ok: boolean }>({
      text: `SELECT pg_try_advisory_xact_lock(${OUTBOX_LOCK}) AS ok`,
      params: [],
    });
    if (lock?.ok !== true) return null;
    await conn.query({
      text: 'INSERT INTO automation_cursor (name, position, created_at, updated_at) SELECT $1, 0, now(), now() WHERE NOT EXISTS (SELECT 1 FROM automation_cursor WHERE name = $1)',
      params: [OUTBOX_CURSOR],
    });
    const [cursor] = await conn.query<{ position: string }>({
      text: 'SELECT position FROM automation_cursor WHERE name = $1 FOR UPDATE',
      params: [OUTBOX_CURSOR],
    });
    const from = Number(cursor?.position ?? 0);
    const rules = (await loadRules(context)).filter(
      (r) => r.trigger === 'event' && r.topic !== null,
    );
    const topics = [...new Set(rules.map((r) => r.topic as string))];
    const events = await conn.query<Record<string, unknown>>({
      text: `SELECT id::text, topic, payload, uid::text, company_id::text FROM shutro_outbox WHERE id > $1 ORDER BY id LIMIT $2`,
      params: [from, limit],
    });
    if (events.length === 0) return { events: 0, runs: 0 };
    let runs = 0;
    for (const e of events) {
      const topic = String(e['topic']);
      if (!topics.includes(topic)) continue;
      const payload = (e['payload'] ?? {}) as Row;
      const model = String(payload['model'] ?? '');
      const id = Number(payload['id']);
      if (model === '' || !Number.isSafeInteger(id)) continue;
      const change: Change = {
        tx: `event:${String(e['id'])}`,
        model,
        id,
        action: 'write',
        uid: Number(e['uid']),
        company: Number(e['company_id']),
        su: false,
        reason: null,
        fields: new Map(),
        topic,
        payload: e['payload'],
      };
      runs += await applyChange(
        context,
        rules.filter((r) => r.topic === topic),
        change,
      );
    }
    const last = events[events.length - 1]?.['id'];
    await conn.query({
      text: 'UPDATE automation_cursor SET position = $2, updated_at = now() WHERE name = $1',
      params: [OUTBOX_CURSOR, Number(last)],
    });
    return { events: events.length, runs };
  });
}

/** Starts the engine: the audit and outbox pollers; `stop()` ends them after the round in progress. */
export function startAutomation(
  context: AutomationContext,
  options: { readonly pollMs?: number } = {},
): { stop(): Promise<void> } {
  const pollMs = options.pollMs ?? 5000;
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = (async () => {
      await pollAudit(context);
      await pollOutbox(context);
    })().catch((error: unknown) => context.log?.('automation: a round failed', error));
  };
  const timer = setInterval(tick, pollMs);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

/** A dry run: whether the rule's condition holds on the record now, and the actions it would take (nothing runs). */
export async function testRule(
  context: AutomationContext,
  env: Env,
  ruleId: number,
  recordId: number,
): Promise<{ readonly matches: boolean; readonly actions: readonly Row[] }> {
  const [row] = await rows(env, 'automation.rule', { id: ruleId }, RULE_KEYS);
  if (row === undefined) throw new HttpProblem(404, 'missing-record', 'Not found', 'No such rule.');
  const rule = asRule(row);
  const found = await ref(env, rule.targetModel).search({
    where:
      rule.condition === null || Object.keys(rule.condition).length === 0
        ? { id: recordId }
        : { and: [{ id: recordId }, rule.condition] },
    limit: 1,
  });
  const actions: Row[] = [];
  for (const action of rule.actions) {
    const values = (action['values'] as Row | undefined) ?? {};
    actions.push({
      ...action,
      ...(Object.keys(values).length === 0
        ? {}
        : {
            values: await renderValues(
              env,
              rule.targetModel,
              recordId,
              values,
              { actor: undefined },
              context.chatter.models,
            ),
          }),
      ...(typeof action['text'] === 'string'
        ? {
            text: await render(
              env,
              rule.targetModel,
              recordId,
              action['text'],
              { actor: undefined },
              context.chatter.models,
            ),
          }
        : {}),
    });
  }
  return { matches: found.length > 0, actions };
}

/** Runs a failed run's rule again on its record, as a new run (`retry:<run id>`), by a manager. */
export async function retryRun(
  context: AutomationContext,
  env: Env,
  runId: number,
): Promise<Outcome[] | string> {
  const [run] = await rows(env, 'automation.run', { id: runId }, [
    'rule',
    'targetModel',
    'targetId',
    'actor',
    'company',
    'state',
  ]);
  if (run === undefined) throw new HttpProblem(404, 'missing-record', 'Not found', 'No such run.');
  if (run['state'] !== 'failed')
    throw new HttpProblem(409, 'conflict', 'Conflict', 'Only a failed run is retried.');
  const [ruleRow] = await rows(env, 'automation.rule', { id: run['rule'] }, RULE_KEYS);
  if (ruleRow === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'The rule is gone.');
  const rule = asRule(ruleRow);
  const change: Change = {
    tx: `retry:${runId}:${Date.now()}`,
    model: String(run['targetModel']),
    id: run['targetId'] as number,
    action: 'write',
    uid: (run['actor'] as number | null) ?? env.uid,
    company: run['company'] as number,
    su: false,
    reason: null,
    fields: new Map(),
  };
  // A retry runs the actions as they stand, without the trigger's own checks.
  const scope = await scopeFor(context, rule, change, 1);
  if (scope === null) return 'no-actor';
  const started = new Date();
  await context.shutro.bootstrap({ reason: 'automation run', company: change.company }, (su) =>
    ref(su, 'automation.run')
      .create([
        {
          rule: rule.id,
          trigger: 'retry',
          targetModel: change.model,
          targetId: change.id,
          tx: change.tx,
          actor: change.uid,
          startedAt: started,
          state: 'queued',
        },
      ])
      .then(() => undefined),
  );
  const finish = (values: Row) =>
    context.shutro.bootstrap({ reason: 'automation run', company: change.company }, async (su) => {
      const [row] = await rows(su, 'automation.run', { tx: change.tx }, []);
      if (row !== undefined)
        await ref(su, 'automation.run')
          .browse([row['id'] as number])
          .write({ ...values, finishedAt: new Date() });
    });
  try {
    const outcomes = await scope.run((e) =>
      runActions(context, e, rule, change, scope.actor ?? undefined),
    );
    await finish({ state: 'done', outcomes });
    return outcomes;
  } catch (error) {
    const outcomes = error instanceof RunFailed ? error.outcomes : [];
    await finish({
      state: 'failed',
      outcomes,
      error: error instanceof Error ? error.message : String(error),
    });
    return outcomes;
  }
}
