/**
 * Working time on real PostgreSQL through the HTTP API (RFC 0034 §2.4): a company starts with its calendar and its
 * country's fixed-date holidays; the schedule read from the database counts around the weekend, a yearly holiday
 * in any year, a company holiday, a holiday of one calendar only and a person's exceptions; hours that overlap or
 * are not hours, and a second calendar "of the company", are refused; managers set it up, users read it, people
 * without the app are refused.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  addWorkingDays,
  isWorkingDay,
  minutesOn,
  scheduleOf,
  workingDays,
  workingMinutesBetween,
  worktime,
} from '../src/index.js';

const CAL = '/api/v1/models/work.calendar';
const HOURS = '/api/v1/models/work.calendar.hours';
const HOLIDAY = '/api/v1/models/work.holiday';
const EXCEPTION = '/api/v1/models/work.exception';

let erp: TestInstallation;
// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  body?: unknown,
) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
type Options = Omit<Parameters<typeof scheduleOf>[1], 'from' | 'to'>;
/** The schedule the apps would count with, between two dates. */
const schedule = (from: string, to: string, options: Options = {}) =>
  erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, (env) =>
    scheduleOf(env as never, { from, to, ...options }),
  );
const userId = async (login: string): Promise<number> =>
  (
    await erp.host.server.driver.query<{ id: number }>({
      text: 'SELECT id FROM res_users WHERE login = $1',
      params: [login],
    })
  )[0]?.id as number;

