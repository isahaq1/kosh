/**
 * Bangladesh payroll (RFC 0024 §2.3, `l10n_bd_payroll`): the data of `data.ts` — structures, parameters and slab
 * tables — installed once, shared by every company, never overwritten: what a payroll manager changed stays.
 */
import { hrAccrualShutro } from '@kosh/hr_accrual';
import { l10nBdShutro } from '@kosh/l10n_bd';
import { payrollShutro } from '@kosh/payroll';
import { type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { defineModule, type Env } from './.kosh/bindings.js';
import { LEAVE_ENCASH_RULE, LEAVE_PLANS, PARAMETERS, SLABS, STRUCTURES } from './data.js';

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
  // Structures installed before leave payouts existed get the rule that pays them (nothing else is touched).
  for (const s of STRUCTURES) {
    const [structure] = await env
      .model('payroll.structure')
      .search({ where: { name: s.name }, limit: 1 })
      .then((found) => found.load({ rules: true }));
    if (structure === undefined) continue;
    if ([...structure.rules].some((r) => r.code === LEAVE_ENCASH_RULE.code)) continue;
    await env.model('payroll.rule').create([
      {
        structure: structure.id,
        sequence: LEAVE_ENCASH_RULE.sequence,
        code: LEAVE_ENCASH_RULE.code,
        name: LEAVE_ENCASH_RULE.name,
        category: LEAVE_ENCASH_RULE.category,
        formula: LEAVE_ENCASH_RULE.formula,
        condition: LEAVE_ENCASH_RULE.condition ?? null,
        note: LEAVE_ENCASH_RULE.note ?? null,
      } as never,
    ]);
    added += 1;
  }
  added += await installLeavePlans(env);
  await env.flush();
  return added === 0
    ? 'Bangladesh payroll: already installed.'
    : `Bangladesh payroll: ${added} structures, parameters and tax tables.`;
}

/**
 * The Labour Act's leave as accrual plans (RFC 0034 §2.5), for the company of `env`: one per leave type that has
 * no plan yet — active or not —, made **switched off**, with what to verify in its first note. Returns how many.
 */
export async function installLeavePlans(env: Env): Promise<number> {
  const company = Number(env.companyId);
  if (!Number.isSafeInteger(company) || company <= 0) return 0;
  let added = 0;
  const year = String(env.today()).slice(0, 4);
  for (const plan of LEAVE_PLANS) {
    const type = (await env.model('hr.leave.type').search({ where: { name: plan.type }, limit: 1 }))
      .ids[0];
    if (type === undefined) continue;
    // Switched-off plans count too: they are what this installs.
    const existing = await env
      .withFlags({ activeTest: false })
      .model('hr.accrual.plan')
      .search({ where: { type, company: company as never } as never, limit: 1 });
    if (existing.length > 0) continue;
    await env.model('hr.accrual.plan').create([
      {
        name: plan.name,
        type,
        company,
        active: false,
        dateStart: `${year}-01-01`,
        formula: plan.formula,
        probationMonths: plan.probationMonths,
        cap: plan.cap,
        carryOver: plan.carryOver,
        encashable: plan.encashable,
        encashFormula: plan.encashFormula,
        note: plan.note,
      } as never,
    ]);
    added += 1;
  }
  return added;
}

// Named so the module's type stays short enough to emit (TS7056) with every model its dependencies carry.
const DEPENDS: readonly ModuleBase[] = [l10nBdShutro, payrollShutro, hrAccrualShutro];
const MODELS = [] as const;

export const l10nBdPayrollShutro: Module<typeof MODELS, readonly ModuleBase[]> = defineModule({
  name: 'l10n_bd_payroll',
  version: '0.1.0',
  depends: DEPENDS,
  groups: [
    orm.defineGroup({
      code: 'l10n_bd_payroll.user',
      label: 'Bangladesh payroll',
      implies: ['payroll.user'],
    }),
  ],
  models: MODELS,
});
