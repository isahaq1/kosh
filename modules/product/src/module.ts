/**
 * The data layer of Products (Shutro): units of measure (what Shutro's `quantity` fields are counted in), product
 * categories, taxes and products. Taxes live here rather than in Accounting, so Sales and Purchase work without the
 * Accounting app; Accounting extends them with their accounts. A country's taxes come with its localization (l10n_bd).
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { storageShutro } from '@kosh/storage';
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
  order: ['use asc', 'sequence asc', 'rate desc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    use: f.selection({ sale: 'Sales', purchase: 'Purchases' }, { required: true, default: 'sale' }),
    /** The order a line's taxes apply in (lower first): supplementary duty before VAT. */
    sequence: f.integer({ required: true, default: 10 }),
    amountType: f.selection(
      { percent: 'Percentage of the base', fixed: 'Fixed amount per unit' },
      { required: true, default: 'percent', label: 'Computed as' },
    ),
    /** 0.15 for 15 % (percentage taxes). */
    rate: f.decimal({ scale: 4, required: true, default: '0' }),
    /** Per unit, in the document's currency (fixed taxes). */
    fixedAmount: f.decimal({ scale: 4, required: true, default: '0', label: 'Amount per unit' }),
    /** Its amount is added to the base of the taxes after it (supplementary duty, then VAT on price + SD). */
    affectsBase: f.boolean({
      required: true,
      default: false,
      label: 'Affects the base of later taxes',
    }),
    /** Included in the unit price (the price is gross). */
    priceIncluded: f.boolean({ required: true, default: false, label: 'Included in price' }),
    /** Reverse charge (RFC 0016 step 5): the buyer pays the tax to the state; not in the document's total. */
    reverseCharge: f.boolean({ required: true, default: false, label: 'Reverse charge' }),
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
    /** A picture: an attachment of the product (RFC 0022 §3.3), with its 256 px thumbnail. */
    image: f.many2one('storage.attachment', { ondelete: 'set null', label: 'Picture' }),
    /** The sales price, in the company currency. */
    listPrice: f.decimal({ scale: 2, required: true, default: '0', label: 'Sales price' }),
    /** The cost: the default purchase price. */
    standardPrice: f.decimal({ scale: 2, required: true, default: '0', label: 'Cost' }),
    saleOk: f.boolean({ default: true, label: 'Can be sold' }),
    purchaseOk: f.boolean({ default: true, label: 'Can be purchased' }),
    /** The taxes on sales, in order (RFC 0016). */
    taxes: f.many2many('account.tax', { relation: 'product_sale_tax_rel', label: 'Sales taxes' }),
    /** The taxes on purchases, in order. */
    purchaseTaxes: f.many2many('account.tax', {
      relation: 'product_purchase_tax_rel',
      label: 'Purchase taxes',
    }),
    /** Before 0.2.0, one tax each: copied into `taxes` / `purchaseTaxes` by the migration; dropped later. */
    tax: f.many2one('account.tax', { label: 'Sales tax (before 0.2.0)', readonly: true }),
    purchaseTax: f.many2one('account.tax', {
      label: 'Purchase tax (before 0.2.0)',
      readonly: true,
    }),
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

export const productShutro = defineModule({
  name: 'product',
  version: '0.3.0',
  migrations: [
    {
      version: '0.2.0',
      description:
        'Several taxes per product: the single sales and purchase taxes become the first of each list',
      up: async (ctx) => {
        await ctx.sql`INSERT INTO product_sale_tax_rel (product_product_id, account_tax_id)
          SELECT id, tax_id FROM product_product WHERE tax_id IS NOT NULL ON CONFLICT DO NOTHING`;
        await ctx.sql`INSERT INTO product_purchase_tax_rel (product_product_id, account_tax_id)
          SELECT id, purchase_tax_id FROM product_product WHERE purchase_tax_id IS NOT NULL ON CONFLICT DO NOTHING`;
        // The Bangladeshi taxes move to the Bangladesh localization (RFC 0016): their records stay, and l10n_bd
        // finds them as its own when installed (no duplicates, nothing deleted here).
        await ctx.sql`UPDATE shutro_external_id SET module = 'l10n_bd'
          WHERE module = 'product' AND model = 'account.tax'`;
      },
    },
  ],
  depends: [baseShutro, storageShutro],
  groups: [
    orm.defineGroup({
      code: 'product.user',
      label: 'Products user',
      implies: ['base.user', 'storage.user'],
    }),
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
  ],
});
