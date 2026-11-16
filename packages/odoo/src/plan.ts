/**
 * What is taken from Odoo, and how each record becomes a Kosh record (RFC 0034 §2.3, step 3 part 1): units, product
 * categories, taxes, the chart of accounts, contacts and products — in that order, each relation pointing at a record
 * imported before it.
 *
 * Each step reads only the Odoo fields that exist in the connected version (16 to 18), so one plan serves them all.
 * Where Kosh already has the record — a seeded unit, the "All" category, an account of the installed chart with the
 * same code, a tax with the same name, use and rate — the Odoo record is **linked** to it instead of duplicated, and
 * Kosh's values are kept.
 */
import type { OdooField, OdooRecord, OdooValue } from './rpc.js';
import { idOf, idsOf, textOf } from './rpc.js';

/** What a step's functions can see: Odoo records already imported, and lookups read before the run. */
export interface StepContext {
  /** The Kosh id of the Odoo record `id` of `model`, once imported or linked. */
  ref(model: string, id: number | null): number | null;
  /** Kosh ids of the Odoo records `ids` of `model` that were imported. */
  refs(model: string, ids: readonly number[]): number[];
  /** Odoo's external id of a record (`uom.product_uom_unit`), when it has one. */
  odooXmlId(model: string, id: number): string | undefined;
  /** ISO codes of Odoo's countries and states, by id. */
  readonly countries: ReadonlyMap<number, string>;
  readonly states: ReadonlyMap<number, string>;
  /** Partners that are Odoo's users or companies themselves: not contacts to import. */
  readonly internalPartners: ReadonlySet<number>;
}

/** Finding a Kosh record by field values (the step's `link`). */
export type Find = (
  model: string,
  where: Readonly<Record<string, unknown>>,
) => Promise<number | null>;
/** A Kosh record by external id, or null. */
export type RefId = (model: string, externalId: string) => Promise<number | null>;

export interface Step {
  /** The step's name in the report and on the command line (`partners`). */
  readonly key: string;
  readonly odoo: string;
  readonly kosh: string;
  /** Kosh models that must be installed (the step is left out otherwise, and the report says why). */
  readonly needs: readonly string[];
  /** The Odoo fields wanted; those missing in the connected version are not read. */
  readonly read: readonly string[];
  /** Why an Odoo record is not imported (counted in the report), or null. */
  skip?(record: OdooRecord, ctx: StepContext): string | null;
  /** The Kosh values of an Odoo record. Relations to records not imported are left out. */
  values(record: OdooRecord, ctx: StepContext): Record<string, unknown>;
  /** Values given only when the record is created (a code from a sequence, which Kosh never rewrites). */
  readonly createOnly?: readonly string[];
  /** A Kosh record that already is this one: linked, its values kept. */
  link?(
    record: OdooRecord,
    values: Record<string, unknown>,
    ctx: StepContext,
    find: Find,
    refId: RefId,
  ): Promise<number | null>;
  /** Values written in a second pass, once every record of the step exists (a parent of the same model). */
  later?(record: OdooRecord, ctx: StepContext): Record<string, unknown>;
}

// ---- helpers

/** An Odoo float as an exact decimal string with `scale` places (Odoo stores floats; Kosh decimals). */
export const decimal = (value: OdooValue | undefined, scale: number): string => {
  const n = typeof value === 'number' ? value : 0;
  return (Math.round(n * 10 ** scale) / 10 ** scale).toFixed(scale);
};
/** Odoo's HTML (notes, descriptions) as plain text. */
export const plain = (value: OdooValue | undefined): string =>
  textOf(value)
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
const orNull = (text: string): string | null => (text === '' ? null : text);
/** Only the keys whose value is defined. */
const defined = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));

// ---- units

/** Odoo's own units, by external id, to the units Kosh seeds. */
const UNITS: Readonly<Record<string, string>> = {
  'uom.product_uom_unit': 'product.uom_unit',
  'uom.product_uom_dozen': 'product.uom_dozen',
  'uom.product_uom_hour': 'product.uom_hour',
  'uom.product_uom_day': 'product.uom_day',
  'uom.product_uom_kgm': 'product.uom_kg',
  'uom.product_uom_gram': 'product.uom_gram',
  'uom.product_uom_meter': 'product.uom_meter',
  'uom.product_uom_litre': 'product.uom_litre',
};
/** Odoo's unit categories, by name, to Kosh's kinds of quantity. */
const unitKind = (category: string): string | null => {
  const c = category.toLowerCase();
  if (c.startsWith('unit')) return 'unit';
  if (c.includes('time')) return 'time';
  if (c.startsWith('weight')) return 'weight';
  if (c.startsWith('length')) return 'length';
  if (c.startsWith('volume')) return 'volume';
  return null;
};

