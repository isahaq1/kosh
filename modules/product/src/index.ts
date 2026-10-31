/**
 * @packageDocumentation
 * `@kosh/product` (RFC 0008): the Products app. Products and services with their prices and default taxes,
 * categories, units of measure and taxes. Sales and Purchase sell and buy them.
 */
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { base } from '@kosh/server';
import { storage } from '@kosh/storage';
import { action, form, kanban, list, search } from '@kosh/views';
import { productDemo } from './demo.js';
import { AccountTax, ProductCategory, ProductProduct, productShutro, UomUom } from './module.js';

export { AccountTax, ProductCategory, ProductProduct, productShutro, UomUom } from './module.js';
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
  app: {
    code: 'product',
    label: 'Products',
    icon: 'product',
    sequence: 30,
    category: 'Inventory',
    summary: 'Products and services, prices, units of measure and taxes',
  },
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
    'product.action_categories': action(ProductCategory, {
      label: 'Categories',
      views: ['list', 'form'],
    }),
    'product.action_uoms': action(UomUom, { label: 'Units of measure', views: ['list', 'form'] }),
    'product.action_taxes': action(AccountTax, { label: 'Taxes', views: ['list', 'form'] }),
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
    { id: 'product.config', parent: 'product.root', label: 'Configuration', sequence: 90 },
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
        k.notebook('more', [
          k.page('sales', 'Sales & purchase', [
            k.group('sell', ['saleOk', 'taxes']),
            k.group('buy', ['purchaseOk', 'purchaseTaxes']),
          ]),
          k.page('description_page', 'Description', ['description']),
        ]),
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
    'product.product': search(ProductProduct, {
      fields: ['name', 'code', 'barcode'],
      filters: {
        goods: { label: 'Goods', domain: { kind: 'goods' }, group: 'kind' },
        services: { label: 'Services', domain: { kind: 'service' }, group: 'kind' },
        sold: { label: 'Can be sold', domain: { saleOk: true }, group: 'use' },
        bought: { label: 'Can be purchased', domain: { purchaseOk: true }, group: 'use' },
      },
      groupBy: ['kind', 'category', 'uom'],
    }),
  },
});
