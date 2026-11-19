/**
 * The data layer of Working time (RFC 0034 §2.4): **calendars** — a week of hours, where a gap between two lines
 * of a day is a break —, **public holidays** — a date or a span, once or every year, for one calendar or all of a
 * company's — and **personal exceptions**: a person's day off, or a day they work hours of their own. One model for
 * everything that counts time; the apps read it through {@link scheduleOf} and the engine of `time.ts`.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { check, compute, defineModel, defineModule, type Env, f } from './.kosh/bindings.js';
import { addDays, type Interval, minutesOf, type Schedule, weekOf } from './time.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** Weekdays as the forms name them, with JavaScript's numbers (0: Sunday). */
export const WEEKDAYS = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
} as const;
export const WEEKDAY_NUMBER: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
/** Countries whose fixed public holidays ship with the app. */
export const COUNTRIES = { bd: 'Bangladesh', in: 'India' } as const;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const time = (value: unknown): number | null => {
  try {
    return minutesOf(String(value));
  } catch {
    return null;
  }
};

export const WorkCalendar = defineModel('work.calendar', {
  label: 'Working calendar',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'worktime.user': READ, 'worktime.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    tz: f.char({
      required: true,
      default: 'Asia/Dhaka',
      label: 'Time zone',
      help: 'An IANA time zone (Asia/Dhaka, Asia/Kolkata, Europe/London): the hours below are in it.',
    }),
    country: f.selection(COUNTRIES, {
      label: 'Public holidays of',
      help: 'Its fixed-date public holidays come with the calendar; add the ones that move each year yourself.',
    }),
    hoursPerDay: f.decimal({
      scale: 2,
      required: true,
      default: '8',
      label: 'Hours in a day',
      help: 'What a full working day is worth, where days and hours are converted (leave in hours, capacity).',
    }),
    isDefault: f.boolean({
      default: false,
      label: 'The company’s calendar',
      help: 'Used wherever no other calendar is chosen. One per company.',
    }),
    hours: f.one2many('work.calendar.hours', 'calendar', { label: 'Working hours' }),
    holidays: f.one2many('work.holiday', 'calendar', { label: 'Holidays of this calendar only' }),
  },
  constraints: {
    oneDefault: {
      ...check('work.calendar', ['isDefault', 'company', 'active'], async (calendars) =>
        calendars.env.asSuperuser({ reason: 'the company’s calendar' }, async (su) => {
          const failing: number[] = [];
          for (const c of calendars) {
            if (!c.isDefault) continue;
            const other = await su.model('work.calendar').search({
              where: { isDefault: true, company: c.company.id, id: { ne: c.id } },
              limit: 1,
            });
            if (other.length > 0) failing.push(c.id);
          }
          return failing;
        }),
      ),
      message: 'The company has its calendar already: untick it there first.',
    },
    realTimeZone: {
      ...check('work.calendar', ['tz'], async (calendars) =>
        [...calendars]
          .filter((c) => {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: c.tz });
              return false;
            } catch {
              return true;
            }
          })
          .map((c) => c.id),
      ),
      message: 'This is not a time zone (for example Asia/Dhaka).',
    },
  },
});

