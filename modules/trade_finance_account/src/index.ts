/**
 * @packageDocumentation
 * `@kosh/trade_finance_account`: the bridge between Trade Finance and Accounting (RFC 0021, Trade Finance step 2).
 * Proposed whenever both apps are installed. LC margins, payments and bank charges are posted in the LC's bank
 * journal; charges are expensed (LC charges).
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { tradeFinance } from '@kosh/trade_finance';
import { action, field, form, list, search } from '@kosh/views';
import { TradeCharge, tradeFinanceAccountShutro } from './module.js';

export {
  LcAccounting,
  PresentationPayment,
  TRADE_ACCOUNTS,
  TradeCharge,
  tradeFinanceAccountShutro,
} from './module.js';

export const tradeFinanceAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: tradeFinanceAccountShutro,
  kosh: '^0.1.0',
  depends: [tradeFinance, accounting],
  bridge: [tradeFinance, accounting],
  accessLevels: {
    user: { label: 'Trade Finance in the books', groups: ['trade_finance_account.user'] },
  },
  actions: {
    'tradefinance.action_charges': action(TradeCharge, {
      label: 'Bank charges',
      views: ['list', 'form'],
    }),
  },
  menus: [
    {
      id: 'tradefinance.charges',
      parent: 'tradefinance.root',
      label: 'Bank charges',
      action: 'tradefinance.action_charges',
      sequence: 5,
    },
  ],
  views: {
    'trade.lc.charge.list': list(TradeCharge, {
      columns: ['lc', 'date', 'name', 'amount', { field: 'state', widget: 'badge' }],
    }),
    'trade.lc.charge.form': form(TradeCharge, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [k.button('post', { primary: true, label: 'Post' })],
      },
      sheet: [k.group('main', ['lc', 'date', 'name', 'currency', 'amount', 'move'])],
    })),
  },
  search: {
    'trade.lc.charge': search(TradeCharge, {
      fields: ['name', 'lc.name'],
      groupBy: ['lc', 'state'],
    }),
  },
  viewExtensions: [
    {
      view: 'trade.lc.form',
      operations: [
        { append: 'parties', nodes: [field({ field: 'journal', id: 'lc_journal' })] },
        {
          append: 'drawings',
          nodes: [
            field({ field: 'marginMove', id: 'lc_margin_move' }),
            field({ field: 'marginReleaseMove', id: 'lc_margin_release' }),
          ],
        },
        {
          insertAfter: 'amendments',
          nodes: [
            {
              kind: 'lines',
              id: 'charges',
              field: 'charges',
              columns: [
                field({ field: 'date', id: 'charge_date' }),
                field({ field: 'name', id: 'charge_name' }),
                field({ field: 'currency', id: 'charge_currency' }),
                field({ field: 'amount', id: 'charge_amount' }),
                field({ field: 'state', id: 'charge_state' }),
              ],
            },
          ],
        },
      ],
    },
    {
      view: 'trade.lc.presentation.form',
      operations: [
        { append: 'dates', nodes: [field({ field: 'paymentMove', id: 'presentation_payment' })] },
      ],
    },
  ],
});
