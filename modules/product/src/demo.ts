/** Demo data of Products (RFC 0008 §5.8): construction goods, electronics and services, with Bangladesh VAT. */

import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['product.manager'] } as const;

const CATEGORIES = ['Construction', 'Electronics', 'Services'] as const;

const PRODUCTS = [
  {
    name: 'Steel beam IPE 200',
    category: 'Construction',
    uom: 'Units',
    list: '85000',
    cost: '70000',
  },
  { name: 'Rebar 12 mm', category: 'Construction', uom: 'kg', list: '95', cost: '80' },
  { name: 'Cement bag 50 kg', category: 'Construction', uom: 'Units', list: '550', cost: '480' },
  { name: 'LED panel 40 W', category: 'Electronics', uom: 'Units', list: '2400', cost: '1800' },
  { name: 'Copper cable 2.5 mm²', category: 'Electronics', uom: 'm', list: '85', cost: '62' },
  {
    name: 'Diesel generator 250 kVA',
    category: 'Electronics',
    uom: 'Units',
    list: '1450000',
    cost: '1200000',
  },
  {
    name: 'Installation hours',
    category: 'Services',
    uom: 'Hours',
    list: '1500',
    cost: '900',
    kind: 'service',
  },
  {
    name: 'Site audit',
    category: 'Services',
    uom: 'Days',
    list: '25000',
    cost: '12000',
    kind: 'service',
  },
  {
    name: 'Consulting day',
    category: 'Services',
    uom: 'Days',
    list: '40000',
    cost: '20000',
    kind: 'service',
  },
] as const;

export async function productDemo(context: DemoContext): Promise<string> {
  return context.as(DINA, async (raw) => {
    const env = raw as Env;
    const categories = await env
      .model('product.category')
      .create(CATEGORIES.map((name) => ({ name })));
    const category = new Map(CATEGORIES.map((name, i) => [name, categories.ids[i] as number]));
    const vatSale = await idByName(env, 'account.tax', 'VAT 15%');
    const vatPurchase = await idByName(env, 'account.tax', 'VAT 15% (purchases)');
    const uoms = new Map<string, number>();
    for (const name of new Set(PRODUCTS.map((p) => p.uom)))
      uoms.set(name, await idByName(env, 'uom.uom', name));
    await env.model('product.product').create(
      PRODUCTS.map((p) => ({
        name: p.name,
        kind: ('kind' in p ? p.kind : 'goods') as 'goods' | 'service',
        category: orm.asId(category.get(p.category) as number, 'product.category'),
        uom: orm.asId(uoms.get(p.uom) as number, 'uom.uom'),
        listPrice: p.list,
        standardPrice: p.cost,
        tax: orm.asId(vatSale, 'account.tax'),
        purchaseTax: orm.asId(vatPurchase, 'account.tax'),
      })),
    );
    return `${CATEGORIES.length} categories and ${PRODUCTS.length} products`;
  });
}