export const WorkCalendarHours = defineModel('work.calendar.hours', {
  label: 'Working hours',
  order: ['dayNumber asc', 'fromTime asc'],
  access: { 'worktime.user': READ, 'worktime.manager': ALL },
  fields: {
    calendar: f.many2one('work.calendar', { required: true, ondelete: 'cascade' }),
    weekday: f.selection(WEEKDAYS, {
      required: true,
      label: 'Day',
      help: 'The day of the week these hours are worked.',
    }),
    /** The day's number (0: Sunday), so that a week reads in order. */
    dayNumber: f.integer({
      store: true,
      label: 'Day number',
      ...compute('work.calendar.hours', 'dayNumber', ['weekday'], (lines) => {
        for (const l of lines) l.dayNumber = WEEKDAY_NUMBER[l.weekday] ?? 0;
      }),
    }),
    fromTime: f.char({ size: 5, required: true, default: '09:00', label: 'From (HH:MM)' }),
    toTime: f.char({
      size: 5,
      required: true,
      default: '17:00',
      label: 'To (HH:MM)',
      help: 'Two lines for a day make a break between them (09:00–13:00 and 14:00–18:00).',
    }),
  },
  constraints: {
    realHours: {
      ...check('work.calendar.hours', ['fromTime', 'toTime'], async (lines) =>
        [...lines]
          .filter((l) => {
            const from = time(l.fromTime);
            const to = time(l.toTime);
            return from === null || to === null || to <= from;
          })
          .map((l) => l.id),
      ),
      message: 'Hours are written HH:MM, and end after they start.',
    },
    noOverlap: {
      ...check(
        'work.calendar.hours',
        ['calendar', 'weekday', 'fromTime', 'toTime'],
        async (lines) => {
          const failing: number[] = [];
          for (const l of lines) {
            const same = await lines.env
              .model('work.calendar.hours')
              .search({ where: { calendar: l.calendar.id, weekday: l.weekday, id: { ne: l.id } } });
            const from = time(l.fromTime) ?? 0;
            const to = time(l.toTime) ?? 0;
            if ([...same].some((o) => (time(o.fromTime) ?? 0) < to && from < (time(o.toTime) ?? 0)))
              failing.push(l.id);
          }
          return failing;
        },
      ),
      message: 'These hours overlap other hours of the same day.',
    },
  },
});

export const WorkHoliday = defineModel('work.holiday', {
  label: 'Holiday',
  recName: 'name',
  order: ['dateFrom asc'],
  companyScoped: { required: true },
  access: { 'worktime.user': READ, 'worktime.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    yearly: f.boolean({
      default: false,
      label: 'Every year',
      help: 'On the same dates every year (Victory Day). Leave it off for holidays that move (Eid, Durga Puja).',
    }),
    calendar: f.many2one('work.calendar', {
      ondelete: 'cascade',
      label: 'Only for the calendar',
      help: 'Empty: a holiday of every calendar of the company.',
    }),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`date_to >= date_from`,
      message: 'A holiday ends on or after it starts.',
    },
  },
});

export const WorkException = defineModel('work.exception', {
  label: 'Personal exception',
  recName: 'reason',
  order: ['dateFrom desc'],
  companyScoped: { required: true },
  access: { 'worktime.user': READ, 'worktime.manager': ALL },
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade', label: 'Person' }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    kind: f.selection(
      { off: 'Does not work', working: 'Works these hours' },
      {
        required: true,
        default: 'off',
        help: 'A day off for this person, or a day they work hours of their own — also on a weekend or a holiday.',
      },
    ),
    fromTime: f.char({ size: 5, default: '09:00', label: 'From (HH:MM)' }),
    toTime: f.char({ size: 5, default: '17:00', label: 'To (HH:MM)' }),
    reason: f.char({ required: true }),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`date_to >= date_from`,
      message: 'An exception ends on or after it starts.',
    },
  },
  constraints: {
    realHours: {
      ...check('work.exception', ['kind', 'fromTime', 'toTime'], async (exceptions) =>
        [...exceptions]
          .filter((e) => {
            if (e.kind !== 'working') return false;
            const from = time(e.fromTime);
            const to = time(e.toTime);
            return from === null || to === null || to <= from;
          })
          .map((e) => e.id),
      ),
      message: 'Hours are written HH:MM, and end after they start.',
    },
  },
});

/** The week every company starts with: Sunday to Thursday, 09:00–13:00 and 14:00–18:00. */
export const STANDARD_WEEK: Schedule['week'] = weekOf(
  [5, 6],
  [
    [540, 780],
    [840, 1080],
  ],
);

/**
 * The schedule to count with between two dates: the calendar given — or the company's, or the standard week when
 * the company has none —, its holidays (the company's and its own, the yearly ones on each year of the span) and,
 * for a person, their exceptions. Read as the system: counting time needs no right of its own.
 */
