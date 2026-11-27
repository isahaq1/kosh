/**
 * @packageDocumentation
 * `@kosh/hr_appraisal`: Appraisals and skills (RFC 0038, step 5) — cycles that open an appraisal per person,
 * goals with weights, the self review and the reviewer's, a weighted score; skills with levels on each person.
 * An appraisal is private to the person, their reviewer and HR.
 */
import { hr } from '@kosh/hr';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { action, form, kanban, list, search, stat } from '@kosh/views';
import { hrAppraisalDemo } from './demo.js';
import {
  Appraisal,
  AppraisalCycle,
  AppraisalGoal,
  EmployeeSkill,
  hrAppraisalShutro,
  Skill,
  SkillLevel,
  SkillType,
} from './module.js';

export {
  Appraisal,
  AppraisalCycle,
  AppraisalGoal,
  EmployeeSkill,
  hrAppraisalShutro,
  openCycle,
  RATINGS,
  Skill,
  SkillLevel,
  SkillType,
} from './module.js';

export const hrAppraisal: ReturnType<typeof defineModule> = defineModule({
  shutro: hrAppraisalShutro,
  kosh: '^0.1.0',
  hooks: { demo: hrAppraisalDemo },
  depends: [hr, messaging, reporting],
  app: {
    code: 'appraisals',
    label: 'Appraisals',
    icon: 'appraisals',
    sequence: 33,
    category: 'People',
    summary:
      'Review cycles with goals, self and manager reviews kept private, and skills with levels',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: {
      label: 'Employee or manager (one’s own appraisal, one’s team’s)',
      groups: ['hr_appraisal.user'],
    },
    manager: {
      label: 'HR (cycles, skills, every appraisal)',
      groups: ['hr_appraisal.manager'],
      implies: ['user'],
    },
  },
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'hr.appraisal',
        reason:
          'An appraisal is made by its cycle and written by the person and the reviewer; there is nothing to import.',
      },
    ],
  },
  events: [
    {
      topic: 'hr.appraisal.cycle.opened',
      model: 'hr.appraisal.cycle',
      label: 'Appraisal cycle opened',
    },
    { topic: 'hr.appraisal.submitted', model: 'hr.appraisal', label: 'Self review submitted' },
    { topic: 'hr.appraisal.completed', model: 'hr.appraisal', label: 'Appraisal completed' },
  ],
  documents: [
    {
      key: 'hr_appraisal',
      name: 'Appraisal',
      model: 'hr.appraisal',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Person', bind: 'employee.name' },
              { label: 'Reviewer', bind: 'reviewer.name' },
              { label: 'Completed on', bind: 'doneOn' },
              { label: 'Rating', bind: 'rating' },
              { label: 'Score %', bind: 'score' },
            ],
          },
          {
            kind: 'table',
            id: 'goals',
            bind: 'goals',
            columns: [
              { label: 'Goal', bind: 'name' },
              { label: 'Weight', bind: 'weight' },
              { label: 'Own score %', bind: 'selfScore' },
              { label: 'Score %', bind: 'score' },
              { label: 'Comment', bind: 'comment' },
            ],
          },
          { kind: 'heading', id: 'self_title', text: 'Self review', level: 2 },
          { kind: 'text', id: 'self', text: '{{selfReview}}' },
          { kind: 'heading', id: 'review_title', text: 'Reviewer’s review', level: 2 },
          { kind: 'text', id: 'review', text: '{{managerReview}}' },
          {
            kind: 'text',
            id: 'sign',
            text: 'Person: ______________   Reviewer: ______________',
          },
        ],
      },
    },
    {
      key: 'hr_appraisal_cycle',
      name: 'Appraisal cycle',
      model: 'hr.appraisal.cycle',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'when',
            items: [
              { label: 'Period from', bind: 'dateFrom' },
              { label: 'Period to', bind: 'dateTo' },
              { label: 'Reviews due by', bind: 'dateDue' },
            ],
          },
          {
            kind: 'table',
            id: 'appraisals',
            bind: 'appraisals',
            columns: [
              { label: 'Appraisal', bind: 'name' },
              { label: 'State', bind: 'state' },
              { label: 'Rating', bind: 'rating' },
              { label: 'Score %', bind: 'score' },
            ],
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'hr_skill_types',
      model: 'hr.skill.type',
      label: 'Kinds of skill',
      columns: [{ header: 'Name', field: 'name' }],
    },
    {
      key: 'hr_skills',
      model: 'hr.skill',
      label: 'Skills',
      columns: [
        { header: 'Kind', field: 'type' },
        { header: 'Name', field: 'name' },
      ],
    },
    {
      key: 'hr_skill_levels',
      model: 'hr.skill.level',
      label: 'Skill levels',
      columns: [
        { header: 'Kind', field: 'type' },
        { header: 'Name', field: 'name' },
        { header: 'Progress %', field: 'progress' },
      ],
    },
    {
      key: 'hr_employee_skills',
      model: 'hr.employee.skill',
      label: 'People’s skills',
      columns: [
        { header: 'Person', field: 'employee' },
        { header: 'Skill', field: 'skill' },
        { header: 'Level', field: 'level' },
      ],
    },
    {
      key: 'hr_appraisal_cycles',
      model: 'hr.appraisal.cycle',
      label: 'Appraisal cycles',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Period from', field: 'dateFrom' },
        { header: 'Period to', field: 'dateTo' },
        { header: 'Reviews due by', field: 'dateDue' },
      ],
    },
  ],
  overview: {
    cards: [
      {
        id: 'to_self',
        title: 'Waiting for the self review',
        kind: 'kpi',
        model: 'hr.appraisal',
        measure: 'count',
        filter: { state: 'self' },
        w: 3,
      },
      {
        id: 'to_review',
        title: 'Waiting for the reviewer',
        kind: 'kpi',
        model: 'hr.appraisal',
        measure: 'count',
        filter: { state: 'review' },
        w: 3,
      },
      {
        id: 'completed',
        title: 'Completed',
        kind: 'kpi',
        model: 'hr.appraisal',
        measure: 'count',
        filter: { state: 'done' },
        w: 3,
      },
      {
        id: 'skills',
        title: 'Skills on record',
        kind: 'kpi',
        model: 'hr.employee.skill',
        measure: 'count',
        w: 3,
      },
      {
        id: 'by_state',
        title: 'Appraisals by state',
        kind: 'chart',
        model: 'hr.appraisal',
        measure: 'count',
        groupBy: 'state',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_rating',
        title: 'Completed appraisals by rating',
        kind: 'chart',
        model: 'hr.appraisal',
        measure: 'count',
        groupBy: 'rating',
        filter: { state: 'done' },
        chart: 'pie',
        w: 6,
      },
      {
        id: 'people_by_skill',
        title: 'People by skill',
        kind: 'pivot',
        model: 'hr.employee.skill',
        measure: 'count',
        groupBy: 'skill',
        w: 6,
      },
      {
        id: 'by_cycle',
        title: 'Appraisals by cycle',
        kind: 'pivot',
        model: 'hr.appraisal',
        measure: 'count',
        groupBy: 'cycle',
        w: 6,
      },
    ],
  },
  actions: {
    'hr_appraisal.action_appraisals': action(Appraisal, {
      label: 'Appraisals',
      views: ['list', 'kanban', 'form'],
    }),
    'hr_appraisal.action_cycles': action(AppraisalCycle, {
      label: 'Cycles',
      views: ['list', 'form'],
    }),
    'hr_appraisal.action_goals': action(AppraisalGoal, { label: 'Goals', views: ['list', 'form'] }),
    'hr_appraisal.action_employee_skills': action(EmployeeSkill, {
      label: 'People’s skills',
      views: ['list', 'form'],
    }),
    'hr_appraisal.action_skill_types': action(SkillType, {
      label: 'Kinds of skill',
      views: ['list', 'form'],
    }),
    'hr_appraisal.action_skills': action(Skill, { label: 'Skills', views: ['list', 'form'] }),
    'hr_appraisal.action_levels': action(SkillLevel, {
      label: 'Skill levels',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'hr_appraisal.root', label: 'Appraisals', app: 'appraisals' },
    {
      id: 'hr_appraisal.appraisals',
      parent: 'hr_appraisal.root',
      label: 'Appraisals',
      action: 'hr_appraisal.action_appraisals',
      sequence: 1,
    },
    {
      id: 'hr_appraisal.cycles',
      parent: 'hr_appraisal.root',
      label: 'Cycles',
      action: 'hr_appraisal.action_cycles',
      sequence: 2,
    },
    {
      id: 'hr_appraisal.employee_skills',
      parent: 'hr_appraisal.root',
      label: 'People’s skills',
      action: 'hr_appraisal.action_employee_skills',
      sequence: 3,
    },
    {
      id: 'hr_appraisal.skill_types',
      parent: 'hr_appraisal.root',
      label: 'Kinds of skill',
      action: 'hr_appraisal.action_skill_types',
      sequence: 4,
    },
  ],
  viewExtensions: [
    {
      view: 'hr.employee.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'employee_skills',
              label: 'Skills',
              model: EmployeeSkill,
              where: { employee: { $record: 'id' } },
              action: 'hr_appraisal.action_employee_skills',
            }),
            stat({
              id: 'employee_appraisals',
              label: 'Appraisals',
              model: Appraisal,
              where: { employee: { $record: 'id' } },
              action: 'hr_appraisal.action_appraisals',
            }),
          ],
        },
      ],
    },
  ],
  views: {
    'hr.appraisal.list': list(Appraisal, {
      columns: [
        'name',
        'employee',
        'reviewer',
        'cycle',
        { field: 'dateDue', widget: 'daysLeft' },
        'rating',
        'score',
        { field: 'state', widget: 'badge' },
      ],
      decorations: {
        info: { state: { in: ['self', 'review'] } },
        success: { state: 'done' },
        neutral: { state: 'cancel' },
      },
    }),
    'hr.appraisal.kanban': kanban(Appraisal, {
      groupBy: 'state',
      card: {
        title: 'employee',
        subtitle: 'cycle',
        footer: ['reviewer', 'dateDue'],
        badges: [{ field: 'rating', widget: 'badge' }],
      },
    }),
    'hr.appraisal.form': form(Appraisal, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('begin', { primary: true, label: 'Ask for the self review' }),
          k.button('submit', { primary: true, label: 'Submit my self review' }),
          k.button('complete', { primary: true, label: 'Complete' }),
          k.button('reopen', { label: 'Reopen' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      readonlyWhen: { state: { in: ['done', 'cancel'] } },
      sheet: [
        k.group('main', ['name', 'employee', 'reviewer', 'cycle', 'dateDue', 'doneOn']),
        k.lines('goals', [
          { field: 'name', id: 'goal_name' },
          { field: 'weight', id: 'goal_weight' },
          { field: 'selfScore', id: 'goal_self' },
          { field: 'score', id: 'goal_score' },
          { field: 'comment', id: 'goal_comment' },
        ]),
        k.group('self', ['selfReview'], {
          label: 'Self review',
          columns: 1,
          description: 'Written by the person, and nobody else.',
        }),
        k.group('review', ['managerReview', 'rating', 'score'], {
          label: 'Reviewer’s review',
          columns: 1,
          description:
            'Written by the reviewer or HR, never by the person. The score is the goals’ scores, weighted.',
        }),
      ],
      chatter: true,
    })),
    'hr.appraisal.cycle.list': list(AppraisalCycle, {
      columns: ['name', 'dateFrom', 'dateTo', 'dateDue', { field: 'state', widget: 'badge' }],
      decorations: { info: { state: 'open' }, neutral: { state: 'closed' } },
    }),
    'hr.appraisal.cycle.form': form(AppraisalCycle, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('launch', { primary: true, label: 'Open the cycle' }),
          k.button('close', { label: 'Close' }),
          k.button('reopen', { label: 'Reopen' }),
        ],
      },
      sheet: [
        k.stats('related', [
          {
            id: 'cycle_appraisals',
            label: 'Appraisals',
            model: Appraisal,
            where: { cycle: { $record: 'id' } },
            action: 'hr_appraisal.action_appraisals',
          },
          {
            id: 'cycle_done',
            label: 'Completed',
            model: Appraisal,
            where: { cycle: { $record: 'id' }, state: 'done' },
            action: 'hr_appraisal.action_appraisals',
          },
        ]),
        k.group('main', ['name', 'dateFrom', 'dateTo', 'dateDue'], {
          description:
            'Opening the cycle makes an appraisal for every person who has a manager, reviewed by that manager.',
        }),
      ],
      chatter: true,
    })),
    'hr.appraisal.goal.list': list(AppraisalGoal, {
      columns: ['appraisal', 'name', 'weight', 'selfScore', 'score', 'comment'],
    }),
    'hr.appraisal.goal.form': form(AppraisalGoal, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['appraisal', 'name', 'weight', 'selfScore', 'score', 'comment'])],
    })),
    'hr.employee.skill.list': list(EmployeeSkill, {
      columns: ['employee', 'skill', 'level', { field: 'progress', widget: 'progress' }, 'note'],
    }),
    'hr.employee.skill.form': form(EmployeeSkill, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['employee', 'skill', 'level', 'progress', 'note'])],
    })),
    'hr.skill.type.list': list(SkillType, { columns: ['name'] }),
    'hr.skill.type.form': form(SkillType, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name']),
        k.lines('skills', [{ field: 'name', id: 'skill_name' }]),
        k.lines('levels', [
          { field: 'name', id: 'level_name' },
          { field: 'progress', id: 'level_progress' },
        ]),
      ],
    })),
    'hr.skill.list': list(Skill, { columns: ['name', 'type'] }),
    'hr.skill.form': form(Skill, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'type'])],
    })),
    'hr.skill.level.list': list(SkillLevel, { columns: ['type', 'name', 'progress'] }),
    'hr.skill.level.form': form(SkillLevel, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['type', 'name', 'progress'])],
    })),
  },
  search: {
    'hr.appraisal': search(Appraisal, {
      fields: ['name', 'employee.name', 'reviewer.name'],
      filters: {
        self: { label: 'Waiting for the self review', domain: { state: 'self' }, group: 'state' },
        review: { label: 'Waiting for the reviewer', domain: { state: 'review' }, group: 'state' },
        done: { label: 'Completed', domain: { state: 'done' }, group: 'state' },
      },
      groupBy: ['state', 'cycle', 'reviewer', 'rating'],
    }),
    'hr.appraisal.cycle': search(AppraisalCycle, { fields: ['name'], groupBy: ['state'] }),
    'hr.appraisal.goal': search(AppraisalGoal, {
      fields: ['name', 'appraisal.name'],
      groupBy: ['appraisal'],
    }),
    'hr.employee.skill': search(EmployeeSkill, {
      fields: ['employee.name', 'skill.name'],
      groupBy: ['skill', 'level', 'employee'],
    }),
    'hr.skill.type': search(SkillType, { fields: ['name'] }),
    'hr.skill': search(Skill, { fields: ['name', 'type.name'], groupBy: ['type'] }),
    'hr.skill.level': search(SkillLevel, { fields: ['name', 'type.name'], groupBy: ['type'] }),
  },
});
