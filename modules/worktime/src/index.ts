/**
 * @packageDocumentation
 * `@kosh/worktime` (RFC 0034 §2.4): **Working time** — one model for everything that counts time. Calendars with
 * their week of hours and breaks, public holidays (once or every year, for a company or one calendar; the
 * fixed-date ones of Bangladesh and India come with the calendar) and personal exceptions. The apps count with its
 * engine: working days between two dates, the date so many working days later, working minutes between two
 * moments, the moment so many working minutes later, in the calendar's time zone.
 */
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { base } from '@kosh/server';
import { action, calendar, form, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { installWorkingTime } from './defaults.js';
import { worktimeDemo } from './demo.js';
import {
  WorkCalendar,
  WorkCalendarHours,
  WorkException,
  WorkHoliday,
  worktimeShutro,
} from './module.js';

export { addFixedHolidays, FIXED_HOLIDAYS, installWorkingTime } from './defaults.js';
export {
  COUNTRIES,
  STANDARD_WEEK,
  scheduleOf,
  WEEKDAY_NUMBER,
  WEEKDAYS,
  WorkCalendar,
  WorkCalendarHours,
  WorkException,
  WorkHoliday,
  worktimeShutro,
} from './module.js';
export * from './time.js';

export const worktime: ReturnType<typeof defineModule> = defineModule({
  shutro: worktimeShutro,
  kosh: '^0.1.0',
  hooks: {
    // Each company's calendar and its country's fixed holidays; idempotent (with every seed and app install).
    defaults: (env) => installWorkingTime(env as Env),
    demo: worktimeDemo,
  },
  depends: [base, reporting],
  app: {
    code: 'worktime',
    label: 'Working time',
    icon: 'worktime',
    sequence: 40,
    category: 'Human Resources',
    summary:
      'Working calendars, public holidays and personal exceptions — what every app counts time with',
  },
  importTemplates: [
    {
      key: 'work_calendar',
      model: 'work.calendar',
      label: 'Working calendar',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Time zone', field: 'tz' },
        { header: 'Public holidays of', field: 'country' },
        { header: 'Hours in a day', field: 'hoursPerDay' },
        { header: 'Hours › Day', field: 'hours.weekday' },
        { header: 'Hours › From', field: 'hours.fromTime' },
        { header: 'Hours › To', field: 'hours.toTime' },
      ],
    },
    {
      key: 'work_holiday',
      model: 'work.holiday',
      label: 'Holiday',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'From', field: 'dateFrom' },
        { header: 'To', field: 'dateTo' },
        { header: 'Every year', field: 'yearly' },
        { header: 'Only for the calendar', field: 'calendar' },
      ],
    },
    {
      key: 'work_exception',
      model: 'work.exception',
      label: 'Personal exception',
      columns: [
        { header: 'Person', field: 'user' },
        { header: 'From', field: 'dateFrom' },
        { header: 'To', field: 'dateTo' },
        { header: 'Kind', field: 'kind' },
        { header: 'From (HH:MM)', field: 'fromTime' },
        { header: 'To (HH:MM)', field: 'toTime' },
        { header: 'Reason', field: 'reason' },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User (sees calendars and holidays)', groups: ['worktime.user'] },
    manager: {
      label: 'Manager (sets calendars, holidays and exceptions)',
      groups: ['worktime.manager'],
      implies: ['user'],
    },
  },
  overview: {
    cards: [
      {
        id: 'calendars',
        title: 'Calendars',
        kind: 'kpi',
        model: 'work.calendar',
        measure: 'count',
        w: 4,
      },
      {
        id: 'holidays',
        title: 'Holidays',
        kind: 'kpi',
        model: 'work.holiday',
        measure: 'count',
        w: 4,
      },
      {
        id: 'exceptions',
        title: 'Personal exceptions',
        kind: 'kpi',
        model: 'work.exception',
        measure: 'count',
        w: 4,
      },
      {
        id: 'next_holidays',
        title: 'Holidays by date',
        kind: 'list',
        model: 'work.holiday',
        measure: 'count',
        w: 6,
      },
      {
        id: 'exceptions_by_person',
        title: 'Exceptions by person',
        kind: 'chart',
        model: 'work.exception',
        measure: 'count',
        groupBy: 'user',
        chart: 'bar',
        w: 6,
      },
    ],
  },
  actions: {
    'worktime.action_calendars': action(WorkCalendar, {
      label: 'Calendars',
      views: ['list', 'form'],
    }),
    'worktime.action_holidays': action(WorkHoliday, {
      label: 'Holidays',
      views: ['list', 'calendar', 'form'],
    }),
    'worktime.action_exceptions': action(WorkException, {
      label: 'Personal exceptions',
      views: ['list', 'calendar', 'form'],
    }),
  },
  menus: [
    { id: 'worktime.root', label: 'Working time', app: 'worktime' },
    {
      id: 'worktime.calendars',
      parent: 'worktime.root',
      label: 'Calendars',
      action: 'worktime.action_calendars',
      sequence: 1,
    },
    {
      id: 'worktime.holidays',
      parent: 'worktime.root',
      label: 'Holidays',
      action: 'worktime.action_holidays',
      sequence: 2,
    },
    {
      id: 'worktime.exceptions',
      parent: 'worktime.root',
      label: 'Personal exceptions',
      action: 'worktime.action_exceptions',
      sequence: 3,
    },
  ],
  views: {
    'work.calendar.list': list(WorkCalendar, {
      columns: ['name', 'tz', 'country', 'hoursPerDay', 'isDefault'],
    }),
    'work.calendar.form': form(WorkCalendar, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'tz', 'country', 'hoursPerDay', 'isDefault']),
        k.lines('hours', ['weekday', 'fromTime', 'toTime']),
        k.lines('holidays', [
          { field: 'name', id: 'holiday_name' },
          'dateFrom',
          'dateTo',
          'yearly',
        ]),
      ],
    })),
    'work.calendar.hours.list': list(WorkCalendarHours, {
      columns: ['calendar', 'weekday', 'fromTime', 'toTime'],
    }),
    'work.calendar.hours.form': form(WorkCalendarHours, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['calendar', 'weekday', 'fromTime', 'toTime'])],
    })),
    'work.holiday.list': list(WorkHoliday, {
      columns: ['name', 'dateFrom', 'dateTo', 'yearly', 'calendar'],
      inlineEdit: ['name', 'dateFrom', 'dateTo', 'yearly'],
    }),
    'work.holiday.calendar': calendar(WorkHoliday, {
      dateStart: 'dateFrom',
      dateStop: 'dateTo',
      title: 'name',
      mode: 'month',
    }),
    'work.holiday.form': form(WorkHoliday, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'dateFrom', 'dateTo', 'yearly', 'calendar'])],
    })),
    'work.exception.list': list(WorkException, {
      columns: [
        'user',
        'dateFrom',
        'dateTo',
        { field: 'kind', widget: 'badge' },
        'fromTime',
        'toTime',
        'reason',
      ],
    }),
    'work.exception.calendar': calendar(WorkException, {
      dateStart: 'dateFrom',
      dateStop: 'dateTo',
      title: 'reason',
      color: 'user',
      mode: 'month',
    }),
    'work.exception.form': form(WorkException, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['user', 'dateFrom', 'dateTo', 'kind', 'reason']),
        k.group('hours', ['fromTime', 'toTime'], {
          description: 'Only for a day worked at hours of its own.',
        }),
      ],
    })),
  },
  search: {
    'work.calendar': search(WorkCalendar, {
      fields: ['name'],
      filters: {
        company: { label: 'The company’s calendar', domain: { isDefault: true } },
      },
      groupBy: ['country', 'tz'],
    }),
    'work.calendar.hours': search(WorkCalendarHours, {
      fields: ['calendar.name'],
      groupBy: ['calendar', 'weekday'],
    }),
    'work.holiday': search(WorkHoliday, {
      fields: ['name'],
      filters: {
        yearly: { label: 'Every year', domain: { yearly: true } },
        once: { label: 'One year only', domain: { yearly: false } },
      },
      groupBy: ['calendar', 'dateFrom:year'],
    }),
    'work.exception': search(WorkException, {
      fields: ['reason', 'user.name'],
      filters: {
        off: { label: 'Days off', domain: { kind: 'off' }, group: 'kind' },
        working: { label: 'Own hours', domain: { kind: 'working' }, group: 'kind' },
        mine: { label: 'Mine', domain: { user: { $env: 'uid' } } },
      },
      groupBy: ['user', 'kind', 'dateFrom:month'],
    }),
  },
});
