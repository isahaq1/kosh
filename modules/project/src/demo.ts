/** Demo data of Projects (RFC 0008 §5.8): two projects, tasks across the stages, timesheets of two people. */

import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['project.manager'] } as const;
/** The demo project member. */
export const SUMI = { login: 'sumi', name: 'Sumi Begum', groups: ['project.user'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['project.user'] } as const;

/** The support project's name: `sale_project` points the service products at it. */
export const SUPPORT_PROJECT = 'Customer support';

const TASKS: readonly {
  readonly project: string;
  readonly name: string;
  readonly stage: 'New' | 'In progress' | 'Done';
  readonly assignee: 'dina' | 'sumi' | 'rahim';
  readonly priority?: 'high';
  readonly deadlineInDays: number;
  readonly planned: string;
}[] = [
  {
    project: 'Bengal Steel plant extension',
    name: 'Survey the site',
    stage: 'Done',
    assignee: 'sumi',
    deadlineInDays: -20,
    planned: '16',
  },
  {
    project: 'Bengal Steel plant extension',
    name: 'Structural design',
    stage: 'In progress',
    assignee: 'dina',
    priority: 'high',
    deadlineInDays: 10,
    planned: '40',
  },
  {
    project: 'Bengal Steel plant extension',
    name: 'Order the beams',
    stage: 'In progress',
    assignee: 'rahim',
    deadlineInDays: 3,
    planned: '4',
  },
  {
    project: 'Bengal Steel plant extension',
    name: 'Install the beams',
    stage: 'New',
    assignee: 'sumi',
    deadlineInDays: 45,
    planned: '80',
  },
  {
    project: SUPPORT_PROJECT,
    name: 'Acme: delivery schedule questions',
    stage: 'In progress',
    assignee: 'sumi',
    deadlineInDays: 1,
    planned: '2',
  },
  {
    project: SUPPORT_PROJECT,
    name: 'Meghna: replace two faulty panels',
    stage: 'New',
    assignee: 'sumi',
    priority: 'high',
    deadlineInDays: 4,
    planned: '6',
  },
  {
    project: SUPPORT_PROJECT,
    name: 'Sylhet: quotation follow-up',
    stage: 'Done',
    assignee: 'rahim',
    deadlineInDays: -3,
    planned: '1',
  },
];

const userId = async (env: Env, login: string): Promise<number> => {
  const found = await env.model('res.users').search({ where: { login }, limit: 1 });
  const id = found.ids[0];
  if (id === undefined) throw new Error(`Demo data: no user "${login}".`);
  return id;
};

export async function projectDemo(context: DemoContext): Promise<string> {
  const tasks = new Map<string, number>();
  // The members exist before the tasks are assigned to them.
  for (const member of [SUMI, RAHIM]) await context.as(member, async () => undefined);
  await context.as(DINA, async (raw) => {
    const env = raw as Env;
    const projects = env.model('project.project');
    const created = await projects.create([
      {
        name: 'Bengal Steel plant extension',
        partner: orm.asId(await idByName(env, 'res.partner', 'Bengal Steel Ltd'), 'res.partner'),
        dateStart: context.date(-30),
        dateEnd: context.date(90),
        description: 'Beams, installation and commissioning of the new hall.',
      },
      {
        name: SUPPORT_PROJECT,
        sequence: 20,
        description: 'Questions and issues of our customers.',
      },
    ]);
    const projectId = new Map([
      ['Bengal Steel plant extension', created.ids[0] as number],
      [SUPPORT_PROJECT, created.ids[1] as number],
    ]);
    const stages = new Map<string, number>();
    for (const name of ['New', 'In progress', 'Done'])
      stages.set(name, await idByName(env, 'project.task.stage', name));
    const users = new Map<string, number>();
    for (const login of ['dina', 'sumi', 'rahim']) users.set(login, await userId(env, login));
    for (const t of TASKS) {
      const row = await env.model('project.task').create([
        {
          name: t.name,
          project: orm.asId(projectId.get(t.project) as number, 'project.project'),
          stage: orm.asId(stages.get(t.stage) as number, 'project.task.stage'),
          assignee: orm.asId(users.get(t.assignee) as number, 'res.users'),
          priority: t.priority ?? 'normal',
          deadline: context.date(t.deadlineInDays),
          plannedHours: t.planned,
        },
      ]);
      tasks.set(t.name, row.ids[0] as number);
    }
  });
  const sheet = async (
    user: typeof SUMI | typeof RAHIM,
    lines: readonly { task: string; daysAgo: number; hours: string; description: string }[],
  ) =>
    context.as(user, async (raw) => {
      const env = raw as Env;
      await env.model('project.timesheet').create(
        lines.map((l) => ({
          task: orm.asId(tasks.get(l.task) as number, 'project.task'),
          date: context.date(-l.daysAgo),
          hours: l.hours,
          description: l.description,
        })),
      );
    });
  await sheet(SUMI, [
    { task: 'Survey the site', daysAgo: 22, hours: '8', description: 'Site visit, Chattogram' },
    { task: 'Survey the site', daysAgo: 21, hours: '6.5', description: 'Measurements and report' },
    { task: 'Acme: delivery schedule questions', daysAgo: 1, hours: '1.5', description: 'Call' },
  ]);
  await sheet(RAHIM, [
    { task: 'Order the beams', daysAgo: 2, hours: '2', description: 'Purchase order placed' },
    {
      task: 'Sylhet: quotation follow-up',
      daysAgo: 4,
      hours: '0.5',
      description: 'Follow-up call',
    },
  ]);
  return `2 projects, ${TASKS.length} tasks and 5 timesheets`;
}