const units: Step = {
  key: 'units',
  odoo: 'uom.uom',
  kosh: 'uom.uom',
  needs: ['uom.uom'],
  read: ['name', 'category_id', 'factor', 'factor_inv', 'rounding', 'active'],
  skip(r, ctx) {
    const xmlId = ctx.odooXmlId('uom.uom', r.id);
    if (xmlId !== undefined && UNITS[xmlId] !== undefined) return null;
    const category = Array.isArray(r['category_id'])
      ? textOf(r['category_id'][1] as OdooValue)
      : '';
    return unitKind(category) === null
      ? `a unit of ${category || 'another kind'}, which Kosh does not measure`
      : null;
  },
  values(r) {
    const category = Array.isArray(r['category_id'])
      ? textOf(r['category_id'][1] as OdooValue)
      : '';
    // Odoo's factor is how many of this unit make the reference unit; Kosh's ratio the inverse.
    const inverse =
      typeof r['factor_inv'] === 'number' ? r['factor_inv'] : 1 / (Number(r['factor']) || 1);
    return {
      name: textOf(r['name']),
      category: unitKind(category) ?? 'unit',
      ratio: decimal(inverse, 6),
      rounding: decimal(r['rounding'], 6),
      active: r['active'] !== false,
    };
  },
  async link(r, values, ctx, find, refId) {
    const xmlId = ctx.odooXmlId('uom.uom', r.id);
    const seeded = xmlId === undefined ? undefined : UNITS[xmlId];
    if (seeded !== undefined) return refId('uom.uom', seeded);
    return find('uom.uom', { name: values['name'], category: values['category'] });
  },
};

// ---- product categories

const categories: Step = {
  key: 'categories',
  odoo: 'product.category',
  kosh: 'product.category',
  needs: ['product.category'],
  read: ['name', 'parent_id'],
  values: (r) => ({ name: textOf(r['name']) }),
  async link(r, values, ctx, find, refId) {
    if (ctx.odooXmlId('product.category', r.id) === 'product.product_category_all')
      return refId('product.category', 'product.category_all');
    return idOf(r['parent_id']) === null
      ? find('product.category', { name: values['name'], parent: null })
      : null;
  },
  later: (r, ctx) =>
    defined({ parent: ctx.ref('product.category', idOf(r['parent_id'])) ?? undefined }),
};

// ---- taxes

const taxes: Step = {
  key: 'taxes',
  odoo: 'account.tax',
  kosh: 'account.tax',
  needs: ['account.tax'],
  read: [
    'name',
    'type_tax_use',
    'amount_type',
    'amount',
    'price_include',
    'include_base_amount',
    'sequence',
    'active',
  ],
  skip(r) {
    if (r['type_tax_use'] !== 'sale' && r['type_tax_use'] !== 'purchase')
      return 'not used on sales or purchases (a part of a group of taxes)';
    if (r['amount_type'] !== 'percent' && r['amount_type'] !== 'fixed')
      return `computed as ${textOf(r['amount_type'])}, which Kosh computes with several taxes per line instead`;
    return null;
  },
  values(r) {
    const percent = r['amount_type'] === 'percent';
    return {
      name: textOf(r['name']),
      use: r['type_tax_use'],
      amountType: percent ? 'percent' : 'fixed',
      // Odoo says 15 for 15 %; Kosh keeps the fraction, 0.15.
      rate: percent
        ? decimal((typeof r['amount'] === 'number' ? r['amount'] : 0) / 100, 4)
        : '0.0000',
      fixedAmount: percent ? '0.0000' : decimal(r['amount'], 4),
      priceIncluded: r['price_include'] === true,
      affectsBase: r['include_base_amount'] === true,
      sequence: typeof r['sequence'] === 'number' ? r['sequence'] : 10,
      active: r['active'] !== false,
    };
  },
  link: (_r, values, _ctx, find) =>
    find('account.tax', {
      name: values['name'],
      use: values['use'],
      amountType: values['amountType'],
      rate: values['rate'],
    }),
};

// ---- the chart of accounts

/** Odoo's account types (16+) are Kosh's, but for the credit card one. */
const accountType = (value: OdooValue | undefined): string =>
  value === 'liability_credit_card' ? 'liability_current' : textOf(value);

const accounts: Step = {
  key: 'accounts',
  odoo: 'account.account',
  kosh: 'account.account',
  needs: ['account.account'],
  read: ['code', 'name', 'account_type', 'reconcile', 'deprecated'],
  skip: (r) => (textOf(r['code']) === '' ? 'no code in this company' : null),
  values: (r) => ({
    code: textOf(r['code']),
    name: textOf(r['name']),
    type: accountType(r['account_type']),
    reconcile: r['reconcile'] === true,
  }),
  link: (_r, values, _ctx, find) => find('account.account', { code: values['code'] }),
};

// ---- contacts

const LANGS: Readonly<Record<string, string>> = { en_US: 'en', en_GB: 'en', bn_BD: 'bn' };

