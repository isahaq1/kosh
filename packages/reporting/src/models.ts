/**
 * The reporting module's models: dashboards, spreadsheets, document templates, report schedules and their outputs.
 * Dashboards, spreadsheets and schedules are private to their owner or shared with every user of the module
 * (record rules). Templates are edited by report designers. Outputs are private: each user sees their own.
 */
import { baseShutro } from '@isahaq/kosh-server';
import { orm } from '@isahaq/kosh-server/orm';

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

/** A dashboard: a grid of cards (`items`: `{ id, title, kind, model, measure, groupBy, filter, w }`). */
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

/** A document template: a layout (see `documents.ts`) for the records of a model. */
const Template = defineModel('report.template', {
  archivable: true,
  access: {
    'reporting.user': ['read'],
    'reporting.designer': ['read', 'write', 'create', 'unlink'],
  },
  order: ['targetModel asc', 'name asc'],
  fields: {
    name: f.char({ required: true }),
    targetModel: f.char({ required: true, index: true, label: 'Model' }),
    /** `module.key` of the manifest template it came from, so reinstalls do not duplicate it. */
    key: f.char({ index: 'unique' }),
    layout: f.json({ required: true }),
    /** A document of one record (`record`) or of the records of a search (`list`). */
    scope: f.selection(
      { record: 'One record', list: 'A list of records' },
      { required: true, default: 'record' },
    ),
  },
});

/** A scheduled report: a pivot or list query, rendered as a file on a cadence, as its owner. */
const Schedule = defineModel('report.schedule', {
  archivable: true,
  access: { 'reporting.user': ['read', 'write', 'create', 'unlink'] },
  rules: OWN_OR_SHARED,
  order: ['name asc'],
  fields: {
    name: f.char({ required: true }),
    targetModel: f.char({ required: true, label: 'Model' }),
    /** `pivot`: a report query (`query`); `list`: a search (`query.filter`, `query.fields`); `document`: a template over a search. */
    kind: f.selection(
      { pivot: 'Pivot', list: 'List', document: 'Document' },
      { required: true, default: 'pivot' },
    ),
    query: f.json({ required: true, default: {} as never }),
    template: f.many2one('report.template', { ondelete: 'set null' }),
    format: f.selection(
      { xlsx: 'Excel (XLSX)', csv: 'CSV', pdf: 'PDF' },
      { required: true, default: 'xlsx' },
    ),
    frequency: f.selection(
      { daily: 'Every day', weekly: 'Every week', monthly: 'Every month' },
      { required: true, default: 'monthly' },
    ),
    /** 0–23, in the owner's time zone. */
    hour: f.integer({ default: 8 }),
    /** Weekly: 1 (Monday) – 7; monthly: 1–28. */
    day: f.integer({ default: 1 }),
    tz: f.char({ default: 'UTC' }),
    /** Users who receive the output (delivery adapters: RFC 0006); the owner always does. */
    recipients: f.many2many('res.users'),
    nextRunAt: f.datetime(),
    lastRunAt: f.datetime(),
    lastError: f.char(),
    shared: f.boolean({ default: false }),
  },
});

/** A rendered output of a schedule (or an ad-hoc run), kept for its recipients. */
const Output = defineModel('report.output', {
  access: { 'reporting.user': ['read'] },
  rules: {
    mine: {
      groups: ['reporting.user'],
      perms: ['read'],
      domain: {
        or: [{ createdBy: { $env: 'uid' } }, { recipients: { any: { id: { $env: 'uid' } } } }],
      },
    },
  },
  order: ['id desc'],
  fields: {
    schedule: f.many2one('report.schedule', { ondelete: 'cascade' }),
    name: f.char({ required: true }),
    filename: f.char({ required: true }),
    mime: f.char({ required: true }),
    size: f.integer({ required: true }),
    content: f.binary({ required: true }),
    recipients: f.many2many('res.users'),
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
  models: [Dashboard, Spreadsheet, Template, Schedule, Output],
});
