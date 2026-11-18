/**
 * Data health (RFC 0036 §2.3): the checks each installed module declares over its own data (`dataChecks` in its
 * manifest) — the books against the documents, the stock against its movements — run for a company, as the system,
 * reading only. Each finding names what is wrong and the records behind it; nothing is repaired here.
 */
import type { DataCheckSpec, DataFinding, KoshModule } from '@kosh/modules-sdk';
import { type ApiModel, apiModels } from './api/metadata.js';
import { administrators } from './auth/admins.js';
import type { Driver, Env, Shutro } from './orm.js';

export interface DataCheckResult {
  readonly module: string;
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  readonly findings: readonly DataFinding[];
  /** The check itself failed to run (a query that broke): said, never hidden as "nothing found". */
  readonly error?: string;
}

export interface DataHealth {
  readonly company: number;
  readonly checkedAt: string;
  readonly checks: readonly DataCheckResult[];
  readonly ok: boolean;
}

type Recs = { readonly ids: readonly number[]; readonly length: number };
type Loose = {
  search(q: unknown): Promise<Recs & { write(v: unknown): Promise<void> }>;
  create(v: unknown): Promise<Recs>;
};
const model = (env: Env, name: string): Loose => env.model(name as never) as unknown as Loose;

/**
 * The check every installation has: no draft points at an archived record — a quotation for a customer that was
 * archived, a draft bill of an archived vendor. Read from the installed models: each one with a state, in its first
 * state, and each of its relations to a record that can be archived.
 */
async function archivedLinks(
  env: Env,
  models: ReadonlyMap<string, ApiModel>,
): Promise<DataFinding[]> {
  const all = (env as unknown as { withFlags(f: { activeTest: boolean }): Env }).withFlags({
    activeTest: false,
  });
  const archived = new Map<string, readonly number[]>();
  const archivedOf = async (target: string): Promise<readonly number[]> => {
    let ids = archived.get(target);
    if (ids === undefined) {
      ids = (await model(all, target).search({ where: { active: false }, limit: 5000 })).ids;
      archived.set(target, ids);
    }
    return ids;
  };
  const findings: DataFinding[] = [];
  for (const m of models.values()) {
    const state = m.byKey.get('state');
    const first = state?.kind === 'state' ? state.options?.[0] : undefined;
    if (first === undefined) continue;
    for (const f of m.fields) {
      if (!f.stored || f.kind !== 'many2one' || f.target === null) continue;
      if (models.get(f.target)?.byKey.get('active')?.stored !== true) continue;
      const gone = await archivedOf(f.target);
      if (gone.length === 0) continue;
      const drafts = await model(env, m.name).search({
        where: { state: first[0], [f.key]: { in: [...gone] } },
        limit: 100,
      });
      if (drafts.length > 0)
        findings.push({
          what: m.label,
          detail: `${drafts.length} in ${first[1]} point${drafts.length === 1 ? 's' : ''} at an archived ${models.get(f.target)?.label ?? f.target} (${f.label})`,
          records: { model: m.name, ids: [...drafts.ids] },
        });
    }
  }
  return findings;
}

/** Thrown to end the read-only run; never escapes. */
class Done extends Error {}

