/**
 * The data layer of Bangladesh at the counter (RFC 0021, Counter step 4): a shop says whether it issues **Mushak
 * 6.3** receipts — the tax invoice NBR asks of a VAT-registered seller, here at the till — and the shop's receipt
 * template follows (`pos.shop.receiptTemplate()`): the seller with its BIN, the buyer when known, the number and the
 * time of issue, the lines with their VAT, the totals and the amount in words.
 */
import { l10nBdShutro } from '@kosh/l10n_bd';
import { posShutro } from '@kosh/pos';
import { orm } from '@kosh/server/orm';
import { defineModule, extendModel, f, type Records } from './.kosh/bindings.js';

export const ShopMushak = extendModel('pos.shop', {
  fields: {
    mushakReceipt: f.boolean({
      default: true,
      label: 'Mushak 6.3 receipts',
      help: 'Its receipts are tax invoices (Mushak 6.3) with the company’s BIN and each line’s VAT; off: the plain receipt.',
    }),
  },
  overrides: {
    receiptTemplate: async function (
      this: unknown,
      next: () => Promise<Map<number, string>>,
    ): Promise<Map<number, string>> {
      const out = await next();
      const shops = this as Records<'pos.shop'>;
      for (const s of await shops.load(['mushakReceipt']))
        if (s.mushakReceipt) out.set(s.id as number, 'l10n_bd_pos.mushak_6_3_receipt');
      return out;
    },
  },
});

export const l10nBdPosShutro = defineModule({
  name: 'l10n_bd_pos',
  version: '0.1.0',
  depends: [l10nBdShutro, posShutro],
  groups: [
    orm.defineGroup({
      code: 'l10n_bd_pos.user',
      label: 'Mushak receipts at the counter',
      implies: ['pos.cashier'],
    }),
  ],
  models: [],
  extensions: [ShopMushak],
});
