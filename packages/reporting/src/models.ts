/** The reporting module's models (dashboards, document templates and schedules come with their parts). */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const { defineGroup, defineModule } = orm;

export const reportingShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'reporting',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
    defineGroup({ code: 'reporting.user', label: 'Reports user', implies: ['base.user'] }),
    defineGroup({
      code: 'reporting.designer',
      label: 'Report designer',
      implies: ['reporting.user'],
    }),
  ],
  models: [],
});
