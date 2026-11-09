/**
 * @packageDocumentation
 * `@kosh/production_account`: the bridge between Production and Accounting (RFC 0021, Production step 2). Proposed whenever
 * both apps are installed. Products made are valued at what they consumed plus their operations; the operations are
 * posted into Work in progress, which clears with each order.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { production } from '@kosh/production';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { field } from '@kosh/views';
import { productionAccountShutro } from './module.js';

export { LABOUR_ACCOUNT, OperationsPosted, OutputCost, productionAccountShutro } from './module.js';

export const productionAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: productionAccountShutro,
  kosh: '^0.1.0',
  depends: [production, stock, stockAccount, accounting],
  bridge: [production, accounting],
  viewExtensions: [
    {
      view: 'production.workcenter.form',
      operations: [
        {
          append: 'main',
          nodes: [field({ field: 'expenseAccount', id: 'workcenter_expense_account' })],
        },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Production valued', groups: ['production_account.user'] },
  },
});
