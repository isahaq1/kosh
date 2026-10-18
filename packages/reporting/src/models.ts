/**
 * The reporting module's models: dashboards and spreadsheets (records, private to their owner or shared with every
 * user of the module, governed by record rules). Document templates and schedules come with the documents part.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const { defineGroup, defineModel, defineModule, f } = orm;

const OWN_OR_SHARED = {
  visible: {
    groups: ['reporting.user'],
    perms: ['read'] as const,
    domain: { or: [{ createdBy: { $env: 'uid' } }, { shared: true }] },
  },
  own: {
    groups: ['reporting.user'],
    perms: ['write', 'unlink'] as const,
    domain: { createdBy: { $env: 'uid' } },
  },
};

/** A dashboard: a grid of cards (`items`: `{ id, title, kind, model, query, x, y, w, h }`). */
const Dashboard = defineModel('report.dashboard', {
  access: { 'reporting.user': ['read', 'write', 'create', 'unlink'] },
  rules: OWN_OR_SHARED,
  order: ['name asc'],
  fields: {
    name: f.char({ required: true }),
    items: f.json({ required: true, default: [] as never }),
    shared: f.boolean({ default: false }),
  },
});

/** A spreadsheet: cells by reference (`{ A1: '12', B1: '=SUM(A1:A3)', C1: '=REPORT("sale.order", "sum:amount")' }`). */
const Spreadsheet = defineModel('report.spreadsheet', {
  access: { 'reporting.user': ['read', 'write', 'create', 'unlink'] },
  rules: OWN_OR_SHARED,
  order: ['name asc'],
  fields: {
    name: f.char({ required: true }),
    cells: f.json({ required: true, default: {} as never }),
    shared: f.boolean({ default: false }),
  },
});

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
  models: [Dashboard, Spreadsheet],
});
