/**
 * Bangladesh payroll (RFC 0024 §2.3, `l10n_bd_payroll`): the data of `data.ts` — structures, parameters and slab
 * tables — installed once, shared by every company, never overwritten: what a payroll manager changed stays.
 */
import { l10nBdShutro } from '@kosh/l10n_bd';
import { payrollShutro } from '@kosh/payroll';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env } from './.kosh/bindings.js';
import { PARAMETERS, SLABS, STRUCTURES } from './data.js';

/** Installs what is missing: parameters and slabs by code and start, structures by name. */
export async function installBangladeshPayroll(env: Env): Promise<string> {
  let added = 0;
  for (const p of PARAMETERS) {
    const found = await env.model('payroll.parameter').search({
      where: { code: p.code, ...(p.dateFrom === undefined ? {} : { dateFrom: p.dateFrom }) },
      limit: 1,
    });
    if (found.length > 0) continue;
    await env.model('payroll.parameter').create([{ ...p } as never]);
    added += 1;
  }
  for (const s of SLABS) {
    const found = await env
      .model('payroll.slab')
      .search({ where: { code: s.code, dateFrom: s.dateFrom }, limit: 1 });
    if (found.length > 0) continue;
    await env.model('payroll.slab').create([
      {
        code: s.code,
        name: s.name,
        dateFrom: s.dateFrom,
        dateTo: s.dateTo,
        note: s.note,
        bands: {
          create: s.bands.map((b, i) => ({ sequence: (i + 1) * 10, upTo: b.upTo, rate: b.rate })),
        },
      } as never,
    ]);
    added += 1;
  }
  for (const s of STRUCTURES) {
    const found = await env
      .model('payroll.structure')
      .search({ where: { name: s.name }, limit: 1 });
    if (found.length > 0) continue;
    await env.model('payroll.structure').create([
      {
        name: s.name,
        note: s.note,
        rules: {
          create: s.rules.map((r) => ({
            sequence: r.sequence,
            code: r.code,
            name: r.name,
            category: r.category,
            formula: r.formula,
            condition: r.condition ?? null,
            appearsOnSlip: r.appearsOnSlip ?? true,
            note: r.note ?? null,
          })),
        },
      } as never,
    ]);
    added += 1;
  }
  await env.flush();
  return added === 0
    ? 'Bangladesh payroll: already installed.'
    : `Bangladesh payroll: ${added} structures, parameters and tax tables.`;
}

export const l10nBdPayrollShutro = defineModule({
  name: 'l10n_bd_payroll',
  version: '0.1.0',
  depends: [l10nBdShutro, payrollShutro],
  groups: [
    orm.defineGroup({
      code: 'l10n_bd_payroll.user',
      label: 'Bangladesh payroll',
      implies: ['payroll.user'],
    }),
  ],
  models: [],
});
