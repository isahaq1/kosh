/**
 * Data health (RFC 0036 §2.3): the checks each installed module declares over its own data (`dataChecks` in its
 * manifest) — the books against the documents, the stock against its movements — run for a company, as the system,
 * reading only. Each finding names what is wrong and the records behind it; nothing is repaired here.
 */
import type { DataCheckSpec, DataFinding, KoshModule } from '@kosh/modules-sdk';
import type { Env, Shutro } from './orm.js';

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

/** Thrown to end the read-only run; never escapes. */
class Done extends Error {}

/** Runs every installed module's data checks for a company. Nothing is written: the run is rolled back. */
export async function checkData(
  shutro: Shutro,
  modules: readonly KoshModule[],
  options: { readonly company: number },
): Promise<DataHealth> {
  const checks: DataCheckResult[] = [];
  const declared = modules.flatMap((m) =>
    ((m as { dataChecks?: readonly DataCheckSpec[] }).dataChecks ?? []).map((check) => ({
      module: m.name,
      check,
    })),
  );
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
