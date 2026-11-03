/**
 * Fixed assets' demo data (RFC 0008 §5.8): three categories — office equipment, computers, vehicles — with the tax
 * book's rates (Bangladesh's Third Schedule as last known: verify), a set of laptops bought fourteen months ago and
 * a delivery van on declining balance, both confirmed with their months so far posted.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import { postDue } from './books.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['account.manager'] } as const;

export async function assetDemo(ctx: DemoContext): Promise<string> {
  return ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const byCode = async (code: string) =>
      (await env.model('account.account').search({ where: { code }, limit: 1 })).ids[0];
    const [asset, accumulated, expense] = [
      await byCode('1500'),
      await byCode('1590'),
      await byCode('6600'),
    ];
    const journal = (
      await env.model('account.journal').search({ where: { type: 'general' }, limit: 1 })
    ).ids[0];
    if (
      asset === undefined ||
      accumulated === undefined ||
      expense === undefined ||
      journal === undefined
    )
      return 'Fixed assets: no chart of accounts, nothing made.';
    const accounts = {
      assetAccount: asset,
      accumulatedAccount: accumulated,
      expenseAccount: expense,
      journal,
    };
    const made = await env.model('account.asset.category').create([
      { name: 'Office equipment', ...accounts, method: 'linear', lifeMonths: 60, taxRate: '10' },
      { name: 'Computers', ...accounts, method: 'linear', lifeMonths: 36, taxRate: '30' },
      {
        name: 'Vehicles',
        ...accounts,
        method: 'degressive',
        lifeMonths: 60,
        rate: '30',
        taxRate: '20',
      },
    ] as never);
    const [, computers, vehicles] = made.ids;
    const assets = await env.model('account.asset').create([
      {
        name: 'Laptops for the sales team (5)',
        code: 'FA-0001',
        category: computers,
        value: '450000',
        salvage: '0',
        dateAcquired: ctx.date(-425),
        dateInUse: ctx.date(-420),
        method: 'linear',
        lifeMonths: 36,
      },
      {
        name: 'Delivery van',
        code: 'FA-0002',
        category: vehicles,
        value: '3200000',
        salvage: '400000',
        dateAcquired: ctx.date(-200),
        dateInUse: ctx.date(-200),
        method: 'degressive',
        rate: '30',
        lifeMonths: 60,
      },
    ] as never);
    await env.flush();
    await env.model('account.asset').browse(assets.ids).confirm();
    await env.flush();
    const posted = await env.asSuperuser({ reason: 'demo depreciation' }, async (su) => {
      const n = await postDue(su, ctx.date(0));
      await su.flush();
      return n;
    });
    return `Fixed assets: 3 categories, 2 assets, ${posted} months of depreciation posted.`;
  });
}
