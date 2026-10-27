/**
 * @packageDocumentation
 * `@kosh/project_portal`: Projects in the customer portal (RFC 0015 §5.4). Proposed whenever Projects and the portal
 * are installed. Customers follow the projects made for them and their tasks — stage, deadline, who works on it —
 * and write on them; internal notes and timesheets stay internal.
 */
import { defineModule } from '@kosh/modules-sdk';
import { portal } from '@kosh/portal';
import { project } from '@kosh/project';
import { projectPortalShutro } from './module.js';

export { ProjectPortal, projectPortalShutro, TaskPortal } from './module.js';

export const projectPortal: ReturnType<typeof defineModule> = defineModule({
  shutro: projectPortalShutro,
  kosh: '^0.1.0',
  depends: [project, portal],
  accessLevels: {
    manager: { label: 'Portal access (projects)', groups: ['portal.manager'] },
  },
  portal: {
    documents: [
      {
        key: 'projects',
        model: 'project.project',
        label: 'Projects',
        partner: 'partner',
        list: ['name', 'dateStart', 'dateEnd', 'taskCount'],
        fields: ['name', 'manager', 'dateStart', 'dateEnd', 'taskCount', 'description'],
        thread: true,
      },
      {
        key: 'tasks',
        model: 'project.task',
        label: 'Tasks',
        partner: 'project.partner',
        domain: { done: false },
        list: ['name', 'project', 'stage', 'deadline', 'priority'],
        fields: ['name', 'project', 'stage', 'assignee', 'deadline', 'priority', 'description'],
        thread: true,
      },
    ],
  },
});
