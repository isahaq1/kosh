/**
 * The data layer of the Sales ↔ Projects bridge (RFC 0008 §5.1): a service product says what its sale creates on
 * confirmation (nothing, a task in a project, or a project of its own); the order's confirmation is an outbox event
 * (`sale.order.confirmed`, emitted by Sales) that this bridge's subscriber turns into tasks and projects, once,
 * in its own transaction as the user who confirmed. The order lists its tasks, the task its order and line.
 */
import { productShutro } from '@kosh/product';
import { projectShutro } from '@kosh/project';
import { salesShutro } from '@kosh/sales';
import { orm } from '@kosh/server/orm';
import { compute, defineModule, type Env, extendModel, f } from './.kosh/bindings.js';

export const ProductService = extendModel('product.product', {
  fields: {
    serviceTracking: f.selection(
      { none: 'Nothing', task: 'A task in a project', project: 'A project of its own' },
      { required: true, default: 'none', label: 'On sale confirmation' },
    ),
    project: f.many2one('project.project', { label: 'Project for the tasks' }),
  },
});

export const TaskSale = extendModel('project.task', {
  fields: {
    saleOrder: f.many2one('sale.order', { label: 'Sales order' }),
    saleLine: f.many2one('sale.order.line', { label: 'Order line' }),
  },
});

export const ProjectSale = extendModel('project.project', {
  fields: { saleOrder: f.many2one('sale.order', { label: 'Sales order' }) },
});

export const OrderTasks = extendModel('sale.order', {
  fields: {
    tasks: f.one2many('project.task', 'saleOrder'),
    taskCount: f.integer({
      store: true,
      label: 'Tasks',
      ...compute('sale.order', 'taskCount', ['tasks'], (orders) => {
        for (const o of orders) o.taskCount = o.tasks.length;
      }),
    }),
  },
});

/** The tasks and projects a confirmed order's service lines ask for (lines already served are skipped). */
export async function createTasksFor(
  env: Env,
  orderId: number,
): Promise<{ tasks: number; projects: number }> {
  const [order] = await env
    .model('sale.order')
    .browse([orm.asId(orderId, 'sale.order')])
    .load({ lines: { product: { project: true } }, partner: true, company: true, tasks: true });
  if (order === undefined) return { tasks: 0, projects: 0 };
  const served = new Set(order.tasks.map((t) => t.saleLine?.id ?? 0));
  let tasks = 0;
  let projects = 0;
  let ownProject: number | null = null;
  const projectsOf = env.model('project.project');
  const ownProjectId = async (): Promise<number> => {
    if (ownProject !== null) return ownProject;
    const existing = await projectsOf.search({ where: { saleOrder: order.id }, limit: 1 });
    if (existing.ids.length > 0) {
      ownProject = existing.ids[0] as number;
      return ownProject;
    }
    const created = await projectsOf.create([
      {
        name: `${order.name} ${order.partner.name}`,
        partner: order.partner.id,
        company: order.company.id,
        saleOrder: order.id,
      },
    ]);
    projects += 1;
    ownProject = created.ids[0] as number;
    return ownProject;
  };
  for (const line of order.lines) {
    if (served.has(line.id)) continue;
    const tracking = line.product.serviceTracking;
    if (tracking === 'none') continue;
    const projectId =
      tracking === 'project'
        ? await ownProjectId()
        : (line.product.project?.id ?? (await ownProjectId()));
    await env.model('project.task').create([
      {
        name: `${order.name}: ${line.name}`,
        project: orm.asId(projectId, 'project.project'),
        partner: order.partner.id,
        company: order.company.id,
        plannedHours: line.quantity,
        saleOrder: order.id,
        saleLine: line.id,
      },
    ]);
    tasks += 1;
  }
  return { tasks, projects };
}

export const saleProjectShutro = defineModule({
  name: 'sale_project',
  version: '0.1.0',
  depends: [salesShutro, projectShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'sale_project.user',
      label: 'Sales to projects',
      implies: ['sales.user', 'project.user'],
    }),
  ],
  models: [],
  extensions: [ProductService, TaskSale, ProjectSale, OrderTasks],
});
