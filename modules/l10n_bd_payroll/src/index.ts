/**
 * @packageDocumentation
 * `@kosh/l10n_bd_payroll`: Bangladesh payroll (RFC 0024 §2.3), proposed whenever the Bangladesh localization and
 * Payroll are installed. Two salary structures — standard, and garments (RMG) on the minimum wage breakdown — with
 * overtime at the shift's rate of the basic ÷ 208, festival bonuses after a year's service, absence on the basic,
 * provident fund for its members, and income tax deducted at source from the year's slabs, the exemption, the
 * investment rebate and the minimum tax, spread over the months left. All of it data a payroll manager can change.
 */
import { l10nBd } from '@kosh/l10n_bd';
import { defineModule } from '@kosh/modules-sdk';
import { payroll } from '@kosh/payroll';
import type { Env } from './.kosh/bindings.js';
import { installBangladeshPayroll, l10nBdPayrollShutro } from './module.js';

export { PARAMETERS, type RuleData, SLABS, STRUCTURES } from './data.js';
export { installBangladeshPayroll, l10nBdPayrollShutro } from './module.js';

export const l10nBdPayroll: ReturnType<typeof defineModule> = defineModule({
  shutro: l10nBdPayrollShutro,
  kosh: '^0.1.0',
  depends: [l10nBd, payroll],
  bridge: [l10nBd, payroll],
  hooks: { defaults: async (env) => installBangladeshPayroll(env as Env) },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Bangladesh payroll', groups: ['l10n_bd_payroll.user'] },
  },
});
