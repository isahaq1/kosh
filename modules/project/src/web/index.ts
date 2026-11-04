/**
 * @packageDocumentation
 * The web contribution of `@kosh/project`: a project's structure as a tree and the workload of people across projects (RFC 0026).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { Refresh } from './Refresh.js';
import { Schedule } from './Schedule.js';
import { Structure } from './Structure.js';
import { Workload } from './Workload.js';

export { Refresh } from './Refresh.js';
export { Schedule } from './Schedule.js';
export { Structure } from './Structure.js';
export { Workload } from './Workload.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerProjectWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('projects.Structure', Structure);
  registry.registerComponent('projects.Refresh', Refresh);
  registry.registerComponent('projects.Schedule', Schedule);
  registry.registerPage('projects.Workload', Workload);
  if (i18n !== undefined) addMessages(i18n, 'project', messages);
  return registry;
}

export { messages as projectMessages };