/** Runs every installed module's data checks for a company. Nothing is written: the run is rolled back. */
export async function checkData(
  shutro: Shutro,
  modules: readonly KoshModule[],
  options: { readonly company: number },
): Promise<DataHealth> {
  const checks: DataCheckResult[] = [];
  const models = shutro.registry === undefined ? null : apiModels(shutro.registry);
  const declared = [
    ...(models === null
      ? []
      : [
          {
            module: 'base',
            check: {
              key: 'archived_links',
              label: 'No draft points at an archived record',
              run: ((env: Env) => archivedLinks(env, models)) as unknown as DataCheckSpec['run'],
            } satisfies DataCheckSpec,
          },
        ]),
    ...modules.flatMap((m) =>
      ((m as { dataChecks?: readonly DataCheckSpec[] }).dataChecks ?? []).map((check) => ({
        module: m.name,
        check,
      })),
    ),
  ];
  try {
    await shutro.bootstrap({ reason: 'data check', company: options.company }, async (env: Env) => {
      for (const { module, check } of declared) {
        try {
          // A savepoint each: a check that breaks does not take the others with it.
          const findings = await env.transaction((tx) =>
            (check.run as (env: Env) => Promise<readonly DataFinding[]>)(tx),
          );
          checks.push({
            module,
            key: check.key,
            label: check.label,
            ok: findings.length === 0,
            findings,
          });
        } catch (error) {
          checks.push({
            module,
            key: check.key,
            label: check.label,
            ok: false,
            findings: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      throw new Done();
    });
  } catch (error) {
    if (!(error instanceof Done)) throw error;
  }
  return {
    company: options.company,
    checkedAt: new Date().toISOString(),
    checks,
    ok: checks.every((c) => c.ok),
  };
}

/** The result as text, for the command line. */
export function dataHealthText(health: DataHealth): string {
  const lines: string[] = [];
  for (const c of health.checks) {
    lines.push(
      `${c.ok ? '✔' : '✖'} ${c.module}: ${c.label}${c.ok ? '' : c.error !== undefined ? ' — the check could not run' : ` — ${c.findings.length} finding(s)`}`,
    );
    if (c.error !== undefined) lines.push(`    ${c.error}`);
    for (const f of c.findings.slice(0, 20)) {
      const records =
        f.records === undefined || f.records.ids.length === 0
          ? ''
          : ` (${f.records.model} ${f.records.ids.slice(0, 10).join(', ')}${f.records.ids.length > 10 ? ', …' : ''})`;
      lines.push(`    ${f.what}: ${f.detail}${records}`);
    }
    if (c.findings.length > 20) lines.push(`    … and ${c.findings.length - 20} more`);
  }
  return `${lines.join('\n')}\n`;
}

// ---- the result on record

/** What is kept of a run: when, and which checks found how much. */
export interface DataHealthSummary {
  readonly company: number;
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly failing: readonly {
    readonly module: string;
    readonly key: string;
    readonly label: string;
    readonly findings: number;
  }[];
}

const settingKey = (company: number): string => `data_health.${company}`;
const summaryOf = (health: DataHealth): DataHealthSummary => ({
  company: health.company,
  checkedAt: health.checkedAt,
  ok: health.ok,
  failing: health.checks
    .filter((c) => !c.ok)
    .map((c) => ({ module: c.module, key: c.key, label: c.label, findings: c.findings.length })),
});

/**
 * Runs the checks for a company and keeps the result (`kosh.setting`), where the doctor and Settings read it. With
 * `notify`, the Administrators are told once when a check that held starts to find something.
 */
export async function runDataHealth(
  shutro: Shutro,
  modules: readonly KoshModule[],
  options: { readonly company: number; readonly notify?: boolean },
): Promise<DataHealth> {
  const health = await checkData(shutro, modules, { company: options.company });
  const summary = summaryOf(health);
  await shutro.bootstrap(
    { reason: 'data check recorded', company: options.company },
    async (env: Env) => {
      const settings = model(env, 'kosh.setting');
      const found = await settings.search({
        where: { key: settingKey(options.company) },
        limit: 1,
      });
      const [before] = await env.sql<{ value: DataHealthSummary | string | null }>`
      SELECT value FROM kosh_setting WHERE key = ${settingKey(options.company)}`;
      const previous =
        typeof before?.value === 'string'
          ? (JSON.parse(before.value) as DataHealthSummary)
          : (before?.value ?? null);
      if (found.length > 0) await found.write({ value: summary });
      else await settings.create([{ key: settingKey(options.company), value: summary }]);
      const known = new Set((previous?.failing ?? []).map((f) => `${f.module}:${f.key}`));
      const fresh = summary.failing.filter((f) => !known.has(`${f.module}:${f.key}`));
      if (options.notify === true && fresh.length > 0) {
        const users = await administrators(env);
        if (users.length > 0)
          await env.emit('automation.notify', {
            model: 'res.company',
            id: options.company,
            users,
            text: `Data health: ${fresh.map((f) => `${f.label} — ${f.findings} finding(s)`).join('; ')}. Open Settings › Data health.`,
          });
      }
      await env.flush();
    },
  );
  return health;
}

/** The last recorded result of each company (the doctor reads it without a server). */
export async function lastDataHealth(driver: Driver): Promise<DataHealthSummary[]> {
  const rows = await driver
    .query<{ value: DataHealthSummary | string }>({
      text: "SELECT value FROM kosh_setting WHERE key LIKE 'data\\_health.%' ORDER BY key",
      params: [],
    })
    .catch(() => [] as { value: DataHealthSummary | string }[]);
  return rows.map((r) =>
    typeof r.value === 'string' ? (JSON.parse(r.value) as DataHealthSummary) : r.value,
  );
}
