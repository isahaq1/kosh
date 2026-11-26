/**
 * @packageDocumentation
 * `@kosh/attendance` (RFC 0024 §2.2): the **Attendance** app. Shifts and rosters, check-in from the phone inside a
 * site's geofence or at a kiosk by badge or PIN, punches imported from devices (ZKTeco's log, a CSV), public
 * holidays, and each person's day — worked, late, early, absent, on leave, overtime in the shift's steps — approved
 * by HR before Payroll reads it.
 */
import { hr } from '@kosh/hr';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import type { ModuleContext } from '@kosh/server';
import { action, calendar, field, form, list, pivot, search, stat } from '@kosh/views';
import { attendanceDemo } from './demo.js';
import { registerDeviceRoutes } from './devices.js';
import {
  AttendanceDay,
  AttendanceDevice,
  AttendanceDevicePunch,
  AttendanceRecord,
  AttendanceRoster,
  AttendanceShift,
  AttendanceSite,
  AttendanceSwap,
  attendanceShutro,
} from './module.js';
import { registerAttendanceRoutes } from './routes.js';

export {
  addDays,
  computeDay,
  DAYS_CHUNK,
  type DayInput,
  type DayResult,
  DEVICE_FORMATS,
  type DeviceFormat,
  distanceMetres,
  importPunches,
  instantOf,
  localDate,
  punch,
  recomputeDays,
  shiftMinutes,
  timeZoneOf,
} from './days.js';
export {
  PENDING_LIMIT,
  type PushedPunch,
  parseAttlog,
  replayPunches,
  takePunches,
} from './devices.js';
export {
  AttendanceDay,
  AttendanceDevice,
  AttendanceDevicePunch,
  AttendanceRecord,
  AttendanceRoster,
  AttendanceShift,
  AttendanceSite,
  AttendanceSwap,
  attendanceShutro,
  EmployeeAttendance,
} from './module.js';
export {
  attendanceWorker,
  DAYS_JOB,
  enqueueDays,
  enqueueYesterday,
  INLINE_PERSON_DAYS,
} from './routes.js';