beforeAll(async () => {
  erp = await testInstallation({
    modules: [worktime],
    users: {
      mina: ['worktime.manager'],
      rafi: ['worktime.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
}, 240_000);

afterAll(async () => {
  await erp?.close();
});

test('a company starts with its calendar and Bangladesh’s fixed-date holidays, every year', async () => {
  const calendars = (
    await call('GET', `${CAL}?fields=name,isDefault,country,tz,hoursPerDay`, 'rafi')
  ).json.items;
  expect(calendars).toMatchObject([
    { name: 'Standard week', isDefault: true, country: 'bd', tz: 'Asia/Dhaka' },
  ]);
  const holidays = (await call('GET', `${HOLIDAY}?fields=name,yearly&limit=50`, 'rafi')).json.items;
  expect(holidays.map((h: Json) => h.name).sort()).toEqual([
    'Bengali New Year',
    'Christmas Day',
    'Independence Day',
    'Language Martyrs’ Day',
    'May Day',
    'Victory Day',
  ]);
  expect(holidays.every((h: Json) => h.yearly === true)).toBe(true);

  // December 2026 in Dhaka: Sunday to Thursday, eight hours with a lunch break.
  const s = await schedule('2026-12-01', '2026-12-31');
  expect(s.tz).toBe('Asia/Dhaka');
  expect(s.hoursPerDay).toBe(8);
  expect(minutesOn(s, '2026-12-13')).toBe(480); // a Sunday
  expect(isWorkingDay(s, '2026-12-18')).toBe(false); // a Friday
  expect(isWorkingDay(s, '2026-12-16')).toBe(false); // Victory Day, a Wednesday
  expect(isWorkingDay(s, '2026-12-25')).toBe(false); // Christmas, and a Friday
  // 13 to 17 December: five weekdays less Victory Day.
  expect(workingDays(s, '2026-12-13', '2026-12-17')).toBe(4);
  expect(addWorkingDays(s, '2026-12-15', 1)).toBe('2026-12-17');
  // The same holiday in other years, from the one record.
  const later = await schedule('2031-12-01', '2032-03-31');
  expect(isWorkingDay(later, '2031-12-16')).toBe(false);
  expect(isWorkingDay(later, '2032-02-21')).toBe(false); // a Saturday anyway
  expect(isWorkingDay(later, '2032-03-25')).toBe(true); // the day before Independence Day, a Thursday
  expect(later.off.has('2032-03-26')).toBe(true);
});

test('a manager adds holidays; a user and someone without the app cannot', async () => {
  for (const who of ['rafi', 'bob'])
    expect(
      (
        await call('POST', HOLIDAY, who, {
          name: 'Mine',
          dateFrom: '2026-12-22',
          dateTo: '2026-12-22',
        })
      ).status,
      who,
    ).toBe(403);
  expect((await call('GET', CAL, 'bob')).status).toBe(403);
  expect((await call('GET', HOLIDAY, 'bob')).status).toBe(403);

  // Eid, as announced: three days, this year only.
  const eid = await call('POST', HOLIDAY, 'mina', {
    name: 'Eid-ul-Fitr',
    dateFrom: '2027-03-09',
    dateTo: '2027-03-11',
  });
  expect(eid.status, JSON.stringify(eid.json)).toBe(201);
  const s = await schedule('2027-03-01', '2027-03-31');
  // 7 (Sunday) to 11 (Thursday): only Sunday and Monday are worked.
  expect(workingDays(s, '2027-03-07', '2027-03-11')).toBe(2);
  expect(addWorkingDays(s, '2027-03-08', 1)).toBe('2027-03-14');
  // Not next year.
  expect(isWorkingDay(await schedule('2028-03-01', '2028-03-31'), '2028-03-09')).toBe(true);
  // A holiday that ends before it starts is refused.
  const backwards = await call('POST', HOLIDAY, 'mina', {
    name: 'Backwards',
    dateFrom: '2027-03-11',
    dateTo: '2027-03-09',
  });
  expect(backwards.status).toBeGreaterThanOrEqual(400);
  expect(backwards.status).toBeLessThan(500);
});

test('another calendar has its own hours and its own holidays; one calendar is the company’s', async () => {
  const made = await call('POST', CAL, 'mina', {
    name: 'Factory',
    tz: 'Asia/Dhaka',
    hoursPerDay: '7.5',
    hours: {
      create: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu'].map((weekday) => ({
        weekday,
        fromTime: '08:00',
        toTime: '15:30',
      })),
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const factory = made.json.id as number;
  // A holiday of the factory only: a maintenance shutdown.
  expect(
    (
      await call('POST', HOLIDAY, 'mina', {
        name: 'Shutdown',
        dateFrom: '2026-12-20',
        dateTo: '2026-12-20',
        calendar: factory,
      })
    ).status,
  ).toBe(201);
  const f = await schedule('2026-12-01', '2026-12-31', { calendar: factory });
  expect(f.calendar).toBe(factory);
  expect(f.hoursPerDay).toBe(7.5);
  expect(minutesOn(f, '2026-12-19')).toBe(450); // Saturday is worked there
  expect(isWorkingDay(f, '2026-12-20')).toBe(false); // its shutdown
  expect(isWorkingDay(f, '2026-12-16')).toBe(true); // it has no country: Victory Day belongs to the other calendar
  // The company's calendar does not know the shutdown.
  expect(isWorkingDay(await schedule('2026-12-01', '2026-12-31'), '2026-12-20')).toBe(true);

  // Hours that are not hours, that end before they start, or that overlap the day's other hours.
  for (const wrong of [
    { weekday: 'fri', fromTime: '9', toTime: '12:00' },
    { weekday: 'fri', fromTime: '14:00', toTime: '12:00' },
    { weekday: 'sat', fromTime: '15:00', toTime: '18:00' },
  ]) {
    const refused = await call('POST', HOURS, 'mina', { calendar: factory, ...wrong });
    expect(refused.status, JSON.stringify(wrong)).toBeGreaterThanOrEqual(400);
    expect(refused.status, JSON.stringify(refused.json)).toBeLessThan(500);
  }
  // Right after the day's hours is fine: an evening shift.
  expect(
    (
      await call('POST', HOURS, 'mina', {
        calendar: factory,
        weekday: 'sat',
        fromTime: '15:30',
        toTime: '18:00',
      })
    ).status,
  ).toBe(201);
  // A second calendar "of the company", and a time zone that is none.
  const second = await call('PATCH', `${CAL}/${factory}`, 'mina', { isDefault: true });
  expect(second.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(second.json)).toContain('has its calendar already');
  const noZone = await call('PATCH', `${CAL}/${factory}`, 'mina', { tz: 'Dhaka/Nowhere' });
  expect(noZone.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(noZone.json)).toContain('not a time zone');
});

test('a person’s exceptions: a day off, and a weekend day worked at their own hours', async () => {
  const rafi = await userId('rafi');
  for (const exception of [
    { dateFrom: '2026-12-14', dateTo: '2026-12-14', kind: 'off', reason: 'Family matter' },
    {
      dateFrom: '2026-12-19',
      dateTo: '2026-12-19',
      kind: 'working',
      fromTime: '10:00',
      toTime: '14:00',
      reason: 'Stock count',
    },
  ])
    expect(
      (await call('POST', EXCEPTION, 'mina', { user: rafi, ...exception })).status,
      exception.reason,
    ).toBe(201);
  const bad = await call('POST', EXCEPTION, 'mina', {
    user: rafi,
    dateFrom: '2026-12-21',
    dateTo: '2026-12-21',
    kind: 'working',
    fromTime: '14:00',
    toTime: '10:00',
    reason: 'Backwards',
  });
  expect(bad.status).toBeGreaterThanOrEqual(400);
  expect(bad.status).toBeLessThan(500);

  const his = await schedule('2026-12-13', '2026-12-19', { user: rafi });
  const everyone = await schedule('2026-12-13', '2026-12-19');
  expect(isWorkingDay(his, '2026-12-14')).toBe(false);
  expect(isWorkingDay(everyone, '2026-12-14')).toBe(true);
  expect(minutesOn(his, '2026-12-19')).toBe(240); // a Saturday, for him alone
  expect(isWorkingDay(everyone, '2026-12-19')).toBe(false);
  // His week: Sun, Tue, Thu and the Saturday (Mon off, Wed Victory Day).
  expect(workingDays(his, '2026-12-13', '2026-12-19')).toBe(4);
  expect(workingDays(everyone, '2026-12-13', '2026-12-19')).toBe(4); // Sun, Mon, Tue, Thu
  // Minutes follow the same schedule: his Saturday counts four hours (10:00–14:00 in Dhaka is 04:00–08:00 UTC).
  expect(
    workingMinutesBetween(his, new Date('2026-12-18T00:00:00Z'), new Date('2026-12-20T00:00:00Z')),
  ).toBe(240);
});
