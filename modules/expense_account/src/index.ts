/**
 * @packageDocumentation
 * `@kosh/expense_account`: the bridge between Spend and Accounting (RFC 0024 §2.1). Proposed whenever both apps are
 * installed: categories get their expense account; an approved report is booked as one posted entry and reimbursed
 * from the cash or bank journal chosen on it; an advance's payout and the cash returned are booked from its journal.
 */
import { accounting } from '@kosh/accounting';
import { expense } from '@kosh/expense';
import { defineModule } from '@kosh/modules-sdk';
import { field } from '@kosh/views';
import { expenseAccountShutro } from './module.js';

export {
  AdvanceBooks,
  CategoryAccount,
  EXPENSE_ACCOUNTS,
  expenseAccountShutro,
  expenseAccountsOf,
  SheetBooks,
} from './module.js';

export const expenseAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: expenseAccountShutro,
  kosh: '^0.1.0',
  depends: [expense, accounting],
  bridge: [expense, accounting],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Spend in the books', groups: ['expense_account.user'] },
  },
  viewExtensions: [
    {
      view: 'expense.category.form',
      operations: [
        { append: 'main', nodes: [field({ field: 'account', id: 'category_account' })] },
      ],
    },
    {
      view: 'expense.category.list',
      operations: [
        { insertAfter: 'kind', nodes: [field({ field: 'account', id: 'category_account_col' })] },
      ],
    },
    {
      view: 'expense.sheet.form',
      operations: [
        {
          insertAfter: 'submit',
          nodes: [
            { kind: 'button', id: 'post', transition: 'post', label: 'Book', primary: true },
            {
              kind: 'button',
              id: 'reimburse',
              transition: 'reimburse',
              label: 'Reimburse',
              primary: true,
            },
          ],
        },
        {
          append: 'totals',
          nodes: [
            field({ field: 'paymentJournal', id: 'sheet_journal' }),
            field({ field: 'entry', id: 'sheet_entry' }),
            field({ field: 'paymentEntry', id: 'sheet_payment' }),
          ],
        },
      ],
    },
    {
      view: 'expense.advance.form',
      operations: [
        {
          append: 'settlement',
          nodes: [
            field({ field: 'paymentJournal', id: 'advance_journal' }),
            field({ field: 'entry', id: 'advance_entry' }),
            field({ field: 'returnEntry', id: 'advance_return' }),
          ],
        },
      ],
    },
  ],
});