export async function scheduleOf(
  env: Env,
  options: {
    readonly from: string;
    readonly to: string;
    /** A calendar's id; none: the company's calendar. */
    readonly calendar?: number | null;
    /** A person, for their exceptions. */
    readonly user?: number | null;
    /** The company whose calendar and holidays count; none: the one being worked in. */
    readonly company?: number | null;
  },
): Promise<Schedule & { readonly calendar: number | null; readonly hoursPerDay: number }> {
  return env.asSuperuser({ reason: 'working time' }, async (su) => {
    const found =
      options.calendar != null
        ? await su
            .model('work.calendar')
            .search({ where: { id: options.calendar as never }, limit: 1 })
        : await su.model('work.calendar').search({
            where: {
              isDefault: true,
              company: (options.company ?? (env.companyId as number)) as never,
            },
            limit: 1,
          });
    const [calendar] = [...(await found.load({ hours: true }))];
    const company = calendar?.company.id ?? options.company ?? (env.companyId as number);
    const week: Record<number, Interval[]> = {};
    for (let day = 0; day < 7; day += 1) week[day] = [];
    if (calendar === undefined) Object.assign(week, STANDARD_WEEK);
    else
      for (const line of calendar.hours) {
        const from = time(line.fromTime);
        const to = time(line.toTime);
        const day = WEEKDAY_NUMBER[line.weekday];
        if (from !== null && to !== null && to > from && day !== undefined)
          (week[day] as Interval[]).push([from, to]);
      }

    const off = new Set<string>();
    const each = (from: string, to: string, add: (date: string) => void) => {
      const start = from < options.from ? options.from : from;
      const end = to > options.to ? options.to : to;
      for (let d = start; d <= end; d = addDays(d, 1)) add(d);
    };
    const holidays = await su.model('work.holiday').search({
      where: {
        company: company as never,
        or: [
          { calendar: { isNull: true } },
          ...(calendar === undefined ? [] : [{ calendar: calendar.id }]),
        ],
      },
    });
    const firstYear = Number(options.from.slice(0, 4));
    const lastYear = Number(options.to.slice(0, 4));
    for (const h of holidays) {
      const from = iso(h.dateFrom);
      const to = iso(h.dateTo);
      if (!h.yearly) {
        each(from, to, (d) => off.add(d));
        continue;
      }
      // Every year of the span (and the one before: a holiday that starts in December may end in January).
      const length = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
      for (let year = firstYear - 1; year <= lastYear; year += 1) {
        const start = `${String(year).padStart(4, '0')}${from.slice(4)}`;
        // 29 February exists only in leap years.
        if (
          Number.isNaN(Date.parse(`${start}T00:00:00Z`)) ||
          !iso(new Date(`${start}T00:00:00Z`)).endsWith(from.slice(4))
        )
          continue;
        each(start, addDays(start, length), (d) => off.add(d));
      }
    }

    const extra = new Map<string, Interval[]>();
    if (options.user != null) {
      const exceptions = await su.model('work.exception').search({
        where: {
          user: options.user as never,
          dateFrom: { lte: options.to },
          dateTo: { gte: options.from },
        },
        order: ['id asc'],
      });
      for (const e of exceptions) {
        const from = time(e.fromTime);
        const to = time(e.toTime);
        each(iso(e.dateFrom), iso(e.dateTo), (d) => {
          if (e.kind === 'working' && from !== null && to !== null && to > from)
            extra.set(d, [[from, to]]);
          else {
            // A day off: whatever the week says, and over an earlier "works these hours".
            extra.delete(d);
            off.add(d);
          }
        });
      }
    }
    return {
      tz: calendar?.tz ?? 'Asia/Dhaka',
      week,
      off,
      extra,
      calendar: calendar?.id ?? null,
      hoursPerDay: Number(calendar?.hoursPerDay ?? 8),
    };
  });
}

export const worktimeShutro = defineModule({
  name: 'worktime',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
    orm.defineGroup({ code: 'worktime.user', label: 'Working time user', implies: ['base.user'] }),
    orm.defineGroup({
      code: 'worktime.manager',
      label: 'Working time manager',
      implies: ['worktime.user'],
    }),
  ],
  models: [WorkCalendar, WorkCalendarHours, WorkHoliday, WorkException],
});
