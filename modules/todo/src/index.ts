/**
 * @packageDocumentation
 * `@kosh/todo` (RFC 0021): the **Focus** app. To-dos for the people who use it — their own, or on lists shared with
 * colleagues — with a due date, a priority, a checklist whose progress shows on the to-do, and *Done* / *Reopen*.
 * Board, list and calendar views; the open to-dos due today or before appear on the home page. Only the owner, the
 * list's owner and its members see a to-do.
 */
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { action, calendar, form, kanban, list, search } from '@kosh/views';
import { todoDemo } from './demo.js';
import { TodoList, TodoTask, todoShutro } from './module.js';

export { TodoItem, TodoList, TodoTask, todoShutro } from './module.js';

export const todo: ReturnType<typeof defineModule> = defineModule({
  shutro: todoShutro,
  kosh: '^0.1.0',
  hooks: { demo: todoDemo },
  depends: [messaging, reporting],
  app: {
    code: 'focus',
    label: 'Focus',
    icon: 'focus',
    sequence: 5,
    category: 'Productivity',
    summary: 'Your to-dos and shared lists, with checklists and due dates',
  },
  accessLevels: {
    user: { label: 'User (own to-dos and shared lists)', groups: ['todo.user'] },
  },
  // The Overview (RFC 0022 step 2).
  overview: {
    cards: [
      {
        id: 'open',
        title: 'Open to-dos',
        kind: 'kpi',
        model: 'todo.task',
        measure: 'count',
        filter: { state: 'open' },
        w: 3,
      },
      {
        id: 'urgent',
        title: 'Urgent or high',
        kind: 'kpi',
        model: 'todo.task',
        measure: 'count',
        filter: { state: 'open', priority: { in: ['urgent', 'high'] } },
        w: 3,
      },
      {
        id: 'done_month',
        title: 'Done this month',
        kind: 'kpi',
        model: 'todo.task',
        measure: 'count',
        filter: { state: 'done' },
        comparison: { field: 'updatedAt', mode: 'previous' },
        w: 3,
      },
      {
        id: 'lists',
        title: 'Shared lists',
        kind: 'kpi',
        model: 'todo.list',
        measure: 'count',
        w: 3,
      },
      {
        id: 'by_list',
        title: 'Open by list',
        kind: 'chart',
        model: 'todo.task',
        measure: 'count',
        groupBy: 'list',
        filter: { state: 'open' },
        chart: 'pie',
        w: 6,
      },
      {
        id: 'by_priority',
        title: 'Open by priority',
        kind: 'chart',
        model: 'todo.task',
        measure: 'count',
        groupBy: 'priority',
        filter: { state: 'open' },
        chart: 'bar',
        w: 6,
      },
    ],
  },
  actions: {
    'focus.action_tasks': action(TodoTask, {
      label: 'To-dos',
      views: ['kanban', 'list', 'calendar', 'form'],
      defaultFilters: ['open'],
    }),
    'focus.action_lists': action(TodoList, { label: 'Lists', views: ['list', 'form'] }),
  },
  menus: [
    { id: 'focus.root', label: 'Focus', app: 'focus' },
    {
      id: 'focus.tasks',
      parent: 'focus.root',
      label: 'To-dos',
      action: 'focus.action_tasks',
      sequence: 1,
    },
    {
      id: 'focus.lists',
      parent: 'focus.root',
      label: 'Lists',
      action: 'focus.action_lists',
      sequence: 2,
    },
  ],
  views: {
    'todo.task.kanban': kanban(TodoTask, {
      groupBy: 'list',
      card: {
        title: 'name',
        subtitle: 'owner',
        footer: ['dueDate', 'progress'],
        badges: [{ field: 'priority', widget: 'badge' }],
      },
    }),
    'todo.task.list': list(TodoTask, {
      columns: [
        'name',
        'list',
        'owner',
        'dueDate',
        { field: 'priority', widget: 'badge' },
        'progress',
        { field: 'state', widget: 'badge' },
      ],
      inlineEdit: ['name', 'list', 'dueDate', 'priority'],
    }),
    'todo.task.calendar': calendar(TodoTask, {
      dateStart: 'dueDate',
      title: 'name',
      color: 'list',
      mode: 'month',
    }),
    'todo.task.form': form(TodoTask, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('complete', { primary: true, label: 'Done' }),
          k.button('reopen', { label: 'Reopen' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'list', 'owner', 'dueDate', 'priority', 'progress']),
        k.lines('items', [{ field: 'name', id: 'item_name' }, 'done']),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'todo.list.list': list(TodoList, {
      columns: ['name', 'owner', 'members', { field: 'color', widget: 'badge' }],
      inlineEdit: ['name', 'color'],
    }),
    'todo.list.form': form(TodoList, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'owner', 'color', 'sequence']),
        k.group('sharing', ['members'], { columns: 1 }),
      ],
    })),
  },
  search: {
    'todo.task': search(TodoTask, {
      fields: ['name', 'note', 'list.name'],
      filters: {
        open: { label: 'To do', domain: { state: 'open' }, group: 'state' },
        done: { label: 'Done', domain: { state: 'done' }, group: 'state' },
        urgent: { label: 'Urgent or high', domain: { priority: { in: ['urgent', 'high'] } } },
        mine: { label: 'Mine', domain: { owner: { $env: 'uid' } } },
      },
      groupBy: ['list', 'owner', 'priority', 'dueDate:week'],
    }),
    'todo.list': search(TodoList, { fields: ['name'], groupBy: ['owner'] }),
  },
});
