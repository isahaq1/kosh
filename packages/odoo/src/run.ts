/**
 * The import from Odoo (RFC 0034 §2.3, step 3 part 1): every step of the plan, in order, in one transaction run as
 * the system with its reason in the audit log — each record in a savepoint of its own, so one refused record is a
 * line in the report and not the end of the import. A dry run does everything and rolls it back.
 *
 * Every Odoo record imported keeps its Odoo id as the external id `odoo.<model>_<id>`: a second run finds it and
 * updates it instead of creating it again (the parallel run of step 4 builds on that), and anyone can trace a Kosh
 * record back to Odoo. A record Kosh already had (a seeded unit, an account of the installed chart) is linked the
 * same way, then kept in step with Odoo like the others.
 *
 * The report accounts for every Odoo record read: created, updated, linked, skipped (with the reason) or failed (with
 * Kosh's answer) — nothing is lost silently.
 */
import { problemOf } from '@kosh/server';
import type { Env, Shutro } from '@kosh/server/orm';
import {
  type Check,
  type OdooOpening,
  type OpeningOptions,
  type OpeningResult,
  readOpening,
  reconcile,
  writeOpening,
} from './opening.js';
import {
  externalIdFor,
  type Find,
  type RefId,
  readableFields,
  STEPS,
  type Step,
  type StepContext,
} from './plan.js';
import { idOf, type OdooClient, type OdooRecord, textOf } from './rpc.js';
import {
  type OdooStock,
  readStock,
  reconcileStock,
  type StockResult,
  writeStock,
} from './stock.js';

export interface FailedRecord {
  readonly odooId: number;
  readonly name: string;
  readonly error: string;
}

export interface StepReport {
  readonly key: string;
  readonly odoo: string;
  readonly kosh: string;
  /** `left-out`: the step did not run (`reason` says why). */
  readonly status: 'done' | 'left-out';
  readonly reason?: string;
  readonly read: number;
  readonly created: number;
  readonly updated: number;
  readonly linked: number;
  /** Records not imported, counted by reason. */
  readonly skipped: Readonly<Record<string, number>>;
  readonly failed: readonly FailedRecord[];
}

export interface OdooReport {
  readonly odoo: { readonly url: string; readonly db: string; readonly version: string };
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: readonly StepReport[];
  /** The opening entry and open documents, when a cut-off was given. */
  readonly opening?: OpeningResult;
  /** The stock on hand, when a cut-off was given and Stockroom is installed in both. */
  readonly stock?: StockResult;
  /** Kosh's books against Odoo's at the cut-off. */
  readonly checks?: readonly Check[];
  /** Every record read is accounted for, and none failed. */
  readonly ok: boolean;
}

export interface OdooImportOptions {
  /** Roll everything back at the end (default true: an import is kept only when asked). */
  readonly dryRun?: boolean;
  /** The Kosh company the records belong to. */
  readonly company: number;
  /** Where the Odoo came from, for the report. */
  readonly source: { readonly url: string; readonly db: string };
  /** Progress: a step started, with the records read. */
  readonly onStep?: (step: string, records: number) => void;
  /**
   * Also the books and the stock: the opening entry, the open documents and the stock on hand at this cut-off, and
   * the reconciliation.
   */
  readonly opening?: OpeningOptions;
}

/** Thrown to roll the dry run back; never escapes. */
class DryRun extends Error {}

type Recs = {
  readonly ids: readonly number[];
  readonly length: number;
  write(values: unknown): Promise<void>;
};
interface Model {
  search(q: unknown): Promise<Recs>;
  browse(ids: readonly number[]): Recs;
  create(values: unknown): Promise<Recs>;
}
const model = (env: Env, name: string): Model => env.model(name as never) as unknown as Model;

const errorText = (error: unknown): string => {
  const p = problemOf(error);
  if (p.status >= 500) return error instanceof Error ? error.message : String(error);
  return p.hint === undefined ? p.detail : `${p.detail} ${p.hint}`;
};

