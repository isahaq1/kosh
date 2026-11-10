/**
 * @packageDocumentation
 * `@kosh/product` (RFC 0008): the Products app. Products and services with their prices and default taxes,
 * categories, units of measure and taxes. Sales and Purchase sell and buy them.
 */
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { base, type ModuleContext } from '@kosh/server';
import { storage } from '@kosh/storage';
import { action, form, kanban, list, search } from '@kosh/views';
import { productDemo } from './demo.js';
import { registerGridRoutes } from './grid.js';
import { AccountTax, ProductCategory, ProductProduct, productShutro, UomUom } from './module.js';
import { ProductPricelist } from './pricelist.js';
import { ProductAttribute, ProductTemplate } from './variants.js';

export { type Grid, type GridVariant, registerGridRoutes, templateGrid } from './grid.js';
export { AccountTax, ProductCategory, ProductProduct, productShutro, UomUom } from './module.js';
export { type PriceFound, ProductPricelist, ProductPricelistRule, priceFor } from './pricelist.js';
export {
  computeTaxes,
  ordered,
  type TaxLine,
  type TaxResult,
  type TaxRule,
  taxRule,
} from './taxes.js';
export const product: ReturnType<typeof defineModule> = defineModule({
  shutro: productShutro,
  kosh: '^0.1.0',
  hooks: { demo: productDemo },
  depends: [base, storage, reporting],
  // The variant grid of a template (RFC 0030 §3.4), read by the order forms.
  routes: (context: ModuleContext) => registerGridRoutes(context),
  events: [
    { topic: 'product.template.generated', model: 'product.template', label: 'Variants generated' },
  ],
  documents: [
    {
      key: 'product_template',
      name: 'Product template',
      model: 'product.template',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'about',
            items: [
              { label: 'Kind', bind: 'kind' },
              { label: 'Category', bind: 'category.name' },
              { label: 'Sales price', bind: 'listPrice' },
              { label: 'Variants', bind: 'variantCount' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [{ label: 'Attribute', bind: 'attribute.name' }],
          },
          {
            kind: 'table',
            id: 'variants',
            bind: 'variants',
            columns: [
              { label: 'Variant', bind: 'name' },
              { label: 'Code', bind: 'code' },
              { label: 'Barcode', bind: 'barcode' },
              { label: 'Sales price', bind: 'listPrice' },
            ],
          },
          { kind: 'text', id: 'description', text: '{{description}}' },
        ],
      },
    },
  ],
  app: {
    code: 'product',
    label: 'Products',
    icon: 'product',
    sequence: 30,
    category: 'Inventory',
    summary: 'Products and services, prices, units of measure and taxes',
  },
  importTemplates: [
    {
      key: 'product_attribute',
      model: 'product.attribute',
      label: 'Attributes',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Display', field: 'display' },
        { header: 'Values › Name', field: 'values.name' },
        { header: 'Values › Colour', field: 'values.color' },
        { header: 'Values › Extra price', field: 'values.extraPrice' },
      ],
    },
    {
      key: 'product_template',
      model: 'product.template',
      label: 'Product templates',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Kind', field: 'kind' },
        { header: 'Category', field: 'category' },
        { header: 'Unit of measure', field: 'uom' },
        { header: 'Sales price', field: 'listPrice' },
        { header: 'Cost', field: 'standardPrice' },
        { header: 'Attributes › Attribute', field: 'lines.attribute' },
      ],
    },
    {
      key: 'product_pricelist',
      model: 'product.pricelist',
      label: 'Price list',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Currency', field: 'currency' },
        { header: 'Sequence', field: 'sequence' },
      ],
    },
    {
      key: 'uom_uom',
      model: 'uom.uom',
      label: 'Unit of measure',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Category', field: 'category' },
        { header: 'Ratio', field: 'ratio' },
        { header: 'Rounding', field: 'rounding' },
      ],
    },
    {
      key: 'product_category',
      model: 'product.category',
      label: 'Product category',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Parent', field: 'parent' },
      ],
    },
    {
      key: 'account_tax',
      model: 'account.tax',
      label: 'Tax',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Use', field: 'use' },
        { header: 'Computed as', field: 'amountType' },
        { header: 'Rate', field: 'rate' },
        { header: 'Amount per unit', field: 'fixedAmount' },
        { header: 'Affects the base of later taxes', field: 'affectsBase' },
        { header: 'Included in price', field: 'priceIncluded' },
        { header: 'Reverse charge', field: 'reverseCharge' },
      ],
    },
    {
      key: 'product_product',
      model: 'product.product',
      label: 'Product',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Kind', field: 'kind' },
        { header: 'Category', field: 'category' },
        { header: 'Unit of measure', field: 'uom' },
        { header: 'Barcode', field: 'barcode' },
        { header: 'Sales price', field: 'listPrice' },
        { header: 'Cost', field: 'standardPrice' },
        { header: 'Can be sold', field: 'saleOk' },
        { header: 'Can be purchased', field: 'purchaseOk' },
        { header: 'Sales taxes', field: 'taxes' },
        { header: 'Purchase taxes', field: 'purchaseTaxes' },
        { header: 'Description', field: 'description' },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User', groups: ['product.user'] },
    manager: { label: 'Manager', groups: ['product.manager'], implies: ['user'] },
  },
  // The Overview (RFC 0022 step 2): the catalogue at a glance.
  overview: {
    cards: [
      {
        id: 'products_all',
        title: 'Products',
        kind: 'kpi',
        model: 'product.product',
        measure: 'count',
        w: 3,
      },
      {
        id: 'goods',
        title: 'Goods',
        kind: 'kpi',
        model: 'product.product',
        measure: 'count',
        filter: { kind: 'goods' },
        w: 3,
      },
      {
        id: 'services',
        title: 'Services',
        kind: 'kpi',
        model: 'product.product',
        measure: 'count',
        filter: { kind: 'service' },
        w: 3,
      },
      {
        id: 'average_price',
        title: 'Average sales price',
        kind: 'kpi',
        model: 'product.product',
        measure: 'avg:listPrice',
        w: 3,
      },
      {
        id: 'by_category',
        title: 'By category',
        kind: 'chart',
        model: 'product.product',
        measure: 'count',
        groupBy: 'category',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'priciest',
        title: 'Highest sales prices',
        kind: 'list',
        model: 'product.product',
        measure: 'sum:listPrice',
        w: 6,
      },
    ],
  },
  actions: {
    'product.action_products': action(ProductProduct, {
      label: 'Products',
      views: ['kanban', 'list', 'form'],
    }),
    'product.action_templates': action(ProductTemplate, {
      label: 'Product templates',
      views: ['list', 'kanban', 'form'],
    }),
    'product.action_attributes': action(ProductAttribute, {
      label: 'Attributes',
      views: ['list', 'form'],
    }),
    'product.action_categories': action(ProductCategory, {
      label: 'Categories',
      views: ['list', 'form'],
    }),
    'product.action_uoms': action(UomUom, { label: 'Units of measure', views: ['list', 'form'] }),
    'product.action_taxes': action(AccountTax, { label: 'Taxes', views: ['list', 'form'] }),
    'product.action_pricelists': action(ProductPricelist, {
      label: 'Price lists',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'product.root', label: 'Products', app: 'product' },
    {
      id: 'product.products',
      parent: 'product.root',
      label: 'Products',
      action: 'product.action_products',
      sequence: 1,
    },
    {
      id: 'product.templates',
      parent: 'product.root',
      label: 'Product templates',
      action: 'product.action_templates',
      sequence: 2,
    },
    { id: 'product.config', parent: 'product.root', label: 'Configuration', sequence: 90 },
    {
      id: 'product.attributes',
      parent: 'product.config',
      label: 'Attributes',
      action: 'product.action_attributes',
    },
    {
      id: 'product.pricelists',
      parent: 'product.root',
      label: 'Price lists',
      action: 'product.action_pricelists',
      sequence: 2,
    },
    {
      id: 'product.categories',
      parent: 'product.config',
      label: 'Categories',
      action: 'product.action_categories',
    },
    {
      id: 'product.uoms',
      parent: 'product.config',
      label: 'Units of measure',
      action: 'product.action_uoms',
    },
    {
      id: 'product.taxes',
      parent: 'product.config',
      label: 'Taxes',
      action: 'product.action_taxes',
    },
  ],
  views: {
    'product.product.kanban': kanban(ProductProduct, {
      groupBy: 'kind',
      card: { title: 'name', subtitle: 'code', footer: ['listPrice', 'uom'], image: 'image' },
    }),
    'product.product.list': list(ProductProduct, {
      columns: [
        { field: 'image', widget: 'avatar' },
        'code',
        'name',
        'kind',
        'category',
        'listPrice',
        'standardPrice',
        'uom',
      ],
      defaultOrder: ['name asc'],
    }),
    'product.product.form': form(ProductProduct, (k) => ({
      sheet: [
        // Sold, bought, on hand: Sales, Purchase and Stockroom append their tiles (RFC 0022 §3.1).
        k.stats('related', []),
        k.group('identity', [
          { field: 'image', widget: 'image' },
          'name',
          'code',
          'kind',
          'category',
          'barcode',
        ]),
        k.group('prices', ['listPrice', 'standardPrice', 'uom'], { label: 'Prices' }),
        k.group(
          'variant',
          ['template', { field: 'attributeValues', widget: 'tags' }, 'followsTemplatePrice'],
          { label: 'Variant' },
        ),
        k.group('size', ['weight', 'volume'], { label: 'Size' }),
        k.notebook('more', [
          k.page('sales', 'Sales & purchase', [
            k.group('sell', ['saleOk', 'invoicePolicy', 'taxes']),
            k.group('buy', ['purchaseOk', 'purchaseTaxes']),
          ]),
          k.page('description_page', 'Description', ['description']),
        ]),
      ],
    })),
    'product.template.list': list(ProductTemplate, {
      columns: ['name', 'kind', 'category', 'listPrice', 'variantCount', 'state'],
    }),
    'product.template.kanban': kanban(ProductTemplate, {
      groupBy: 'category',
      card: { title: 'name', subtitle: 'kind', footer: ['listPrice', 'variantCount'] },
    }),
    'product.template.form': form(ProductTemplate, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('generate', {
            primary: true,
            label: 'Generate variants',
            confirm:
              'Generate? A product per combination offered; combinations no longer offered are archived.',
          }),
        ],
      },
      sheet: [
        k.stats('related', [
          {
            id: 'template_variants',
            label: 'Variants',
            model: ProductProduct,
            where: { template: { $record: 'id' } },
            action: 'product.action_products',
          },
        ]),
        k.group('identity', [
          { field: 'image', widget: 'image' },
          'name',
          'kind',
          'category',
          'uom',
        ]),
        k.group('prices', ['listPrice', 'standardPrice', 'variantCount'], { label: 'Prices' }),
        k.lines('lines', [
          { field: 'sequence', id: 'template_line_sequence' },
          { field: 'attribute', id: 'template_line_attribute' },
          { field: 'values', id: 'template_line_values', widget: 'tags' },
        ]),
        k.lines('exclusions', [
          { field: 'values', id: 'template_exclusion_values', widget: 'tags' },
          { field: 'note', id: 'template_exclusion_note' },
        ]),
        k.notebook('more', [
          k.page('sales', 'Sales & purchase', [
            k.group('sell', ['saleOk', 'taxes']),
            k.group('buy', ['purchaseOk', 'purchaseTaxes']),
          ]),
          k.page('description_page', 'Description', ['description']),
        ]),
      ],
      chatter: true,
    })),
    'product.attribute.list': list(ProductAttribute, { columns: ['sequence', 'name', 'display'] }),
    'product.attribute.form': form(ProductAttribute, (k) => ({
      sheet: [
        k.group('main', ['name', 'display', 'sequence']),
        k.lines('values', [
          { field: 'sequence', id: 'attribute_value_sequence' },
          { field: 'name', id: 'attribute_value_name' },
          { field: 'color', id: 'attribute_value_color', widget: 'color' },
          { field: 'extraPrice', id: 'attribute_value_extra' },
        ]),
      ],
    })),
    'product.pricelist.list': list(ProductPricelist, {
      columns: ['sequence', 'name', 'currency', 'company', 'active'],
    }),
    'product.pricelist.form': form(ProductPricelist, (k) => ({
      sheet: [
        k.group('main', ['name', 'currency', 'company', 'sequence'], {
          description:
            'Each line gets the most specific rule: a product’s over a category’s over every product, then the highest quantity reached. Without a rule, the list price.',
        }),
        k.lines('rules', [
          { field: 'sequence', id: 'rule_sequence' },
          { field: 'appliesTo', id: 'rule_applies' },
          { field: 'product', id: 'rule_product' },
          { field: 'category', id: 'rule_category' },
          { field: 'minQuantity', id: 'rule_quantity' },
          { field: 'dateFrom', id: 'rule_from' },
          { field: 'dateTo', id: 'rule_to' },
          { field: 'compute', id: 'rule_compute' },
          { field: 'fixedPrice', id: 'rule_fixed' },
          { field: 'base', id: 'rule_base' },
          { field: 'basePricelist', id: 'rule_base_list' },
          { field: 'discount', id: 'rule_discount' },
          { field: 'surcharge', id: 'rule_surcharge' },
          { field: 'rounding', id: 'rule_rounding' },
          { field: 'minMargin', id: 'rule_min_margin' },
          { field: 'maxMargin', id: 'rule_max_margin' },
        ]),
        k.group('notes', ['note'], { label: 'Note' }),
      ],
    })),
    'product.category.list': list(ProductCategory, { columns: ['name', 'parent'] }),
    'product.category.form': form(ProductCategory, (k) => ({
      sheet: [k.group('main', ['name', 'parent'])],
    })),
    'uom.uom.list': list(UomUom, { columns: ['name', 'category', 'ratio', 'rounding'] }),
    'uom.uom.form': form(UomUom, (k) => ({
      sheet: [k.group('main', ['name', 'category', 'ratio', 'rounding'])],
    })),
    'account.tax.list': list(AccountTax, {
      columns: ['sequence', 'name', 'use', 'amountType', 'rate', 'affectsBase'],
    }),
    'account.tax.form': form(AccountTax, (k) => ({
      sheet: [
        k.group('main', ['name', 'use', 'sequence']),
        k.group('amount', [
          'amountType',
          'rate',
          'fixedAmount',
          'affectsBase',
          'priceIncluded',
          'reverseCharge',
        ]),
      ],
    })),
  },
  search: {
    'product.template': search(ProductTemplate, {
      fields: ['name'],
      filters: {
        draft: { label: 'Not generated yet', domain: { state: 'draft' }, group: 'state' },
        ready: { label: 'Generated', domain: { state: 'ready' }, group: 'state' },
      },
      groupBy: ['category', 'kind', 'state'],
    }),
    'product.attribute': search(ProductAttribute, { fields: ['name', 'values.name'] }),
    'product.pricelist': search(ProductPricelist, {
      fields: ['name'],
      groupBy: ['currency', 'company'],
    }),
    'uom.uom': search(UomUom, { fields: ['name'], groupBy: ['category'] }),
    'product.category': search(ProductCategory, {
      fields: ['name', 'parent.name'],
      groupBy: ['parent'],
    }),
    'account.tax': search(AccountTax, {
      fields: ['name'],
      filters: {
        sale: { label: 'On sales', domain: { use: 'sale' }, group: 'use' },
        purchase: { label: 'On purchases', domain: { use: 'purchase' }, group: 'use' },
      },
      groupBy: ['use', 'amountType'],
    }),
    'product.product': search(ProductProduct, {
      fields: ['name', 'code', 'barcode'],
      filters: {
        goods: { label: 'Goods', domain: { kind: 'goods' }, group: 'kind' },
        services: { label: 'Services', domain: { kind: 'service' }, group: 'kind' },
        sold: { label: 'Can be sold', domain: { saleOk: true }, group: 'use' },
        bought: { label: 'Can be purchased', domain: { purchaseOk: true }, group: 'use' },
      },
      groupBy: ['kind', 'category', 'uom', 'template'],
    }),
  },
});
