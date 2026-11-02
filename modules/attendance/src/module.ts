/**
 * The data layer of Attendance (RFC 0024 §2.2): shifts (hours, break, grace, overtime after so many minutes and in
 * steps, the overtime rate; night shifts end after midnight), rosters that assign them, sites with a geofence,
 * punches (`attendance.record`) from the phone, the kiosk or a device file, public holidays, and the **attendance
 * day** of each person — worked hours, late arrival, early leave, absence, leave and holidays from Workforce,
 * overtime — computed by `days.ts` and approved by HR before Payroll reads it.
 *
 * People see their own punches and days; Attendance managers everyone's. A kiosk device signs in with the kiosk
 * group and identifies people by badge or PIN; it reads nothing else.
 */
import { hrShutro } from '@kosh/hr';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  record,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const MANAGERS = ['attendance.manager'];
const me = { $env: 'uid' } as const;
const HHMM = orm.sql`~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`;

export const AttendanceShift = defineModel('attendance.shift', {
  label: 'Shift',
  recName: 'name',
  order: ['start asc', 'name asc'],
  archivable: true,
  // Shared by every company (seed data is installed before any company exists).
  access: { 'attendance.user': READ, 'attendance.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    start: f.char({ size: 5, required: true, default: '09:00', label: 'Starts (HH:MM)' }),
    end: f.char({
      size: 5,
      required: true,
      default: '18:00',
      label: 'Ends (HH:MM)',
      help: 'Earlier than the start: the shift ends the next day (a night shift).',
    }),
    breakMinutes: f.integer({ required: true, default: 60, label: 'Break (minutes)' }),
    graceMinutes: f.integer({
      required: true,
      default: 10,
      label: 'Grace (minutes)',
      help: 'Arrivals within these minutes after the start are not late.',
    }),
    overtimeAfter: f.integer({
      required: true,
      default: 30,
      label: 'Overtime after (minutes)',
      help: 'Work beyond the shift counts as overtime once it passes these minutes.',
    }),
    overtimeStep: f.integer({
      required: true,
      default: 30,
      label: 'Overtime in steps of (minutes)',
      help: 'Overtime is counted down to whole steps (30: half hours).',
    }),
    overtimeRate: f.decimal({
      scale: 2,
      required: true,
      default: '2',
      label: 'Overtime rate',
      help: 'Times the hourly basic (Bangladesh Labour Act: twice), for Payroll.',
    }),
  },
  sqlConstraints: {
    times: {
      check: orm.sql`start ${HHMM} AND "end" ${HHMM}`,
      message: 'Times are written HH:MM, from 00:00 to 23:59.',
    },
    minutes: {
      check: orm.sql`break_minutes >= 0 AND grace_minutes >= 0 AND overtime_after >= 0 AND overtime_step > 0`,
      message: 'Minutes are not negative; the overtime step is at least one minute.',
    },
  },
});

