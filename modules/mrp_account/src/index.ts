/**
 * @packageDocumentation
 * `@kosh/mrp_account`: the bridge between Production and Accounting (RFC 0021, Production step 2). Proposed whenever
 * both apps are installed. Products made are valued at what they consumed plus their operations; the operations are
 * posted into Work in progress, which clears with each order.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { mrp } from '@kosh/mrp';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { mrpAccountShutro } from './module.js';

export { LABOUR_ACCOUNT, mrpAccountShutro, OperationsPosted, OutputCost } from './module.js';

export const mrpAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: mrpAccountShutro,
  kosh: '^0.1.0',
  depends: [mrp, stock, stockAccount, accounting],
  bridge: [mrp, accounting],
  accessLevels: {
    user: { label: 'Production valued', groups: ['mrp_account.user'] },
  },
});