/** Reads what the steps need from Odoo, then imports it into Kosh. */
export async function importFromOdoo(
  shutro: Shutro,
  client: OdooClient,
  options: OdooImportOptions,
): Promise<OdooReport> {
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? true;
  const registry = shutro.registry;
  const koshFields = (name: string): ReadonlySet<string> | null => {
    const m = registry?.models.get(name);
    return m === undefined ? null : new Set(Object.keys(m.fieldOrigins));
  };

  // ---- read Odoo first: lookups, then each step's records (nothing in Kosh is open meanwhile)
  // One after the other: the same requests in the same order on every run (recordings replay in order).
  const countries = await client.readAll('res.country', ['code']);
  const states = await client.readAll('res.country.state', ['code']);
  const users = await client.readAll('res.users', ['partner_id']);
  const [me] = await client.read('res.users', [client.uid], ['company_id']);
  const odooCompany = idOf(me?.['company_id']) ?? 1;
  const companies = await client.readAll('res.company', ['partner_id']);
  const xmlIds = new Map<string, ReadonlyMap<number, string>>();
  for (const m of ['uom.uom', 'product.category']) xmlIds.set(m, await client.externalIds(m));
  const refs = new Map<string, Map<number, number>>();
  const read = new Map<string, readonly OdooRecord[]>();
  const ctx: StepContext = {
    odooCompany,
    company: options.company,
    records: (m) => read.get(m) ?? [],
    ref: (m, id) => (id === null ? null : (refs.get(m)?.get(id) ?? null)),
    refs: (m, ids) =>
      ids.map((id) => refs.get(m)?.get(id)).filter((v): v is number => v !== undefined),
    odooXmlId: (m, id) => xmlIds.get(m)?.get(id),
    countries: new Map(countries.map((c) => [c.id, textOf(c['code']).toUpperCase()])),
    states: new Map(states.map((s) => [s.id, textOf(s['code']).toUpperCase()])),
    internalPartners: new Set(
      [...users, ...companies]
        .map((u) => idOf(u['partner_id']))
        .filter((v): v is number => v !== null),
    ),
  };

  const planned: { step: Step; records: OdooRecord[] | null; reason?: string }[] = [];
  let openingResult: OpeningResult | undefined;
  let stockResult: StockResult | undefined;
  let checks: Check[] | undefined;
  for (const step of STEPS) {
    const missing = step.needs.filter((m) => koshFields(m) === null);
    if (missing.length > 0) {
      planned.push({
        step,
        records: null,
        reason: `the Kosh app with ${missing.join(', ')} is not installed`,
      });
      continue;
    }
    const fields = await client.fields(step.odoo);
    if (fields === null) {
      planned.push({ step, records: null, reason: `${step.odoo} is not installed in Odoo` });
      continue;
    }
    const records = await client.readAll(step.odoo, readableFields(step, fields));
    options.onStep?.(step.key, records.length);
    read.set(step.odoo, records);
    planned.push({ step, records });
  }

  const opening: OdooOpening | null =
    options.opening === undefined ? null : await readOpening(client, options.opening);
  const stockSteps = ['products', 'locations', 'lots'];
  const stockPlanned = planned.some((p) => stockSteps.includes(p.step.key) && p.records !== null);
  const stock: OdooStock | null =
    options.opening === undefined || !stockPlanned
      ? null
      : await readStock(client, odooCompany, options.opening.cutoff);

  // ---- write Kosh: one transaction, a savepoint per record
  const reports: StepReport[] = [];
  const run = async (env: Env): Promise<void> => {
    // Bound to the record's savepoint: the outer env is unusable while one is open.
    const refIdOf =
      (tx: Env): RefId =>
      (name, externalId) =>
        refIdIn(tx, name, externalId);
    const findIn =
      (tx: Env): Find =>
      async (name, where) => {
        const found = await model(tx, name).search({ where, limit: 2 });
        return found.length === 1 ? (found.ids[0] as number) : null;
      };
    for (const { step, records, reason } of planned) {
      if (records === null) {
        reports.push({
          key: step.key,
          odoo: step.odoo,
          kosh: step.kosh,
          status: 'left-out',
          ...(reason === undefined ? {} : { reason }),
          read: 0,
          created: 0,
          updated: 0,
          linked: 0,
          skipped: {},
          failed: [],
        });
        continue;
      }
      const known = koshFields(step.kosh) ?? new Set<string>();
      const keep = (values: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(values).filter(([k]) => known.has(k)));
      const mine = new Map<number, number>();
      refs.set(step.odoo, mine);
      let created = 0;
      let updated = 0;
      let linked = 0;
      const skipped: Record<string, number> = {};
      const failed: FailedRecord[] = [];
      const done: OdooRecord[] = [];
      for (const r of records) {
        const why = step.skip?.(r, ctx) ?? null;
        if (why !== null) {
          skipped[why] = (skipped[why] ?? 0) + 1;
          continue;
        }
        const xmlId = externalIdFor(step.odoo, r.id);
        try {
          const outcome = await env.transaction(async (tx) => {
            const values = keep(step.values(r, ctx));
            const updates = Object.fromEntries(
              Object.entries(values).filter(([k]) => !(step.createOnly ?? []).includes(k)),
            );
            const existing = await refIdIn(tx, step.kosh, xmlId);
            if (existing !== null) {
              await model(tx, step.kosh).browse([existing]).write(updates);
              return { id: existing, how: 'updated' as const };
            }
            const same = (await step.link?.(r, values, ctx, findIn(tx), refIdOf(tx))) ?? null;
            if (same !== null) {
              await model(tx, step.kosh).browse([same]).write(updates);
              await tx
                .withFlags({ activeTest: false })
                .setExternalId(step.kosh as never, same, xmlId);
              return { id: same, how: 'linked' as const };
            }
            const made = await model(tx, step.kosh).create([values]);
            const id = made.ids[0] as number;
            await tx.withFlags({ activeTest: false }).setExternalId(step.kosh as never, id, xmlId);
            return { id, how: 'created' as const };
          });
          mine.set(r.id, outcome.id);
          done.push(r);
          if (outcome.how === 'created') created += 1;
          else if (outcome.how === 'updated') updated += 1;
          else linked += 1;
        } catch (error) {
          if (problemOf(error).status >= 500 && !(error instanceof Error)) throw error;
          failed.push({
            odooId: r.id,
            name: textOf(r['name']) || textOf(r['display_name']),
            error: errorText(error),
          });
        }
      }
      // Second pass: relations within the step (a parent), once every record of it exists.
      if (step.later !== undefined)
        for (const r of done) {
          const values = keep(step.later(r, ctx));
          if (Object.keys(values).length === 0) continue;
          try {
            await env.transaction((tx) =>
              model(tx, step.kosh)
                .browse([mine.get(r.id) as number])
                .write(values),
            );
          } catch (error) {
            failed.push({ odooId: r.id, name: textOf(r['name']), error: errorText(error) });
          }
        }
      reports.push({
        key: step.key,
        odoo: step.odoo,
        kosh: step.kosh,
        status: 'done',
        read: records.length,
        created,
        updated,
        linked,
        skipped,
        failed,
      });
    }
    // The stock first: its adjustments post at the cut-off, and the opening entry takes them into account.
    const stockChecks: Check[] = [];
    if (stock !== null) {
      const missing = stockSteps.filter((k) => reports.find((r) => r.key === k)?.status !== 'done');
      if (missing.length > 0)
        stockResult = {
          status: 'done',
          adjustments: 0,
          lines: 0,
          failed: [{ what: 'the stock', error: `the ${missing.join(' and ')} step did not run` }],
        };
      else {
        stockResult = await writeStock(env, stock, ctx.ref, errorText, koshFields);
        stockChecks.push(
          ...(await reconcileStock(
            env,
            stock,
            ctx.ref,
            koshFields('stock.valuation.layer') !== null,
          )),
        );
      }
    }
    if (opening !== null) {
      const needed = ['accounts', 'partners'].filter(
        (k) => reports.find((r) => r.key === k)?.status !== 'done',
      );
      if (needed.length > 0)
        openingResult = {
          status: 'skipped',
          entry: null,
          entryLines: 0,
          documents: 0,
          failed: [{ what: 'the books', error: `the ${needed.join(' and ')} step did not run` }],
        };
      else {
        openingResult = await writeOpening(env, opening, ctx.ref, errorText);
        checks = await reconcile(env, opening, ctx.ref);
      }
    }
    if (stockChecks.length > 0) checks = [...(checks ?? []), ...stockChecks];
    if (dryRun) throw new DryRun();
  };
  try {
    await shutro.bootstrap(
      { reason: dryRun ? 'odoo import (dry run)' : 'odoo import', company: options.company },
      run,
    );
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }

  const ok =
    reports.every((s) => s.failed.length === 0) &&
    (openingResult?.failed.length ?? 0) === 0 &&
    (stockResult?.failed.length ?? 0) === 0 &&
    (checks ?? []).every((c) => c.ok);
  return {
    odoo: { url: options.source.url, db: options.source.db, version: client.version },
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: reports,
    ...(openingResult === undefined ? {} : { opening: openingResult }),
    ...(stockResult === undefined ? {} : { stock: stockResult }),
    ...(checks === undefined ? {} : { checks }),
    ok,
  };
}