export const attendance: ReturnType<typeof defineModule> = defineModule({
  shutro: attendanceShutro,
  kosh: '^0.1.0',
  hooks: { demo: attendanceDemo },
  depends: [hr, reporting],
  app: {
    code: 'attendance',
    label: 'Attendance',
    icon: 'attendance',
    sequence: 21,
    category: 'People',
    summary: 'Shifts, check-in by phone, kiosk or device, overtime',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Employee (own check-ins and days)', groups: ['attendance.user'] },
    manager: {
      label: 'Attendance manager (everyone, approvals, imports)',
      groups: ['attendance.manager'],
      implies: ['user'],
    },
    kiosk: { label: 'Kiosk (a device at the gate)', groups: ['attendance.kiosk'] },
  },
  routes: (context: ModuleContext) => {
    registerAttendanceRoutes(context);
    // Machines that push their punches (RFC 0037 §2).
    registerDeviceRoutes(context);
  },
  settings: {
    sections: [
      {
        key: 'clock',
        label: 'Time zone',
        description:
          'Where the people work: days start at midnight here, shifts are read in its hours.',
        keywords: 'timezone time zone dhaka kolkata clock',
        scope: 'installation',
        editors: ['attendance.manager'],
        fields: [
          {
            key: 'timezone',
            type: 'char',
            label: 'Time zone',
            default: 'Asia/Dhaka',
            help: 'An IANA name such as Asia/Dhaka or Asia/Kolkata.',
          },
        ],
      },
    ],
  },
  events: [
    { topic: 'attendance.day.approved', model: 'attendance.day', label: 'Attendance day approved' },
    { topic: 'attendance.swap.submitted', model: 'attendance.swap', label: 'Shift swap asked' },
    {
      topic: 'attendance.swap.accepted',
      model: 'attendance.swap',
      label: 'Shift swap accepted by the colleague',
    },
    { topic: 'attendance.swap.approved', model: 'attendance.swap', label: 'Shift swap approved' },
    { topic: 'attendance.swap.cancelled', model: 'attendance.swap', label: 'Shift swap cancelled' },
  ],
  documents: [
    {
      key: 'shift_swap',
      name: 'Shift swap',
      model: 'attendance.swap',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Shift swap {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Date', bind: 'date' },
              { label: 'Asked by', bind: 'employee.name' },
              { label: 'Their planned shift', bind: 'shift.name' },
              { label: 'Swaps with', bind: 'withEmployee.name' },
              { label: 'The colleague’s planned shift', bind: 'withShift.name' },
              { label: 'Status', bind: 'state' },
            ],
          },
          { kind: 'text', id: 'reason', text: '{{reason}}' },
          { kind: 'text', id: 'note', text: '{{decisionNote}}' },
        ],
      },
    },
    {
      key: 'attendance_badge',
      name: 'Attendance badge',
      model: 'hr.employee',
      layout: {
        paper: 'A4',
        blocks: [
          { kind: 'heading', id: 'company', text: '{{company.name}}', level: 3 },
          { kind: 'heading', id: 'name', text: '{{name}}', level: 2 },
          {
            kind: 'fields',
            id: 'about',
            items: [
              { label: 'Position', bind: 'jobTitle' },
              { label: 'Department', bind: 'department.name' },
            ],
          },
          // The kiosk reads either: a camera the QR code, a hand scanner the bars.
          { kind: 'qr', id: 'qr', bind: 'attendanceBadge', size: 32, label: 'Scan at the kiosk' },
          { kind: 'barcode', id: 'barcode', bind: 'attendanceBadge', size: 55, height: 14 },
        ],
      },
    },
    {
      key: 'attendance_register',
      name: 'Attendance register',
      model: 'attendance.day',
      scope: 'list',
      layout: {
        paper: 'A4',
        orientation: 'landscape',
        header: '{{company.name}} — Attendance register',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Attendance register', level: 1 },
          {
            kind: 'table',
            id: 'days',
            bind: '$records',
            columns: [
              { label: 'Date', bind: 'date' },
              { label: 'Employee', bind: 'employee.name' },
              { label: 'Shift', bind: 'shift.name' },
              { label: 'Status', bind: 'status' },
              { label: 'In', bind: 'firstIn' },
              { label: 'Out', bind: 'lastOut' },
              { label: 'Worked', bind: 'workedHours' },
              { label: 'Late (min)', bind: 'lateMinutes' },
              { label: 'Overtime', bind: 'overtimeApproved' },
            ],
          },
          {
            kind: 'text',
            id: 'sign',
            text: 'Checked by: ______________________   Date: __________',
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'punches',
      model: 'attendance.record',
      label: 'Check-ins',
      columns: [
        { header: 'Employee', field: 'employee' },
        { header: 'Check-in', field: 'checkIn' },
        { header: 'Check-out', field: 'checkOut' },
        { header: 'Note', field: 'note' },
      ],
    },
    {
      key: 'rosters',
      model: 'attendance.roster',
      label: 'Rosters',
      columns: [
        { header: 'Employee', field: 'employee' },
        { header: 'Shift', field: 'shift' },
        { header: 'From', field: 'dateFrom' },
        { header: 'To', field: 'dateTo' },
      ],
    },
    {
      key: 'swaps',
      model: 'attendance.swap',
      label: 'Shift swaps',
      columns: [
        { header: 'Asked by', field: 'employee' },
        { header: 'Swaps with', field: 'withEmployee' },
        { header: 'Date', field: 'date' },
        { header: 'Why', field: 'reason' },
      ],
    },
    {
      key: 'devices',
      model: 'attendance.device',
      label: 'Devices',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Serial number', field: 'serial' },
        { header: 'Site', field: 'site' },
        { header: 'Status', field: 'status' },
        { header: 'Only from addresses', field: 'allowedAddresses' },
      ],
    },
    {
      key: 'shifts',
      model: 'attendance.shift',
      label: 'Shifts',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Code', field: 'code' },
        { header: 'Starts', field: 'start' },
        { header: 'Ends', field: 'end' },
        { header: 'Break (minutes)', field: 'breakMinutes' },
        { header: 'Grace (minutes)', field: 'graceMinutes' },
      ],
    },
    {
      key: 'sites',
      model: 'attendance.site',
      label: 'Sites',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Latitude', field: 'latitude' },
        { header: 'Longitude', field: 'longitude' },
        { header: 'Radius', field: 'radius' },
      ],
    },
  ],
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'attendance.day',
        reason: 'Days are computed from the check-ins, which import; they are never typed.',
      },
      {
        rule: 'I1',
        model: 'attendance.device.punch',
        reason: 'Punches are what the machines send, kept as received; never typed or imported.',
      },
    ],
  },
  overview: {
    cards: [
      {
        id: 'to_review',
        title: 'Days to review',
        kind: 'kpi',
        model: 'attendance.day',
        measure: 'count',
        filter: { state: 'draft' },
        w: 3,
      },
      {
        id: 'absences',
        title: 'Absences this month',
        kind: 'kpi',
        model: 'attendance.day',
        measure: 'count',
        filter: { status: 'absent' },
        comparison: { field: 'date', mode: 'previous' },
        w: 3,
      },
      {
        id: 'late',
        title: 'Late arrivals this month',
        kind: 'kpi',
        model: 'attendance.day',
        measure: 'count',
        filter: { lateMinutes: { gt: 0 } },
        comparison: { field: 'date', mode: 'previous' },
        w: 3,
      },
      {
        id: 'overtime',
        title: 'Overtime this month (hours)',
        kind: 'kpi',
        model: 'attendance.day',
        measure: 'sum:overtimeApproved',
        comparison: { field: 'date', mode: 'previous' },
        w: 3,
      },
      {
        id: 'by_status',
        title: 'Days by status',
        kind: 'chart',
        model: 'attendance.day',
        measure: 'count',
        groupBy: 'status',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'overtime_by_person',
        title: 'Overtime by person',
        kind: 'pivot',
        model: 'attendance.day',
        measure: 'sum:overtimeApproved',
        groupBy: 'employee',
        w: 6,
      },
    ],
  },
  actions: {
    'attendance.action_check': { type: 'client', page: 'attendance.Check', label: 'Check in' },
    'attendance.action_kiosk': { type: 'client', page: 'attendance.Kiosk', label: 'Kiosk' },
    'attendance.action_days': action(AttendanceDay, {
      label: 'Days',
      views: ['list', 'calendar', 'pivot', 'form'],
    }),
    'attendance.action_records': action(AttendanceRecord, {
      label: 'Check-ins',
      views: ['list', 'form'],
    }),
    'attendance.action_rosters': action(AttendanceRoster, {
      label: 'Rosters',
      views: ['list', 'calendar', 'form'],
    }),
    'attendance.action_swaps': action(AttendanceSwap, {
      label: 'Shift swaps',
      views: ['list', 'calendar', 'form'],
    }),
    'attendance.action_shifts': action(AttendanceShift, {
      label: 'Shifts',
      views: ['list', 'form'],
    }),
    'attendance.action_sites': action(AttendanceSite, { label: 'Sites', views: ['list', 'form'] }),
    'attendance.action_devices': action(AttendanceDevice, {
      label: 'Devices',
      views: ['list', 'form'],
    }),
    'attendance.action_device_punches': action(AttendanceDevicePunch, {
      label: 'Device punches',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'attendance.root', label: 'Attendance', app: 'attendance' },
    {
      id: 'attendance.check',
      parent: 'attendance.root',
      label: 'Check in',
      action: 'attendance.action_check',
      sequence: 1,
    },
    {
      id: 'attendance.days',
      parent: 'attendance.root',
      label: 'Days',
      action: 'attendance.action_days',
      sequence: 2,
    },
    {
      id: 'attendance.records',
      parent: 'attendance.root',
      label: 'Check-ins',
      action: 'attendance.action_records',
      sequence: 3,
    },
    {
      id: 'attendance.rosters',
      parent: 'attendance.root',
      label: 'Rosters',
      action: 'attendance.action_rosters',
      sequence: 4,
    },
    {
      id: 'attendance.swaps',
      parent: 'attendance.root',
      label: 'Shift swaps',
      action: 'attendance.action_swaps',
      sequence: 4,
    },
    {
      id: 'attendance.kiosk',
      parent: 'attendance.root',
      label: 'Kiosk',
      action: 'attendance.action_kiosk',
      sequence: 5,
      visibleTo: ['attendance.kiosk', 'attendance.manager'],
    },
    {
      id: 'attendance.configuration',
      parent: 'attendance.root',
      label: 'Configuration',
      sequence: 9,
    },
    {
      id: 'attendance.shifts',
      parent: 'attendance.configuration',
      label: 'Shifts',
      action: 'attendance.action_shifts',
      sequence: 1,
    },
    {
      id: 'attendance.devices',
      parent: 'attendance.configuration',
      label: 'Devices',
      action: 'attendance.action_devices',
      sequence: 4,
    },
    {
      id: 'attendance.device_punches',
      parent: 'attendance.configuration',
      label: 'Device punches',
      action: 'attendance.action_device_punches',
      sequence: 5,
    },
    {
      id: 'attendance.sites',
      parent: 'attendance.configuration',
      label: 'Sites',
      action: 'attendance.action_sites',
      sequence: 2,
    },
    {
      id: 'attendance.holidays',
      parent: 'attendance.configuration',
      label: 'Public holidays',
      // The company's holidays are Working time's: the menu opens them there.
      action: 'worktime.action_holidays',
      sequence: 3,
    },
  ],
  views: {
    'attendance.day.list': list(AttendanceDay, {
      columns: [
        'date',
        'employee',
        'shift',
        'status',
        'workedHours',
        'lateMinutes',
        'earlyMinutes',
        'overtimeHours',
        'overtimeApproved',
        'state',
      ],
      defaultOrder: ['date desc'],
      inlineEdit: ['overtimeApproved'],
      decorations: {
        danger: { status: 'absent' },
        warning: { status: 'incomplete' },
        info: { lateMinutes: { gt: 0 } },
      },
    }),
    'attendance.day.calendar': calendar(AttendanceDay, {
      dateStart: 'date',
      title: 'employee',
      color: 'status',
    }),
    'attendance.day.pivot': pivot(AttendanceDay, {
      rows: ['employee'],
      cols: ['status'],
      measures: ['count'],
    }),
    'attendance.day.form': form(AttendanceDay, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('approve', { primary: true, label: 'Approve' }),
          k.button('reopen', { label: 'Reopen' }),
        ],
      },
      readonlyWhen: { state: 'approved' },
      sheet: [
        k.group('main', ['employee', 'date', 'shift', 'status']),
        k.group('times', ['firstIn', 'lastOut', 'workedHours', 'expectedHours'], {
          label: 'Times',
        }),
        k.group(
          'exceptions',
          ['lateMinutes', 'earlyMinutes', 'overtimeHours', 'overtimeApproved', 'overtimeRate'],
          {
            label: 'Exceptions and overtime',
            description:
              'Lower the approved overtime before approving if part of it was not asked for.',
          },
        ),
      ],
      chatter: true,
    })),
    'attendance.record.list': list(AttendanceRecord, {
      columns: [
        'employee',
        'checkIn',
        'checkOut',
        'workedHours',
        'source',
        'site',
        'inside',
        'distance',
      ],
      defaultOrder: ['checkIn desc'],
      decorations: { warning: { inside: false } },
    }),
    'attendance.record.form': form(AttendanceRecord, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['employee', 'checkIn', 'checkOut', 'workedHours', 'note']),
        k.group('where', ['source', 'site', 'inside', 'distance'], { label: 'Where from' }),
      ],
    })),
    'attendance.roster.list': list(AttendanceRoster, {
      columns: ['employee', 'shift', 'dateFrom', 'dateTo', 'note'],
    }),
    'attendance.roster.calendar': calendar(AttendanceRoster, {
      dateStart: 'dateFrom',
      dateStop: 'dateTo',
      title: 'employee',
      color: 'shift',
    }),
    'attendance.roster.form': form(AttendanceRoster, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['employee', 'shift', 'dateFrom', 'dateTo', 'note'])],
    })),
    'attendance.swap.list': list(AttendanceSwap, {
      columns: [
        'name',
        'date',
        'employee',
        'shift',
        'withEmployee',
        'withShift',
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['date desc'],
      decorations: {
        success: { state: 'approved' },
        warning: { state: { in: ['submitted', 'accepted'] } },
        danger: { state: { in: ['declined', 'refused'] } },
        neutral: { state: 'cancelled' },
      },
    }),
    'attendance.swap.calendar': calendar(AttendanceSwap, {
      dateStart: 'date',
      title: 'employee',
      color: 'state',
      mode: 'month',
    }),
    'attendance.swap.form': form(AttendanceSwap, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Ask the colleague' }),
          k.button('accept', { primary: true, label: 'Accept' }),
          k.button('decline', { label: 'Decline' }),
          k.button('approve', { primary: true, label: 'Approve' }),
          k.button('refuse', { label: 'Refuse' }),
          k.button('cancel', {
            label: 'Cancel the swap',
            confirm: 'Cancel this approved swap? Both go back to their planned shifts.',
          }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'date', 'state']),
        k.group('who', ['employee', 'shift', 'withEmployee', 'withShift'], {
          label: 'Who swaps',
          description:
            'The two shifts are written down when the swap is asked. Approved, each works the other’s shift that day.',
        }),
        k.group('why', ['reason'], { columns: 1 }),
        k.group('decision', ['decisionNote'], {
          columns: 1,
          description: 'Needed to decline, refuse or cancel: write it, then press the button.',
        }),
      ],
      chatter: true,
    })),
    'attendance.shift.list': list(AttendanceShift, {
      columns: [
        'name',
        'code',
        'start',
        'end',
        'breakMinutes',
        'graceMinutes',
        'overtimeAfter',
        'overtimeRate',
      ],
    }),
    'attendance.shift.form': form(AttendanceShift, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'code', 'start', 'end', 'breakMinutes', 'graceMinutes']),
        k.group('overtime', ['overtimeAfter', 'overtimeStep', 'overtimeRate'], {
          label: 'Overtime',
        }),
      ],
    })),
    'attendance.site.list': list(AttendanceSite, {
      columns: ['name', 'latitude', 'longitude', 'radius', 'geofence'],
    }),
    'attendance.device.list': list(AttendanceDevice, {
      columns: [
        'name',
        'serial',
        'site',
        { field: 'status', widget: 'badge' },
        'lastSeenAt',
        'lastPunchAt',
      ],
      decorations: { warning: { status: 'pending' } },
    }),
    'attendance.device.form': form(AttendanceDevice, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'serial', 'protocol', 'status', 'site'], {
          description:
            'On the machine, set this server’s address and port (Comm › Cloud Server Setting). Its punches arrive by themselves once it is Active.',
        }),
        k.group('safety', ['allowedAddresses'], {
          label: 'Safety',
          description:
            'The machine’s protocol has no password: its serial number is all it says. Limit it to the site’s address where you can.',
        }),
        k.group('seen', ['lastSeenAt', 'lastAddress', 'lastPunchAt', 'stamp'], {
          label: 'Last heard of',
        }),
      ],
    })),
    'attendance.device.punch.list': list(AttendanceDevicePunch, {
      columns: ['at', 'device', 'userCode', 'employee', { field: 'outcome', widget: 'badge' }],
      decorations: {
        warning: { outcome: { in: ['unknown', 'unpaired'] } },
        neutral: { outcome: { in: ['duplicate', 'late'] } },
      },
    }),
    'attendance.device.punch.form': form(AttendanceDevicePunch, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['device', 'userCode', 'localTime', 'at', 'employee', 'outcome'])],
    })),
    'attendance.site.form': form(AttendanceSite, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'latitude', 'longitude', 'radius', 'geofence'])],
    })),
  },
  viewExtensions: [
    {
      view: 'hr.employee.form',
      operations: [
        {
          insertAfter: 'contact',
          nodes: [
            {
              kind: 'group',
              id: 'attendance',
              label: 'Attendance',
              children: [
                field({ field: 'attendanceShift', id: 'employee_shift' }),
                field({ field: 'attendanceBadge', id: 'employee_badge' }),
                field({ field: 'deviceUserId', id: 'employee_device' }),
                { kind: 'component', id: 'employee_pin', component: 'attendance.Pin' },
              ],
            },
          ],
        },
        {
          append: 'related',
          nodes: [
            stat({
              id: 'employee_overtime',
              label: 'Overtime (hours)',
              model: 'attendance.day',
              where: { employee: { $record: 'id' }, state: 'approved' },
              measure: { sum: 'overtimeApproved' },
              action: 'attendance.action_days',
            }),
          ],
        },
      ],
    },
  ],
  search: {
    'attendance.day': search(AttendanceDay, {
      fields: ['employee.name'],
      filters: {
        mine: { label: 'Mine', domain: { 'employee.user': { $env: 'uid' } }, group: 'who' },
        to_review: { label: 'To review', domain: { state: 'draft' }, group: 'state' },
        absent: { label: 'Absent', domain: { status: 'absent' }, group: 'status' },
        late: { label: 'Late', domain: { lateMinutes: { gt: 0 } }, group: 'status' },
        incomplete: {
          label: 'Check-out missing',
          domain: { status: 'incomplete' },
          group: 'status',
        },
        overtime: {
          label: 'With overtime',
          domain: { overtimeHours: { gt: 0 } },
          group: 'overtime',
        },
      },
      groupBy: ['employee', 'status', 'shift', 'date:month'],
    }),
    'attendance.record': search(AttendanceRecord, {
      fields: ['employee.name', 'note'],
      filters: {
        open: { label: 'Checked in now', domain: { checkOut: { isNull: true } }, group: 'state' },
        outside: { label: 'Outside the site', domain: { inside: false }, group: 'where' },
      },
      groupBy: ['employee', 'source', 'site', 'checkIn:day'],
    }),
    'attendance.roster': search(AttendanceRoster, {
      fields: ['employee.name', 'shift.name'],
      groupBy: ['shift', 'employee'],
    }),
    'attendance.swap': search(AttendanceSwap, {
      fields: ['name', 'employee.name', 'withEmployee.name'],
      filters: {
        mine: {
          label: 'Mine',
          domain: {
            or: [{ 'employee.user': { $env: 'uid' } }, { 'withEmployee.user': { $env: 'uid' } }],
          },
          group: 'who',
        },
        for_me: {
          label: 'Waiting for my answer',
          domain: { 'withEmployee.user': { $env: 'uid' }, state: 'submitted' },
          group: 'state',
        },
        to_approve: { label: 'To approve', domain: { state: 'accepted' }, group: 'state' },
        approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' },
      },
      groupBy: ['state', 'employee', 'date:month'],
    }),
    'attendance.shift': search(AttendanceShift, { fields: ['name'] }),
    'attendance.site': search(AttendanceSite, { fields: ['name'] }),
    'attendance.device': search(AttendanceDevice, {
      fields: ['name', 'serial'],
      filters: {
        pending: { label: 'Waiting for approval', domain: { status: 'pending' }, group: 'status' },
        active: { label: 'Active', domain: { status: 'active' }, group: 'status' },
        off: { label: 'Off', domain: { status: 'off' }, group: 'status' },
      },
      groupBy: ['site', 'status'],
    }),
    'attendance.device.punch': search(AttendanceDevicePunch, {
      fields: ['userCode', 'employee.name', 'device.name'],
      filters: {
        unknown: { label: 'Unknown person', domain: { outcome: 'unknown' }, group: 'outcome' },
        unpaired: { label: 'Unpaired', domain: { outcome: 'unpaired' }, group: 'outcome' },
        counted: { label: 'Counted', domain: { outcome: 'applied' }, group: 'outcome' },
      },
      groupBy: ['device', 'employee', 'outcome', 'at:day'],
    }),
  },
});
