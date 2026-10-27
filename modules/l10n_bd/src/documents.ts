/**
 * The Mushak documents (RFC 0016 §5.3), as document templates (RFC 0005): the tax invoice (Mushak 6.3) and the
 * credit note (Mushak 6.7) on invoices, and the certificate of VAT deducted at source (Mushak 6.6) on payments.
 * Seller and buyer with their BIN, each line's value, SD and VAT, the totals in words. Like every template, they are
 * the company's to change in the designer.
 */
import type { DocumentSpec } from '@kosh/modules-sdk';
import type { Block } from '@kosh/views';

const parties = (seller: string, buyer: string): Block => ({
  kind: 'columns',
  id: 'parties',
  left: [
    {
      kind: 'fields',
      id: 'seller',
      items: [
        { label: seller, bind: 'company.name' },
        { label: `${seller}'s BIN`, bind: 'company.bin' },
      ],
    },
  ],
  right: [
    {
      kind: 'fields',
      id: 'buyer',
      items: [
        { label: buyer, bind: 'partner.name' },
        { label: `${buyer}'s BIN`, bind: 'partner.bin' },
        { label: 'Address', bind: 'partner.street' },
        { label: 'City', bind: 'partner.city' },
      ],
    },
  ],
});

const lines: Block = {
  kind: 'table',
  id: 'lines',
  bind: 'invoiceLines',
  columns: [
    { label: 'Description', bind: 'name' },
    { label: 'Quantity', bind: 'quantity', align: 'end' },
    { label: 'Unit price', bind: 'priceUnit', align: 'end' },
    { label: 'Value', bind: 'subtotal', align: 'end', sum: true },
    { label: 'SD', bind: 'sdAmount', align: 'end', sum: true },
    { label: 'VAT', bind: 'vatAmount', align: 'end', sum: true },
    { label: 'Total with taxes', bind: 'totalWithTaxes', align: 'end', sum: true },
  ],
};

const totals: Block = {
  kind: 'fields',
  id: 'totals',
  columns: 3,
  items: [
    { label: 'Value', bind: 'amountUntaxed' },
    { label: 'SD and VAT', bind: 'amountTax' },
    { label: 'Total', bind: 'amountTotal' },
  ],
};

const signature: Block = {
  kind: 'signature',
  id: 'signature',
  labels: ['Authorised person: name, designation and signature'],
};

export const MUSHAK_DOCUMENTS: readonly DocumentSpec[] = [
  {
    key: 'mushak_6_3',
    name: 'Tax invoice (Mushak 6.3)',
    model: 'account.move',
    layout: {
      paper: 'A4',
      header: '{{company.name}} · BIN {{company.bin}}',
      footer: 'Mushak 6.3 · Page {{page}} of {{pages}}',
      blocks: [
        { kind: 'heading', id: 'title', text: 'Tax invoice', level: 1 },
        { kind: 'text', id: 'form', text: 'Mushak 6.3' },
        parties('Seller', 'Buyer'),
        {
          kind: 'fields',
          id: 'invoice',
          columns: 3,
          items: [
            { label: 'Invoice number', bind: 'name' },
            { label: 'Date of issue', bind: 'date' },
            { label: 'Time of issue', bind: 'postedAt' },
          ],
        },
        lines,
        totals,
        { kind: 'text', id: 'in_words', text: 'In words: {{amountTotal|words}}' },
        signature,
      ],
    },
  },
  {
    key: 'mushak_6_7',
    name: 'Credit note (Mushak 6.7)',
    model: 'account.move',
    layout: {
      paper: 'A4',
      header: '{{company.name}} · BIN {{company.bin}}',
      footer: 'Mushak 6.7 · Page {{page}} of {{pages}}',
      blocks: [
        { kind: 'heading', id: 'title', text: 'Credit note', level: 1 },
        { kind: 'text', id: 'form', text: 'Mushak 6.7' },
        parties('Seller', 'Buyer'),
        {
          kind: 'fields',
          id: 'note',
          columns: 3,
          items: [
            { label: 'Credit note number', bind: 'name' },
            { label: 'Date of issue', bind: 'date' },
            { label: 'Tax invoice it corrects', bind: 'reversalOf.name' },
          ],
        },
        { kind: 'field', id: 'reason', label: 'Reason', bind: 'ref' },
        lines,
        totals,
        { kind: 'text', id: 'in_words', text: 'In words: {{amountTotal|words}}' },
        signature,
      ],
    },
  },
  {
    key: 'mushak_6_6',
    name: 'Certificate of VAT deducted at source (Mushak 6.6)',
    model: 'account.payment',
    layout: {
      paper: 'A4',
      header: '{{company.name}} · BIN {{company.bin}}',
      footer: 'Mushak 6.6 · Page {{page}} of {{pages}}',
      blocks: [
        { kind: 'heading', id: 'title', text: 'Certificate of VAT deducted at source', level: 1 },
        { kind: 'text', id: 'form', text: 'Mushak 6.6' },
        parties('Withholding entity', 'Supplier'),
        {
          kind: 'fields',
          id: 'payment',
          columns: 3,
          items: [
            { label: 'Certificate number', bind: 'name' },
            { label: 'Date', bind: 'date' },
            { label: 'Paid', bind: 'amount' },
          ],
        },
        {
          kind: 'table',
          id: 'withheld',
          bind: 'withholdings',
          columns: [
            { label: 'Deduction', bind: 'withholding.name' },
            { label: 'On', bind: 'base', align: 'end' },
            { label: 'Deducted', bind: 'amount', align: 'end', sum: true },
          ],
        },
        { kind: 'text', id: 'in_words', text: 'Deducted: {{amountWithheld|words}}' },
        signature,
      ],
    },
  },
];
