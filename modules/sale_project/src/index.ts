/**
 * @packageDocumentation
 * `@kosh/sale_project`: the bridge between Sales and Projects (RFC 0008 §5.1). Proposed whenever both apps are
 * installed. Confirming a sales order creates the tasks and projects its service products ask for, through the
 * outbox (`sale.order.confirmed`): exactly once, after the confirmation committed, as the user who confirmed.
 */
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { project } from '@kosh/project';
import { sales } from '@kosh/sales';
import type { ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import { field } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { createTasksFor, saleProjectShutro } from './module.js';

export {
  createTasksFor,
  OrderTasks,
  ProductService,
  ProjectSale,
  saleProjectShutro,
  TaskSale,
} from './module.js';

/** The subscriber that serves confirmed orders; tests `drain()` it, the server starts it. */
export function saleProjectWorker(context: Pick<ModuleContext, 'shutro'>): Worker {
  return context.shutro.subscribe(
    'sale_project.tasks',
    'sale.order.confirmed',
    async (event, env) => {
      const payload = (event.payload ?? {}) as { id?: unknown };
      const id = Number(payload.id);
      if (Number.isInteger(id) && id > 0) await createTasksFor(env as Env, id);
    },
    { pollMs: 5000 },
  );
}

export const saleProject: ReturnType<typeof defineModule> = defineModule({
  shutro: saleProjectShutro,
  kosh: '^0.1.0',
  depends: [sales, project, product],
  bridge: [sales, project],
  accessLevels: {
    user: { label: 'Sales to projects', groups: ['sale_project.user'] },
  },
  viewExtensions: [
    {
      view: 'sale.order.form',
      operations: [{ append: 'dates', nodes: [field({ field: 'taskCount', id: 'task_count' })] }],
    },
    {
      view: 'product.product.form',
      operations: [
        {
          append: 'sell',
          nodes: [
            field({ field: 'serviceTracking', id: 'service_tracking' }),
            field({ field: 'project', id: 'service_project' }),
          ],
        },
      ],
    },
  ],
  routes: (context: ModuleContext) => {
    if (process.env['KOSH_SCHEDULES'] === 'off') return;
    const worker = saleProjectWorker(context);
    worker.start();
    context.app.addHook('onClose', async () => {
      await worker.stop();
    });
  },
});
