/**
 * @packageDocumentation
 * `@kosh/payroll_account`: the bridge between Payroll and Accounting (RFC 0024 §2.3). Proposed whenever both apps are
 * installed: rules get their account; an approved run is booked as one entry, its payment from the bank or cash
 * journal chosen on it; a correction books only its differences.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { payroll } from '@kosh/payroll';
import { field } from '@kosh/views';
import { payrollAccountShutro } from './module.js';

export {
  PAYROLL_ACCOUNTS,
  payrollAccountShutro,
  payrollAccountsOf,
  RuleAccount,
  RunBooks,
} from './module.js';

export const payrollAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: payrollAccountShutro,
  kosh: '^0.1.0',
  depends: [payroll, accounting],
  bridge: [payroll, accounting],
  accessLevels: {
    user: { label: 'Payroll in the books', groups: ['payroll_account.user'] },
  },
  viewExtensions: [
    {
      view: 'payroll.rule.form',
      operations: [{ append: 'main', nodes: [field({ field: 'account', id: 'rule_account' })] }],
    },
    {
      view: 'payroll.run.form',
      operations: [
        {
          append: 'totals',
          nodes: [
            field({ field: 'paymentJournal', id: 'run_journal' }),
            field({ field: 'entry', id: 'run_entry' }),
            field({ field: 'paymentEntry', id: 'run_payment' }),
          ],
        },
      ],
    },
  ],
});