async function refIdIn(env: Env, name: string, externalId: string): Promise<number | null> {
  try {
    // Archived records too: an archived Odoo record is imported archived, and found again.
    return Number(await env.withFlags({ activeTest: false }).refId(name as never, externalId));
  } catch {
    return null;
  }
}

/** The report as text: one block per step, every record accounted for. */
export function reportText(report: OdooReport): string {
  const lines: string[] = [
    `Odoo ${report.odoo.version} at ${report.odoo.url}, database ${report.odoo.db} — ${report.dryRun ? 'dry run: nothing was kept' : 'imported'}`,
    '',
  ];
  for (const s of report.steps) {
    if (s.status === 'left-out') {
      lines.push(`– ${s.key}: left out, ${s.reason ?? ''}`);
      continue;
    }
    const skipped = Object.values(s.skipped).reduce((a, b) => a + b, 0);
    const mark = s.failed.length === 0 ? '✔' : '✖';
    lines.push(
      `${mark} ${s.key} (${s.odoo} → ${s.kosh}): ${s.read} read — ${s.created} created, ${s.updated} updated, ${s.linked} linked to existing, ${skipped} skipped, ${s.failed.length} failed`,
    );
    for (const [why, n] of Object.entries(s.skipped)) lines.push(`    skipped ${n}: ${why}`);
    for (const f of s.failed.slice(0, 20))
      lines.push(`    failed #${f.odooId} ${f.name}: ${f.error}`);
    if (s.failed.length > 20)
      lines.push(`    … and ${s.failed.length - 20} more in the JSON report`);
  }
  if (report.opening !== undefined) {
    const o = report.opening;
    lines.push(
      '',
      o.status === 'skipped' && o.failed.length === 0
        ? '– the books: an opening at this cut-off was imported before'
        : `${o.failed.length === 0 ? '✔' : '✖'} the books: an opening entry of ${o.entryLines} lines, ${o.documents} open invoices, credit notes and bills`,
    );
    for (const f of o.failed.slice(0, 20)) lines.push(`    failed ${f.what}: ${f.error}`);
  }
  if (report.stock !== undefined) {
    const s = report.stock;
    lines.push(
      s.status === 'skipped'
        ? '– the stock: imported at this cut-off before'
        : `${s.failed.length === 0 ? '✔' : '✖'} the stock: ${s.adjustments} inventory adjustments, one per location, of ${s.lines} lines`,
    );
    for (const f of s.failed.slice(0, 20)) lines.push(`    failed ${f.what}: ${f.error}`);
    if (s.failed.length > 20)
      lines.push(`    … and ${s.failed.length - 20} more in the JSON report`);
  }
  if (report.checks !== undefined) {
    lines.push('', 'Reconciliation with Odoo:');
    for (const c of report.checks) {
      lines.push(`${c.ok ? '✔' : '✖'} ${c.name}: ${c.summary}`);
      for (const d of c.differences.slice(0, 20))
        lines.push(`    ${d.what}: Odoo ${d.odoo}, Kosh ${d.kosh}`);
      if (c.differences.length > 20)
        lines.push(`    … and ${c.differences.length - 20} more in the JSON report`);
    }
  }
  return `${lines.join('\n')}\n`;
}
