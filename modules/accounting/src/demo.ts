/**
 * Demo data of Accounting (RFC 0008 §5.8): the Bangladesh chart when none is installed, posted customer invoices
 * and vendor bills with VAT, one invoice paid in full and one in part, so the aging, the trial balance and the
 * reconciliation page have something to show.
 */

import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { installChart, installedChart } from './chart.js';
import { registerPayment } from './payments.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['account.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['account.user'] } as const;

type Line = { readonly product: string; readonly quantity: string; readonly price: string };
const INVOICES: readonly {
  readonly partner: string;
  readonly daysAgo: number;
  readonly ref: string;
  readonly lines: readonly Line[];
  readonly pay?: 'full' | 'half';
}[] = [
  {
    partner: 'Bengal Steel Ltd',
    daysAgo: 55,
    ref: 'BS-PO-2190',
    lines: [{ product: 'Steel beam IPE 200', quantity: '10', price: '85000' }],
    pay: 'half',
  },
  {
    partner: 'Acme Trading',
    daysAgo: 35,
    ref: 'Cement, March',
    lines: [{ product: 'Cement bag 50 kg', quantity: '300', price: '540' }],
    pay: 'full',
  },
  {
    partner: 'Meghna Electronics',
    daysAgo: 9,
    ref: 'Panels, hall B',
    lines: [
      { product: 'LED panel 40 W', quantity: '25', price: '2400' },
      { product: 'Installation hours', quantity: '8', price: '1500' },
    ],
  },
];
const BILLS: readonly { partner: string; daysAgo: number; ref: string; lines: readonly Line[] }[] =
  [
    {
      partner: 'Padma Cement',
      daysAgo: 28,
      ref: 'PC/2026/0417',
      lines: [{ product: 'Cement bag 50 kg', quantity: '150', price: '480' }],
    },
    {
      partner: 'Rajshahi Textiles',
      daysAgo: 6,
      ref: 'RT-1188',
      lines: [{ product: 'Copper cable 2.5 mm²', quantity: '500', price: '62' }],
    },
  ];

async function document(
  env: Env,
  context: DemoContext,
  kind: 'out_invoice' | 'in_invoice',
  journal: number,
  currency: number,
  doc: { partner: string; daysAgo: number; ref: string; lines: readonly Line[] },
): Promise<number> {
  const vat = await idByName(
    env,
    'account.tax',
    kind === 'out_invoice' ? 'VAT 15%' : 'VAT 15% (purchases)',
  );
  const lines = [];
  for (const l of doc.lines)
    lines.push({
      lineKind: 'product' as const,
      product: orm.asId(await idByName(env, 'product.product', l.product), 'product.product'),
      name: l.product,
      quantity: l.quantity,
      priceUnit: l.price,
      taxes: { set: [orm.asId(vat, 'account.tax')] },
    });
  const created = await env.model('account.move').create([
    {
      kind,
      journal: orm.asId(journal, 'account.journal'),
      partner: orm.asId(await idByName(env, 'res.partner', doc.partner), 'res.partner'),
      currency: orm.asId(currency, 'res.currency'),
      date: context.date(-doc.daysAgo),
      ref: doc.ref,
      lines: { create: lines },
    },
  ]);
  await env.model('account.move').browse(created.ids).post();
  return created.ids[0] as number;
}

export async function accountingDemo(context: DemoContext): Promise<string> {
  const chart = await context.system('chart of accounts', async (raw) => {
    const env = raw as Env;
    if ((await installedChart(env)) !== null) return 'the installed chart';
    await installChart(env, 'bd');
    return 'the Bangladesh chart';
  });
  const journal = async (env: Env, code: string): Promise<number> => {
    const found = await env.model('account.journal').search({ where: { code }, limit: 1 });
    const id = found.ids[0];
    if (id === undefined) throw new Error(`Demo data: no journal ${code}.`);
    return id;
  };
  const currencyOf = async (env: Env): Promise<number> => {
    const [company] = await env
      .model('res.company')
      .browse([env.companyRef])
      .load({ currency: true });
    if (company === undefined) throw new Error('Demo data: no company.');
    return company.currency.id;
  };
  await context.as(RAHIM, async (raw) => {
    const env = raw as Env;
    const inv = await journal(env, 'INV');
    const bank = await journal(env, 'BNK');
    const currency = await currencyOf(env);
    for (const doc of INVOICES) {
      const id = await document(env, context, 'out_invoice', inv, currency, doc);
      if (doc.pay === undefined) continue;
      const [move] = await env
        .model('account.move')
        .browse([orm.asId(id, 'account.move')])
        .load(['amountTotal']);
      const total = move?.amountTotal?.amount ?? orm.toDecimal(0);
      await registerPayment(env, {
        moves: [id],
        journal: bank,
        date: context.date(-doc.daysAgo + 12),
        amount: doc.pay === 'half' ? total.div(2).toFixed(2) : total.toFixed(2),
        memo: `${doc.ref} ${doc.pay === 'half' ? 'first half' : 'paid'}`,
      });
    }
  });
  await context.as(DINA, async (raw) => {
    const env = raw as Env;
    const bill = await journal(env, 'BILL');
    const currency = await currencyOf(env);
    for (const doc of BILLS) await document(env, context, 'in_invoice', bill, currency, doc);
  });
  return `${chart}, ${INVOICES.length} invoices (2 paid in full or in part) and ${BILLS.length} bills, posted`;
}
