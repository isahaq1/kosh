/**
 * @packageDocumentation
 * `@kosh/quality` (RFC 0038 §4): the **Quality** app. Control points say what is checked — which products, on which
 * operation, from which vendor, how often —; the checks of a document are made by the server and decided once
 * (a measure by its tolerances, a photo check with its photo); a failed check raises an alert, closed by a Quality
 * manager with its root cause and what was done. Bridges hold their documents over a check to do or failed.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { action, form, kanban, list, search } from '@kosh/views';
import { qualityDemo } from './demo.js';
import { QualityAlert, QualityCheck, QualityPoint, qualityShutro } from './module.js';

export {
  blockingChecks,
  CHECK_KINDS,
  type CheckedDocument,
  type CheckedLine,
  checksFor,
  OPERATIONS,
  type Operation,
  QualityAlert,
  QualityCheck,
  QualityPoint,
  qualityShutro,
  within,
} from './module.js';

export const quality: ReturnType<typeof defineModule> = defineModule({
  shutro: qualityShutro,
  kosh: '^0.1.0',
  hooks: { demo: qualityDemo },
  depends: [contacts, product, messaging, reporting],
  app: {
    code: 'quality',
    label: 'Quality',
    icon: 'quality',
    sequence: 15,
    category: 'Operations',
    summary: 'Control points, checks that hold what fails, alerts with their root cause',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Checker (does checks, raises alerts)', groups: ['quality.user'] },
    manager: {
      label: 'Quality manager (control points, releases, closes alerts)',
      groups: ['quality.manager'],
      implies: ['user'],
    },
  },
  events: [
    { topic: 'quality.check.passed', model: 'quality.check', label: 'Quality check passed' },
    { topic: 'quality.check.failed', model: 'quality.check', label: 'Quality check failed' },
    { topic: 'quality.alert.resolved', model: 'quality.alert', label: 'Quality alert resolved' },
  ],
  documents: [
    {
      key: 'quality_check',
      name: 'Quality check',
      model: 'quality.check',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Quality check {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'what',
            items: [
              { label: 'What to check', bind: 'title' },
              { label: 'Product', bind: 'product.name' },
              { label: 'Lot or serial number', bind: 'lot' },
              { label: 'Vendor or customer', bind: 'partner.name' },
              { label: 'Document', bind: 'resName' },
              { label: 'Measured', bind: 'measure' },
              { label: 'Result', bind: 'state' },
              { label: 'Checked by', bind: 'checkedBy.name' },
              { label: 'Checked at', bind: 'checkedAt' },
            ],
          },
          { kind: 'text', id: 'instructions', text: '{{point.instructions}}' },
          { kind: 'text', id: 'notes', text: '{{notes}}' },
          { kind: 'text', id: 'reason', text: '{{reason}}' },
        ],
      },
    },
    {
      key: 'quality_alert',
      name: 'Quality alert',
      model: 'quality.alert',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Quality alert {{name}}', level: 1 },
          { kind: 'heading', id: 'subject', text: '{{title}}', level: 2 },
          {
            kind: 'fields',
            id: 'what',
            items: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Lot or serial number', bind: 'lot' },
              { label: 'Vendor or customer', bind: 'partner.name' },
              { label: 'Priority', bind: 'priority' },
              { label: 'Responsible', bind: 'responsible.name' },
              { label: 'Status', bind: 'state' },
            ],
          },
          { kind: 'heading', id: 'h_found', text: 'What was found', level: 3 },
          { kind: 'text', id: 'found', text: '{{description}}' },
          { kind: 'heading', id: 'h_cause', text: 'Root cause', level: 3 },
          { kind: 'text', id: 'cause', text: '{{rootCause}}' },
          { kind: 'heading', id: 'h_corrective', text: 'Corrective action', level: 3 },
          { kind: 'text', id: 'corrective', text: '{{corrective}}' },
          { kind: 'heading', id: 'h_preventive', text: 'Preventive action', level: 3 },
          { kind: 'text', id: 'preventive', text: '{{preventive}}' },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'quality_points',
      model: 'quality.point',
      label: 'Control points',
      columns: [
        { header: 'Title', field: 'name' },
        { header: 'What is checked', field: 'kind' },
        { header: 'On', field: 'operation' },
        { header: 'Product', field: 'product' },
        { header: 'Product category', field: 'category' },
        { header: 'Only from', field: 'partner' },
        { header: 'One in', field: 'every' },
        { header: 'Unit', field: 'unit' },
        { header: 'At least', field: 'low' },
        { header: 'At most', field: 'high' },
        { header: 'Instructions', field: 'instructions' },
      ],
    },
    {
      key: 'quality_alerts',
      model: 'quality.alert',
      label: 'Quality alerts',
      columns: [
        { header: 'Title', field: 'title' },
        { header: 'Product', field: 'product' },
        { header: 'Lot or serial number', field: 'lot' },
        { header: 'Vendor or customer', field: 'partner' },
        { header: 'Priority', field: 'priority' },
        { header: 'What was found', field: 'description' },
      ],
    },
  ],
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'quality.check',
        reason:
          'Checks are made by the server for a document from the control points; they are never typed in.',
      },
    ],
  },
  overview: {
    cards: [
      {
        id: 'to_do',
        title: 'Checks to do',
        kind: 'kpi',
        model: 'quality.check',
        measure: 'count',
        filter: { state: 'todo' },
        w: 3,
      },
      {
        id: 'holding',
        title: 'Failed and holding',
        kind: 'kpi',
        model: 'quality.check',
        measure: 'count',
        filter: { state: 'failed', released: false },
        w: 3,
      },
      {
        id: 'open_alerts',
        title: 'Open alerts',
        kind: 'kpi',
        model: 'quality.alert',
        measure: 'count',
        filter: { state: { in: ['new', 'investigating'] } },
        w: 3,
      },
      {
        id: 'points',
        title: 'Control points',
        kind: 'kpi',
        model: 'quality.point',
        measure: 'count',
        w: 3,
      },
      {
        id: 'by_result',
        title: 'Checks by result',
        kind: 'chart',
        model: 'quality.check',
        measure: 'count',
        groupBy: 'state',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'failed_by_vendor',
        title: 'Failed checks by vendor',
        kind: 'pivot',
        model: 'quality.check',
        measure: 'count',
        groupBy: 'partner',
        filter: { state: 'failed' },
        w: 6,
      },
      {
        id: 'failed_by_product',
        title: 'Failed checks by product',
        kind: 'pivot',
        model: 'quality.check',
        measure: 'count',
        groupBy: 'product',
        filter: { state: 'failed' },
        w: 6,
      },
      {
        id: 'alerts_by_priority',
        title: 'Open alerts by priority',
        kind: 'chart',
        model: 'quality.alert',
        measure: 'count',
        groupBy: 'priority',
        filter: { state: { in: ['new', 'investigating'] } },
        chart: 'bar',
        w: 6,
      },
    ],
  },
  actions: {
    'quality.action_checks': action(QualityCheck, { label: 'Checks', views: ['list', 'form'] }),
    'quality.action_alerts': action(QualityAlert, {
      label: 'Alerts',
      views: ['kanban', 'list', 'form'],
    }),
    'quality.action_points': action(QualityPoint, {
      label: 'Control points',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'quality.root', label: 'Quality', app: 'quality' },
    {
      id: 'quality.checks',
      parent: 'quality.root',
      label: 'Checks',
      action: 'quality.action_checks',
      sequence: 1,
    },
    {
      id: 'quality.alerts',
      parent: 'quality.root',
      label: 'Alerts',
      action: 'quality.action_alerts',
      sequence: 2,
    },
    { id: 'quality.configuration', parent: 'quality.root', label: 'Configuration', sequence: 9 },
    {
      id: 'quality.points',
      parent: 'quality.configuration',
      label: 'Control points',
      action: 'quality.action_points',
      sequence: 1,
    },
  ],
  views: {
    'quality.check.list': list(QualityCheck, {
      columns: [
        'name',
        'title',
        'product',
        'partner',
        'resName',
        'measure',
        { field: 'state', widget: 'badge' },
        'released',
        'checkedBy',
      ],
      defaultOrder: ['id desc'],
      decorations: {
        success: { state: 'passed' },
        danger: { state: 'failed', released: false },
        neutral: { state: 'failed', released: true },
        warning: { state: 'todo' },
      },
    }),
    'quality.check.form': form(QualityCheck, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('pass', { primary: true, label: 'Pass' }),
          k.button('fail', { label: 'Fail' }),
          k.button('release', {
            label: 'Release',
            confirm: 'Let the document go on although this check failed?',
          }),
          k.button('redo', { label: 'Do again' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'title', 'point', 'kind', 'operation']),
        k.group('about', ['product', 'lot', 'partner', 'resName'], { label: 'What it is for' }),
        k.group('result', ['measure', { field: 'photo', widget: 'image' }, 'notes'], {
          label: 'Result',
          description:
            'A measure: write the value, then Pass or Fail — the value decides, and the wrong button is refused. A photo check passes with its photo.',
        }),
        k.group('decided', ['checkedBy', 'checkedAt', 'released', 'reason', 'alert'], {
          label: 'Decision',
          description:
            'To release a failed check or do a check again, a Quality manager writes the reason, then presses the button.',
        }),
      ],
      chatter: true,
    })),
    'quality.alert.list': list(QualityAlert, {
      columns: [
        'name',
        'title',
        'product',
        'partner',
        { field: 'priority', widget: 'badge' },
        'responsible',
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['id desc'],
      decorations: {
        danger: { priority: 'urgent', state: { in: ['new', 'investigating'] } },
        success: { state: 'resolved' },
        neutral: { state: 'cancelled' },
      },
    }),
    'quality.alert.kanban': kanban(QualityAlert, {
      groupBy: 'state',
      card: { title: 'title', subtitle: 'name', footer: ['product', 'priority', 'responsible'] },
    }),
    'quality.alert.form': form(QualityAlert, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('investigate', { primary: true, label: 'Investigate' }),
          k.button('resolve', { primary: true, label: 'Resolve' }),
          k.button('cancel', { label: 'Cancel' }),
          k.button('reopen', { label: 'Reopen' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'title', 'priority', 'responsible']),
        k.group('about', ['product', 'lot', 'partner', 'check'], { label: 'What it is about' }),
        k.group('found', ['description'], { label: 'What was found', columns: 1 }),
        k.group('actions', ['rootCause', 'corrective', 'preventive'], {
          label: 'Cause and actions',
          columns: 1,
          description: 'The root cause and the corrective action are needed to resolve the alert.',
        }),
        k.group('closed', ['resolvedAt'], { label: 'Closed' }),
      ],
      chatter: true,
    })),
    'quality.point.list': list(QualityPoint, {
      columns: ['name', 'kind', 'operation', 'product', 'category', 'partner', 'every'],
    }),
    'quality.point.form': form(QualityPoint, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'kind', 'operation', 'every']),
        k.group('applies', ['product', 'category', 'partner'], {
          label: 'Applies to',
          description:
            'Leave all three empty to check every product on the operation, whoever it is with.',
        }),
        k.group('measure', ['unit', 'low', 'high'], {
          label: 'Tolerances',
          description: 'For a measure: within them the check passes by itself, outside it fails.',
        }),
        k.group('how', ['instructions'], { label: 'Instructions', columns: 1 }),
      ],
    })),
  },
  search: {
    'quality.check': search(QualityCheck, {
      fields: ['name', 'title', 'product.name', 'partner.name', 'resName', 'lot'],
      filters: {
        todo: { label: 'To do', domain: { state: 'todo' }, group: 'state' },
        failed: { label: 'Failed', domain: { state: 'failed' }, group: 'state' },
        holding: {
          label: 'Failed and holding',
          domain: { state: 'failed', released: false },
          group: 'state',
        },
        passed: { label: 'Passed', domain: { state: 'passed' }, group: 'state' },
      },
      groupBy: ['state', 'product', 'partner', 'point', 'operation'],
    }),
    'quality.alert': search(QualityAlert, {
      fields: ['name', 'title', 'product.name', 'partner.name', 'lot'],
      filters: {
        open: {
          label: 'Open',
          domain: { state: { in: ['new', 'investigating'] } },
          group: 'state',
        },
        mine: { label: 'Mine', domain: { responsible: { $env: 'uid' } }, group: 'who' },
        urgent: { label: 'Urgent', domain: { priority: 'urgent' }, group: 'priority' },
      },
      groupBy: ['state', 'priority', 'product', 'partner', 'responsible'],
    }),
    'quality.point': search(QualityPoint, {
      fields: ['name', 'product.name', 'category.name', 'partner.name'],
      groupBy: ['operation', 'kind'],
    }),
  },
});
