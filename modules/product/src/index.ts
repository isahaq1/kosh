/**
 * @packageDocumentation
 * `@kosh/product` (RFC 0008): the Products app. Products and services with their prices and default taxes,
 * categories, units of measure and taxes. Sales and Purchase sell and buy them.
 */
import { defineModule } from '@kosh/modules-sdk';
import { base } from '@kosh/server';
import { action, form, kanban, list, search } from '@kosh/views';
import { productDemo } from './demo.js';
import { AccountTax, ProductCategory, ProductProduct, productShutro, UomUom } from './module.js';

export { AccountTax, ProductCategory, ProductProduct, productShutro, UomUom } from './module.js';

export const product: ReturnType<typeof defineModule> = defineModule({
  shutro: productShutro,
  kosh: '^0.1.0',
  hooks: { demo: productDemo },
  depends: [base],
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
      card: { title: 'name', subtitle: 'code', footer: ['listPrice', 'uom'] },
    }),
    'product.product.list': list(ProductProduct, {
      columns: ['code', 'name', 'kind', 'category', 'listPrice', 'standardPrice', 'uom'],
      defaultOrder: ['name asc'],
    }),
    'product.product.form': form(ProductProduct, (k) => ({
      sheet: [
        k.group('identity', ['name', 'code', 'kind', 'category', 'barcode']),
        k.group('prices', ['listPrice', 'standardPrice', 'uom'], { label: 'Prices' }),
        k.notebook('more', [
          k.page('sales', 'Sales & purchase', [
            k.group('sell', ['saleOk', 'tax']),
            k.group('buy', ['purchaseOk', 'purchaseTax']),
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
    'account.tax.list': list(AccountTax, { columns: ['name', 'use', 'rate'] }),
    'account.tax.form': form(AccountTax, (k) => ({
      sheet: [k.group('main', ['name', 'use', 'rate'])],
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
