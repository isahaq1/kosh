/**
 * The data layer of Products (Shutro): units of measure (what Shutro's `quantity` fields are counted in), product
 * categories, taxes and products. Taxes live here rather than in Accounting, so Sales and Purchase work without the
 * Accounting app; Accounting extends them with their accounts.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { check, defineModel, defineModule, f, record } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const READ = ['read'] as const;

export const UomUom = defineModel('uom.uom', {
  label: 'Unit of measure',
  archivable: true,
  order: ['category asc', 'ratio asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    category: f.selection(
      {
        unit: 'Unit',
        time: 'Working time',
        weight: 'Weight',
        length: 'Length',
        volume: 'Volume',
      },
      { required: true, default: 'unit' },
    ),
    /** How many of the category's reference unit one of this unit is (dozen: 12; gram: 0.001 of a kg). */
    ratio: f.decimal({ scale: 6, required: true, default: '1' }),
    /** The smallest quantity in this unit (units: 1, kg: 0.001). */
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
  constraints: {
    positive: {
      ...check('uom.uom', ['ratio', 'rounding'], (uoms) =>
        uoms.filter((u) => u.ratio.lte(0) || u.rounding.lte(0)),
      ),
      message: 'A unit’s ratio and rounding must be positive.',
    },
  },
});

export const ProductCategory = defineModel('product.category', {
  label: 'Product category',
  order: ['name asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    parent: f.many2one('product.category', { ondelete: 'restrict' }),
  },
});

export const AccountTax = defineModel('account.tax', {
  label: 'Tax',
  archivable: true,
  order: ['use asc', 'rate desc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    use: f.selection({ sale: 'Sales', purchase: 'Purchases' }, { required: true, default: 'sale' }),
    /** 0.15 for 15 %. */
    rate: f.decimal({ scale: 4, required: true, default: '0' }),
  },
  constraints: {
    rateRange: {
      ...check('account.tax', ['rate'], (taxes) =>
        taxes.filter((t) => t.rate.lt(0) || t.rate.gt(1)),
      ),
      message: 'A tax rate is between 0 and 1 (0.15 for 15 %).',
    },
  },
});

export const ProductProduct = defineModel('product.product', {
  label: 'Product',
  archivable: true,
  order: ['name asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  tracking: ['listPrice', 'standardPrice'],
  fields: {
    name: f.char({ required: true, translate: true }),
    /** Numbered when created: P00001, P00002, ... */
    code: f.char({ readonly: true, sequence: 'product.product', index: 'unique' }),
    kind: f.selection({ goods: 'Goods', service: 'Service' }, { required: true, default: 'goods' }),
    category: f.many2one('product.category'),
    uom: f.many2one('uom.uom', { label: 'Unit of measure' }),
    barcode: f.char({ index: 'unique' }),
    /** The sales price, in the company currency. */
    listPrice: f.decimal({ scale: 2, required: true, default: '0', label: 'Sales price' }),
    /** The cost: the default purchase price. */
    standardPrice: f.decimal({ scale: 2, required: true, default: '0', label: 'Cost' }),
    saleOk: f.boolean({ default: true, label: 'Can be sold' }),
    purchaseOk: f.boolean({ default: true, label: 'Can be purchased' }),
    /** The default tax on sales. */
    tax: f.many2one('account.tax', { label: 'Sales tax' }),
    /** The default tax on purchases. */
    purchaseTax: f.many2one('account.tax', { label: 'Purchase tax' }),
    description: f.text({ translate: true }),
  },
  constraints: {
    prices: {
      ...check('product.product', ['listPrice', 'standardPrice'], (products) =>
        products.filter((p) => p.listPrice.lt(0) || p.standardPrice.lt(0)),
      ),
      message: 'Prices cannot be negative.',
    },
  },
});

const uom = (id: string, name: string, category: string, ratio: string, rounding: string) =>
  record(
    'uom.uom',
    id,
    { name, category: category as 'unit', ratio, rounding },
    { noupdate: true },
  );
const tax = (id: string, name: string, use: 'sale' | 'purchase', rate: string) =>
  record('account.tax', id, { name, use, rate }, { noupdate: true });

export const productShutro = defineModule({
  name: 'product',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
    orm.defineGroup({ code: 'product.user', label: 'Products user', implies: ['base.user'] }),
    orm.defineGroup({
      code: 'product.manager',
      label: 'Products manager',
      implies: ['product.user'],
    }),
  ],
  sequences: [
    orm.defineSequence({ code: 'product.product', prefix: 'P', padding: 5, perCompany: false }),
  ],
  models: [UomUom, ProductCategory, AccountTax, ProductProduct],
  // Created once, then the users' to change (noupdate).
  data: [
    uom('uom_unit', 'Units', 'unit', '1', '1'),
    uom('uom_dozen', 'Dozens', 'unit', '12', '1'),
    uom('uom_hour', 'Hours', 'time', '1', '0.01'),
    uom('uom_day', 'Days', 'time', '8', '0.01'),
    uom('uom_kg', 'kg', 'weight', '1', '0.001'),
    uom('uom_gram', 'g', 'weight', '0.001', '1'),
    uom('uom_meter', 'm', 'length', '1', '0.01'),
    uom('uom_litre', 'L', 'volume', '1', '0.001'),
    record('product.category', 'category_all', { name: 'All' }, { noupdate: true }),
    // Bangladesh VAT (VAT and Supplementary Duty Act 2012): standard 15 %, reduced 10 %, 7.5 % and 5 %.
    tax('tax_sale_vat15', 'VAT 15%', 'sale', '0.15'),
    tax('tax_sale_vat10', 'VAT 10%', 'sale', '0.10'),
    tax('tax_sale_vat7_5', 'VAT 7.5%', 'sale', '0.075'),
    tax('tax_sale_vat5', 'VAT 5%', 'sale', '0.05'),
    tax('tax_sale_exempt', 'VAT exempt', 'sale', '0'),
    tax('tax_purchase_vat15', 'VAT 15% (purchases)', 'purchase', '0.15'),
    tax('tax_purchase_vat5', 'VAT 5% (purchases)', 'purchase', '0.05'),
    tax('tax_purchase_exempt', 'VAT exempt (purchases)', 'purchase', '0'),
  ],
});
