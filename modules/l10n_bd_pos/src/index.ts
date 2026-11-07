/**
 * @packageDocumentation
 * `@kosh/l10n_bd_pos`: Bangladesh at the counter (RFC 0021, Counter step 4), proposed whenever the Bangladesh
 * localization and Counter are installed. Shops issue Mushak 6.3 receipts — the tax invoice, at the till — unless
 * switched off: the seller and its BIN, the buyer and theirs when the sale has a customer, the number and the time of
 * issue, the lines with their VAT, the totals and the amount in words.
 */
import { l10nBd } from '@kosh/l10n_bd';
import { defineModule } from '@kosh/modules-sdk';
import { pos } from '@kosh/pos';
import { field } from '@kosh/views';
import { l10nBdPosShutro } from './module.js';

export { l10nBdPosShutro, ShopMushak } from './module.js';

export const l10nBdPos: ReturnType<typeof defineModule> = defineModule({
  shutro: l10nBdPosShutro,
  kosh: '^0.1.0',
  depends: [l10nBd, pos],
  bridge: [l10nBd, pos],
  documents: [
    {
      key: 'mushak_6_3_receipt',
      name: 'Tax invoice (Mushak 6.3) — receipt',
      model: 'pos.order',
      layout: {
        paper: 'A4',
        header: '{{company.name}} · BIN {{company.bin}}',
        footer: 'Mushak 6.3 · Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Tax invoice', level: 1 },
          { kind: 'text', id: 'form', text: 'Mushak 6.3' },
          {
            kind: 'columns',
            id: 'parties',
            left: [
              {
                kind: 'fields',
                id: 'seller',
                items: [
                  { label: 'Seller', bind: 'company.name' },
                  { label: 'Seller’s BIN', bind: 'company.bin' },
                  { label: 'Address', bind: 'company.street' },
                  { label: 'Shop', bind: 'session.shop.name' },
                ],
              },
            ],
            right: [
              {
                kind: 'fields',
                id: 'buyer',
                items: [
                  { label: 'Buyer', bind: 'partner.name' },
                  { label: 'Buyer’s BIN', bind: 'partner.bin' },
                  { label: 'Address', bind: 'partner.street' },
                ],
              },
            ],
          },
          {
            kind: 'fields',
            id: 'invoice',
            items: [
              { label: 'Invoice number', bind: 'name' },
              { label: 'Date and time of issue', bind: 'date' },
              { label: 'Cashier', bind: 'session.cashier.name' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Description', bind: 'name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Unit price', bind: 'priceUnit' },
              { label: 'Discount %', bind: 'discount' },
              { label: 'Value', bind: 'subtotal' },
              { label: 'VAT', bind: 'taxAmount' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Total value', bind: 'amountUntaxed' },
              { label: 'Total VAT', bind: 'amountTax' },
              { label: 'Total including VAT', bind: 'total' },
              { label: 'Paid', bind: 'amountPaid' },
              { label: 'Change', bind: 'change' },
            ],
          },
          { kind: 'text', id: 'in_words', text: 'In words: {{total|words}}' },
          { kind: 'qr', id: 'qr', bind: 'name', size: 30, label: 'Invoice number' },
          { kind: 'text', id: 'footer', text: '{{session.shop.receiptFooter}}' },
        ],
      },
    },
  ],
  viewExtensions: [
    {
      view: 'pos.shop.form',
      operations: [
        { append: 'main', nodes: [field({ field: 'mushakReceipt', id: 'mushak_receipt' })] },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Mushak receipts at the counter', groups: ['l10n_bd_pos.user'] },
  },
});
