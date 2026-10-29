/**
 * The data layer of Focus (RFC 0021): to-do tasks for the people who use them — their own, or on a list shared with
 * colleagues — with a due date, a priority, a checklist whose progress shows on the task, and an optional link to any
 * record of another app. People see their own tasks and those of the lists they belong to; nobody else's.
 */
import { messagingShutro } from '@kosh/messaging';
import { orm } from '@kosh/server/orm';
import { compute, defineModel, defineModule, type Env, f } from './.kosh/bindings.js';

const WRITE = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;

/** A shared list: its owner and members see and work on its tasks. */
export const TodoList = defineModel('todo.list', {
  label: 'List',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  access: { 'todo.user': WRITE },
  rules: {
    mine: {
      groups: ['todo.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { or: [{ owner: me }, { members: { any: { id: me } } }] },
    },
  },
  fields: {
    name: f.char({ required: true }),
    owner: f.many2one('res.users', { required: true, default: (env: Env) => env.userId }),
    members: f.many2many('res.users', { label: 'Shared with' }),
    color: f.selection(
      {
        slate: 'Slate',
        blue: 'Blue',
        green: 'Green',
        amber: 'Amber',
        rose: 'Rose',
        violet: 'Violet',
      },
      { required: true, default: 'blue' },
    ),
    sequence: f.integer({ required: true, default: 10 }),
    tasks: f.one2many('todo.task', 'list'),
  },
});

export const TodoTask = defineModel('todo.task', {
  label: 'To-do',
  recName: 'name',
  order: ['state asc', 'priority desc', 'dueDate asc', 'sequence asc', 'id desc'],
  archivable: true,
  tracking: ['state', 'dueDate', 'owner'],
  access: { 'todo.user': WRITE },
  rules: {
    mine: {
      groups: ['todo.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {
        or: [{ owner: me }, { 'list.owner': me }, { 'list.members': { any: { id: me } } }],
      },
    },
  },
  fields: {
    name: f.char({ required: true, label: 'To-do' }),
    list: f.many2one('todo.list', { ondelete: 'set null' }),
    owner: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.userId,
      label: 'For',
    }),
    dueDate: f.date({ label: 'Due' }),
    priority: f.selection(
      { normal: 'Normal', high: 'High', urgent: 'Urgent' },
      { required: true, default: 'normal' },
    ),
    state: f.state({
      states: { open: 'To do', done: 'Done' },
      initial: 'open',
      transitions: {
        complete: { from: ['open'], to: 'done' },
        reopen: { from: ['done'], to: 'open' },
      },
    }),
    note: f.text({ label: 'Notes' }),
    items: f.one2many('todo.item', 'task', { label: 'Checklist' }),
    /** Done items out of all, in percent; null without a checklist. */
    progress: f.integer({
      store: true,
      label: 'Checklist done (%)',
      ...compute('todo.task', 'progress', ['items.done'], (tasks) => {
        for (const t of tasks) {
          const all = [...t.items];
          t.progress =
            all.length === 0
              ? null
              : Math.round((all.filter((i) => i.done).length / all.length) * 100);
        }
      }),
    }),
    /** The record of another app it is about (`sale.order`, 42), if any. */
    resModel: f.char({ label: 'About (model)' }),
    resId: f.integer({ label: 'About (id)' }),
    sequence: f.integer({ required: true, default: 10 }),
  },
});

/** A step of a to-do's checklist. */
export const TodoItem = defineModel('todo.item', {
  label: 'Checklist item',
  order: ['sequence asc', 'id asc'],
  access: { 'todo.user': WRITE },
  rules: {
    mine: {
      groups: ['todo.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {
        or: [
          { 'task.owner': me },
          { 'task.list.owner': me },
          { 'task.list.members': { any: { id: me } } },
        ],
      },
    },
  },
  fields: {
    task: f.many2one('todo.task', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true, label: 'Step' }),
    done: f.boolean({ default: false }),
    sequence: f.integer({ required: true, default: 10 }),
  },
});

export const todoShutro = defineModule({
  name: 'todo',
  version: '0.1.0',
  depends: [messagingShutro],
  groups: [
    orm.defineGroup({ code: 'todo.user', label: 'Focus user', implies: ['messaging.user'] }),
  ],
  models: [TodoList, TodoTask, TodoItem],
});