const partners: Step = {
  key: 'partners',
  odoo: 'res.partner',
  kosh: 'res.partner',
  needs: ['res.partner'],
  read: [
    'name',
    'is_company',
    'parent_id',
    'email',
    'phone',
    'mobile',
    'website',
    'street',
    'street2',
    'city',
    'zip',
    'country_id',
    'state_id',
    'vat',
    'lang',
    'comment',
    'customer_rank',
    'supplier_rank',
    'property_account_receivable_id',
    'property_account_payable_id',
    'active',
    'type',
  ],
  skip(r, ctx) {
    if (ctx.internalPartners.has(r.id)) return 'a user or a company of Odoo itself';
    if (textOf(r['name']) === '' && idOf(r['parent_id']) !== null)
      return 'an address of a contact, without a name';
    return null;
  },
  values(r, ctx) {
    const street = [textOf(r['street']), textOf(r['street2'])].filter((s) => s !== '').join(', ');
    const country = ctx.countries.get(idOf(r['country_id']) ?? 0);
    const state = ctx.states.get(idOf(r['state_id']) ?? 0);
    return defined({
      name: textOf(r['name']),
      isCompany: r['is_company'] === true,
      email: orNull(textOf(r['email'])),
      phone: orNull(textOf(r['phone'])),
      mobile: r['mobile'] === undefined ? undefined : orNull(textOf(r['mobile'])),
      website: orNull(textOf(r['website'])),
      street: orNull(street),
      city: orNull(textOf(r['city'])),
      zip: orNull(textOf(r['zip'])),
      country: country ?? null,
      state: state !== undefined && state.length <= 6 ? state : null,
      taxId: orNull(textOf(r['vat'])),
      lang: LANGS[textOf(r['lang'])] ?? null,
      notes: orNull(plain(r['comment'])),
      isCustomer: typeof r['customer_rank'] === 'number' ? r['customer_rank'] > 0 : undefined,
      isVendor: typeof r['supplier_rank'] === 'number' ? r['supplier_rank'] > 0 : undefined,
      active: r['active'] !== false,
      // Its documents post to the same receivable and payable accounts as in Odoo (Accounting's fields).
      receivableAccount:
        ctx.ref('account.account', idOf(r['property_account_receivable_id'])) ?? undefined,
      payableAccount:
        ctx.ref('account.account', idOf(r['property_account_payable_id'])) ?? undefined,
    });
  },
  later: (r, ctx) => defined({ parent: ctx.ref('res.partner', idOf(r['parent_id'])) ?? undefined }),
};

// ---- products

const products: Step = {
  key: 'products',
  odoo: 'product.product',
  kosh: 'product.product',
  needs: ['product.product'],
  read: [
    'name',
    'display_name',
    'default_code',
    'type',
    'detailed_type',
    'categ_id',
    'uom_id',
    'barcode',
    'weight',
    'volume',
    'lst_price',
    'standard_price',
    'sale_ok',
    'purchase_ok',
    'taxes_id',
    'supplier_taxes_id',
    'description_sale',
    'active',
    'product_template_variant_value_ids',
  ],
  createOnly: ['code'],
  skip: (r) =>
    r['type'] === 'combo'
      ? 'a combo, which Kosh sells as a quotation template with optional products'
      : null,
  values(r, ctx) {
    const code = textOf(r['default_code']);
    const variant = idsOf(r['product_template_variant_value_ids']).length > 0;
    // A variant keeps the attribute values Odoo shows after the name ("Desk (Steel, Black)").
    const shown = textOf(r['display_name']).replace(/^\[[^\]]*\]\s*/, '');
    const service = r['type'] === 'service' || r['detailed_type'] === 'service';
    return defined({
      name: variant && shown !== '' ? shown : textOf(r['name']),
      code: orNull(code) ?? undefined,
      kind: service ? 'service' : 'goods',
      category: ctx.ref('product.category', idOf(r['categ_id'])) ?? undefined,
      uom: ctx.ref('uom.uom', idOf(r['uom_id'])) ?? undefined,
      barcode: orNull(textOf(r['barcode'])),
      weight: decimal(r['weight'], 3),
      volume: decimal(r['volume'], 4),
      listPrice: decimal(r['lst_price'], 2),
      standardPrice: decimal(r['standard_price'], 2),
      saleOk: r['sale_ok'] !== false,
      purchaseOk: r['purchase_ok'] !== false,
      taxes: { set: ctx.refs('account.tax', idsOf(r['taxes_id'])) },
      purchaseTaxes: { set: ctx.refs('account.tax', idsOf(r['supplier_taxes_id'])) },
      description: orNull(plain(r['description_sale'])),
      active: r['active'] !== false,
    });
  },
};

/** The steps, in the order they run: every relation points at a step before it. */
export const STEPS: readonly Step[] = [units, categories, taxes, accounts, partners, products];

/** The fields of `step` that the connected Odoo has. */
export const readableFields = (step: Step, fields: Readonly<Record<string, OdooField>>): string[] =>
  step.read.filter((f) => fields[f] !== undefined);

/** The external id Kosh gives an imported Odoo record: `odoo.res_partner_42`. */
export const externalIdFor = (odooModel: string, id: number): string =>
  `odoo.${odooModel.replaceAll('.', '_')}_${id}`;
