/**
 * The GST documents (RFC 0016 step 5), as document templates (RFC 0005): the tax invoice with what rule 46 of the
 * CGST Rules asks for — supplier and recipient with their GSTIN, the place of supply, each line's HSN / SAC, taxable
 * value, rate and CGST / SGST / IGST / cess, whether tax is payable under reverse charge, the total in words — and
 * the credit and debit notes. The company's to change in the designer.
 */
import type { DocumentSpec } from '@kosh/modules-sdk';
import type { Block } from '@kosh/views';

const parties: Block = {
  kind: 'columns',
  id: 'parties',
  left: [
    {
      kind: 'fields',
      id: 'supplier',
      items: [
        { label: 'Supplier', bind: 'company.name' },
        { label: 'GSTIN', bind: 'company.gstin' },
        { label: 'State', bind: 'company.state' },
      ],
    },
  ],
  right: [
    {
      kind: 'fields',
      id: 'recipient',
      items: [
        { label: 'Recipient', bind: 'partner.name' },
        { label: 'GSTIN', bind: 'partner.gstin' },
        { label: 'Address', bind: 'partner.street' },
        { label: 'City', bind: 'partner.city' },
        { label: 'State', bind: 'partner.state' },
      ],
    },
  ],
};

const lines: Block = {
  kind: 'table',
  id: 'lines',
  bind: 'invoiceLines',
  columns: [
    { label: 'Description', bind: 'name' },
    { label: 'HSN / SAC', bind: 'product.hsnCode' },
    { label: 'Qty', bind: 'quantity', align: 'end' },
    { label: 'Rate', bind: 'priceUnit', align: 'end' },
    { label: 'Taxable value', bind: 'subtotal', align: 'end', sum: true },
    { label: 'GST %', bind: 'gstRate', align: 'end' },
    { label: 'CGST', bind: 'cgstAmount', align: 'end', sum: true },
    { label: 'SGST', bind: 'sgstAmount', align: 'end', sum: true },
    { label: 'IGST', bind: 'igstAmount', align: 'end', sum: true },
    { label: 'Cess', bind: 'cessAmount', align: 'end', sum: true },
    { label: 'Total', bind: 'totalWithGst', align: 'end', sum: true },
  ],
};

const totals: Block = {
  kind: 'fields',
  id: 'totals',
  columns: 3,
  items: [
    { label: 'Taxable value', bind: 'amountUntaxed' },
    { label: 'GST and cess', bind: 'amountTax' },
    { label: 'Total', bind: 'amountTotal' },
  ],
};

const signature: Block = {
  kind: 'signature',
  id: 'signature',
  labels: ['For the supplier: authorised signatory'],
};

const document = (
  key: string,
  name: string,
  title: string,
  extra: readonly { readonly label: string; readonly bind: string }[],
): DocumentSpec => ({
  key,
  name,
  model: 'account.move',
  layout: {
    paper: 'A4',
    orientation: 'landscape',
    header: '{{company.name}} · GSTIN {{company.gstin}}',
    footer: `${title} · Page {{page}} of {{pages}}`,
    blocks: [
      { kind: 'heading', id: 'title', text: title, level: 1 },
      // Once registered with the IRP (e-invoicing): the IRN and its acknowledgement.
      {
        kind: 'fields',
        id: 'irn',
        columns: 3,
        items: [
          { label: 'IRN', bind: 'irn' },
          { label: 'Ack. no.', bind: 'irnAckNo' },
          { label: 'Ack. date', bind: 'irnAckDate' },
        ],
      },
      parties,
      {
        kind: 'fields',
        id: 'document',
        columns: 3,
        items: [
          { label: 'Number', bind: 'name' },
          { label: 'Date', bind: 'date' },
          { label: 'Place of supply', bind: 'placeOfSupply' },
          { label: 'Tax payable on reverse charge', bind: 'gstReverseCharge' },
          ...extra,
        ],
      },
      lines,
      totals,
      { kind: 'text', id: 'in_words', text: 'In words: {{amountTotal|words}}' },
      signature,
    ],
  },
});

export const GST_DOCUMENTS: readonly DocumentSpec[] = [
  document('gst_tax_invoice', 'Tax invoice (GST)', 'Tax invoice', []),
  document('gst_credit_note', 'Credit note (GST)', 'Credit note', [
    { label: 'Against invoice', bind: 'reversalOf.name' },
    { label: 'Reason', bind: 'ref' },
  ]),
  document('gst_debit_note', 'Debit note (GST)', 'Debit note', [
    { label: 'Against invoice', bind: 'debitOf.name' },
    { label: 'Reason', bind: 'ref' },
  ]),
];
