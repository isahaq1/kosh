/**
 * Rules modules ship (`automationRules` in a manifest; RFC 0012 §5.1): installed as `automation.rule` records owned
 * by the module (`module` + `moduleKey`) in every company, by the App manager's defaults step (after every app
 * change). A rule a module declares is created switched on (or off, as declared); an upgrade rewrites what the
 * module declares and keeps the administrator's on/off switch; a rule the module no longer declares is archived.
 * Rules of modules that are not served (disabled) are left alone.
 */
import type { AutomationRuleSpec, KoshModule } from '@kosh/modules-sdk';
import type { Env } from '@kosh/server/orm';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** The rule's values as the module declares them (what an upgrade rewrites). */
export function ruleValues(spec: AutomationRuleSpec): Row {
  return {
    name: spec.name,
    targetModel: spec.model,
    trigger: spec.trigger,
    actions: spec.actions,
    condition: spec.condition ?? null,
    watchFields: spec.watchFields ?? null,
    toValues: spec.toValues ?? null,
    fromValues: spec.fromValues ?? null,
    topic: spec.topic ?? null,
    dateField: spec.dateField ?? null,
    dateOffsetDays: spec.dateOffsetDays ?? 0,
    cron: spec.cron ?? null,
    runAs: spec.runAs ?? 'actor',
    logOnRecord: spec.logOnRecord ?? false,
    description: spec.description ?? null,
    sequence: spec.sequence ?? 10,
  };
}

/** Installs, updates and archives the served modules' rules; returns the number created and updated. */
export async function installModuleRules(
  env: Env,
  modules: readonly KoshModule[],
): Promise<{ created: number; updated: number; archived: number }> {
  const owners = modules.filter((m) => Object.keys(m.automationRules ?? {}).length > 0);
  const served = modules.map((m) => m.name);
  const companies = (await ref(env, 'res.company').search({ where: {} })).ids;
  let created = 0;
  let updated = 0;
  let archived = 0;
  const all = { in: [true, false] };
  for (const company of companies) {
    for (const module of owners)
      for (const [key, spec] of Object.entries(module.automationRules ?? {})) {
        const existing = await ref(env, 'automation.rule').search({
          where: { module: module.name, moduleKey: key, company, active: all },
        });
        if (existing.length > 0) {
          await existing.write({ ...ruleValues(spec), active: true });
          updated += existing.length;
        } else {
          await ref(env, 'automation.rule').create([
            {
              ...ruleValues(spec),
              enabled: spec.enabled ?? true,
              module: module.name,
              moduleKey: key,
              company,
            },
          ]);
          created += 1;
        }
      }
    // Rules a served module no longer declares.
    const owned = await ref(env, 'automation.rule').search({
      where: { module: { in: served }, company, active: true },
    });
    if (owned.length === 0) continue;
    const rows = (await owned.load(['id', 'module', 'moduleKey'])).read([
      'id',
      'module',
      'moduleKey',
    ]);
    const gone = rows.filter((r) => {
      const module = modules.find((m) => m.name === r['module']);
      return module?.automationRules?.[String(r['moduleKey'])] === undefined;
    });
    if (gone.length === 0) continue;
    await ref(env, 'automation.rule')
      .search({ where: { id: { in: gone.map((r) => r['id']) } } })
      .then((set) => set.write({ active: false }));
    archived += gone.length;
  }
  return { created, updated, archived };
}