export const AttendanceRoster = defineModel('attendance.roster', {
  label: 'Roster',
  order: ['dateFrom desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['shift', 'dateFrom', 'dateTo'],
  access: { 'attendance.user': READ, 'attendance.manager': [...ALL, 'export', 'import'] },
  rules: {
    own: { groups: ['attendance.user'], perms: ['read'], domain: { 'employee.user': me } },
    all: { groups: ['attendance.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    shift: f.many2one('attendance.shift', { required: true, ondelete: 'restrict' }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    note: f.char(),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`date_to >= date_from`,
      message: 'A roster ends on or after it starts.',
    },
  },
  constraints: {
    // One shift a day: rosters of a person do not overlap.
    noOverlap: {
      ...check('attendance.roster', ['employee', 'dateFrom', 'dateTo'], async (rosters) =>
        rosters.env.asSuperuser({ reason: 'overlapping rosters' }, async (su) => {
          const failing: number[] = [];
          for (const r of rosters) {
            const clash = await su.model('attendance.roster').search({
              where: {
                employee: r.employee.id,
                id: { ne: r.id },
                dateFrom: { lte: r.dateTo },
                dateTo: { gte: r.dateFrom },
              },
              limit: 1,
            });
            if (clash.length > 0) failing.push(r.id);
          }
          return failing;
        }),
      ),
      message: 'This person is already on another roster for some of these days.',
    },
  },
});

export const AttendanceSite = defineModel('attendance.site', {
  label: 'Site',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: {
    'attendance.user': READ,
    'attendance.kiosk': READ,
    'attendance.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true }),
    latitude: f.decimal({ scale: 6 }),
    longitude: f.decimal({ scale: 6 }),
    radius: f.integer({
      required: true,
      default: 150,
      label: 'Radius (metres)',
      help: 'Check-ins from a phone count at this site within this distance.',
    }),
    geofence: f.boolean({
      default: true,
      label: 'Phones check in on site only',
      help: 'Refuse phone check-ins outside the radius (the location is kept only as inside or outside and the distance).',
    }),
  },
  sqlConstraints: {
    position: {
      check: orm.sql`(latitude IS NULL) = (longitude IS NULL) AND radius > 0`,
      message: 'A site has both coordinates or neither, and a positive radius.',
    },
  },
});

export const AttendanceRecord = defineModel('attendance.record', {
  label: 'Attendance',
  order: ['checkIn desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['checkIn', 'checkOut'],
  access: {
    'attendance.user': READ,
    'attendance.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    own: { groups: ['attendance.user'], perms: ['read'], domain: { 'employee.user': me } },
    all: { groups: ['attendance.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    checkIn: f.datetime({ required: true, label: 'Check-in' }),
    checkOut: f.datetime({ label: 'Check-out' }),
    source: f.selection(
      { phone: 'Phone', kiosk: 'Kiosk', device: 'Device file', manual: 'By hand' },
      {
        required: true,
        default: 'manual',
        help: 'Where the punch came from; a punch by hand is recorded with who made it.',
      },
    ),
    site: f.many2one('attendance.site', { ondelete: 'set null' }),
    inside: f.boolean({
      default: true,
      label: 'On site',
      help: 'Off only for a phone check-in outside the radius of a site without a geofence.',
    }),
    distance: f.integer({ label: 'Distance (metres)', help: 'Phone check-ins: from the site.' }),
    workedHours: f.decimal({
      scale: 2,
      label: 'Hours',
      help: 'From the check-in to the check-out.',
      ...compute('attendance.record', 'workedHours', ['checkIn', 'checkOut'], (punches) => {
        for (const p of punches)
          p.workedHours =
            p.checkOut === null
              ? null
              : orm
                  .toDecimal(p.checkOut.getTime() - p.checkIn.getTime())
                  .div(3_600_000)
                  .toDecimalPlaces(2);
      }),
      store: true,
    }),
    note: f.char(),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`check_out IS NULL OR check_out > check_in`,
      message: 'A check-out comes after its check-in.',
    },
    oneOpen: {
      unique: ['employee'],
      where: orm.sql`check_out IS NULL`,
      message: 'This person is already checked in.',
    },
  },
  constraints: {
    noOverlap: {
      ...check('attendance.record', ['employee', 'checkIn', 'checkOut'], async (punches) =>
        punches.env.asSuperuser({ reason: 'overlapping punches' }, async (su) => {
          const failing: number[] = [];
          for (const p of punches) {
            const end = p.checkOut ?? new Date(p.checkIn.getTime() + 1);
            const clash = await su.model('attendance.record').search({
              where: {
                employee: p.employee.id,
                id: { ne: p.id },
                checkIn: { lt: end },
                checkOut: { gt: p.checkIn },
              },
              limit: 1,
            });
            if (clash.length > 0) failing.push(p.id);
          }
          return failing;
        }),
      ),
      message: 'This overlaps another check-in of the same person.',
    },
  },
});

export const AttendanceHoliday = defineModel('attendance.holiday', {
  label: 'Public holiday',
  recName: 'name',
  order: ['date asc'],
  companyScoped: { required: true },
  access: { 'attendance.user': READ, 'attendance.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    date: f.date({ required: true }),
  },
  sqlConstraints: {
    oneADay: { unique: ['company', 'date'], message: 'There is already a holiday on this date.' },
  },
});

const DAY_STATUS = {
  present: 'Present',
  absent: 'Absent',
  leave: 'On leave',
  holiday: 'Holiday',
  weekend: 'Weekend',
  incomplete: 'Check-out missing',
  off: 'No shift',
} as const;

export const AttendanceDay = defineModel('attendance.day', {
  label: 'Attendance day',
  order: ['date desc', 'employee asc'],
  companyScoped: { required: true },
  tracking: ['state', 'overtimeApproved'],
  access: {
    'attendance.user': READ,
    'attendance.manager': [...ALL, 'export'],
  },
  rules: {
    own: { groups: ['attendance.user'], perms: ['read'], domain: { 'employee.user': me } },
    all: { groups: ['attendance.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    employee: f.many2one('hr.employee', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true }),
    shift: f.many2one('attendance.shift', { ondelete: 'set null' }),
    status: f.selection(DAY_STATUS, {
      required: true,
      default: 'present',
      help: 'From the punches, the roster, the weekend, public holidays and approved leave.',
    }),
    firstIn: f.datetime({ label: 'First in' }),
    lastOut: f.datetime({ label: 'Last out' }),
    workedHours: f.decimal({ scale: 2, required: true, default: '0', label: 'Worked (hours)' }),
    expectedHours: f.decimal({ scale: 2, required: true, default: '0', label: 'Expected (hours)' }),
    lateMinutes: f.integer({ required: true, default: 0, label: 'Late (minutes)' }),
    earlyMinutes: f.integer({ required: true, default: 0, label: 'Left early (minutes)' }),
    overtimeHours: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Overtime (hours)',
      help: 'Beyond the shift past its threshold, in its steps; all hours worked on weekends and holidays.',
    }),
    overtimeApproved: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Overtime approved (hours)',
      help: 'What Payroll pays; set to the overtime on approval, lowered by the approver when needed.',
    }),
    overtimeRate: f.decimal({ scale: 2, required: true, default: '2', label: 'Overtime rate' }),
    state: f.state({
      states: { draft: 'To review', approved: 'Approved' },
      initial: 'draft',
      help: 'Approved days are locked and read by Payroll; recomputing leaves them as they are.',
      transitions: {
        approve: {
          from: ['draft'],
          to: 'approved',
          requires: 'attendance.approve',
          guard: records('attendance.day', (days) => notOwn(days)),
          message: 'Someone else approves your attendance.',
          after: records('attendance.day', async (days) => {
            for (const id of days.ids) await days.env.emit('attendance.day.approved', { id });
          }),
        },
        reopen: { from: ['approved'], to: 'draft', requires: 'attendance.approve' },
      },
    }),
  },
  sqlConstraints: {
    oneADay: { unique: ['employee', 'date'], message: 'One attendance day per person and date.' },
    approvedWithin: {
      check: orm.sql`overtime_approved >= 0 AND overtime_approved <= overtime_hours`,
      message: 'Approved overtime is between none and the overtime worked.',
    },
  },
});

/** The days among `records` of the acting user's own employee. */
async function notOwn(records: unknown): Promise<number[]> {
  const { env, ids } = records as { env: Env; ids: readonly number[] };
  return env.asSuperuser({ reason: 'own attendance' }, async (su) => {
    const days = (
      await su
        .model('attendance.day')
        .browse([...ids] as never)
        .load(['employee'])
    ).read(['id', 'employee']);
    const people = new Map(
      (
        await su
          .model('hr.employee')
          .browse(days.map((d) => d['employee'] as never))
          .load(['user'])
      )
        .read(['id', 'user'])
        .map((e) => [e['id'], e['user']]),
    );
    return days.filter((d) => people.get(d['employee']) === env.uid).map((d) => d['id'] as number);
  });
}

/** Each employee's attendance details: the default shift, the kiosk PIN (hashed), the badge and the device user. */
export const EmployeeAttendance = extendModel('hr.employee', {
  fields: {
    attendanceShift: f.many2one('attendance.shift', {
      ondelete: 'set null',
      label: 'Usual shift',
      help: 'The shift on days without a roster.',
    }),
    attendancePin: f.char({
      size: 200,
      label: 'Kiosk PIN (hashed)',
      groups: { read: MANAGERS, write: MANAGERS },
    }),
    attendanceBadge: f.char({
      size: 64,
      label: 'Badge',
      help: 'The code on the person’s badge (QR or barcode), scanned at the kiosk.',
      groups: { read: MANAGERS, write: MANAGERS },
    }),
    deviceUserId: f.char({
      size: 32,
      label: 'Device user ID',
      help: 'The person’s number on the attendance device (ZKTeco user ID).',
      groups: { read: MANAGERS, write: MANAGERS },
    }),
  },
});

export const attendanceShutro = defineModule({
  name: 'attendance',
  version: '0.1.0',
  depends: [hrShutro],
  groups: [
    orm.defineGroup({ code: 'attendance.user', label: 'Attendance: own', implies: ['hr.user'] }),
    orm.defineGroup({
      code: 'attendance.manager',
      label: 'Attendance manager',
      implies: ['attendance.user'],
    }),
    orm.defineGroup({
      code: 'attendance.kiosk',
      label: 'Attendance kiosk (a device at the gate)',
      implies: [],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'attendance.approve',
      label: 'Approve attendance days and overtime',
      groups: ['attendance.manager'],
    }),
  ],
  models: [
    AttendanceShift,
    AttendanceRoster,
    AttendanceSite,
    AttendanceRecord,
    AttendanceHoliday,
    AttendanceDay,
  ],
  extensions: [EmployeeAttendance],
  data: [
    record(
      'attendance.shift',
      'shift_general',
      { name: 'General', start: '09:00', end: '18:00', breakMinutes: 60 },
      { noupdate: true },
    ),
    record(
      'attendance.shift',
      'shift_night',
      { name: 'Night', start: '22:00', end: '06:00', breakMinutes: 30 },
      { noupdate: true },
    ),
  ],
});
