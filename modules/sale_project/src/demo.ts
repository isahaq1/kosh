/**
 * Demo data of the Sales ↔ Projects bridge (RFC 0008 §5.8): the service products say what their sale creates
 * (installation hours become tasks of the support project, a site audit a project of its own).
 */

import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import { SUPPORT_PROJECT } from '@kosh/project';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

const DINA = {
  login: 'dina',
  name: 'Dina Rahman',
  groups: ['product.manager', 'sale_project.user'],
} as const;

export async function saleProjectDemo(context: DemoContext): Promise<string> {
  return context.as(DINA, async (raw) => {
    const env = raw as Env;
    const products = env.model('product.product');
    const support = await idByName(env, 'project.project', SUPPORT_PROJECT);
    await products
      .browse([
        orm.asId(await idByName(env, 'product.product', 'Installation hours'), 'product.product'),
      ])
      .write({ serviceTracking: 'task', project: orm.asId(support, 'project.project') });
    await products
      .browse([orm.asId(await idByName(env, 'product.product', 'Site audit'), 'product.product')])
      .write({ serviceTracking: 'project' });
    return '2 service products create tasks or projects when sold';
  });
}
