/**
 * The data layer of Projects in the portal (RFC 0015 §5.4): customers' portal users read the projects made for their
 * contact and company, and those projects' tasks (the portal's record rule, through the task's project).
 */
import { portalRule, portalShutro } from '@kosh/portal';
import { projectShutro } from '@kosh/project';
import { defineModule, extendModel } from './.kosh/bindings.js';

export const ProjectPortal = extendModel('project.project', {
  access: { 'portal.user': ['read'] },
  rules: { portal: portalRule('partner') },
});

export const TaskPortal = extendModel('project.task', {
  access: { 'portal.user': ['read'] },
  rules: { portal: portalRule('project.partner') },
});

export const projectPortalShutro = defineModule({
  name: 'project_portal',
  version: '0.1.0',
  depends: [projectShutro, portalShutro],
  models: [],
  extensions: [ProjectPortal, TaskPortal],
});
