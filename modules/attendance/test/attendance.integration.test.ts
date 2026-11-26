/**
 * Attendance on real PostgreSQL through the HTTP API (RFC 0024 §2.2): the phone check-in needs the location and is
 * refused off site; the kiosk takes a badge or a PIN and locks a person after five wrong PINs; device files import
 * each punch once; days are computed with lateness, overtime, absence and holidays and stay as approved; only
 * managers approve; people see their own days and not the badges or PINs; the demo data loads.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { settings } from '@kosh/settings';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { attendance, attendanceWorker, enqueueYesterday } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, attendance];
const D = '/api/v1/models/attendance.day';
const HEAD_OFFICE = { latitude: 23.7806, longitude: 90.4078 };

let container: TestDatabase;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const employees: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    tokens.set(as, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await testDatabase();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-attendance-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'attendance'] }, dir }),
    { driver, dir, actor: 'test' },
  );
  host = await createAppHost({
    databaseUrl: container.getConnectionUri(),
    catalogue,
    migrationsDir: dir,
    logger: false,
    listen: false,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  const users: Record<string, number> = {};
  for (const [login, groups] of [
    ['hana', ['hr.manager', 'attendance.manager']],
    ['rahim', ['attendance.user']],
    ['sumi', ['attendance.user']],
    ['gate', ['attendance.kiosk']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const shifts = (await call('GET', '/api/v1/models/attendance.shift?fields=name', 'hana')).json
    .items as Json[];
  const general = shifts.find((s) => s.name === 'General').id;
  for (const who of ['rahim', 'sumi'])
    employees[who] = (
      await call('POST', '/api/v1/models/hr.employee', 'hana', {
        name: who,
        user: users[who],
        attendanceShift: general,
      })
    ).json.id;
  expect(
    (
      await call('POST', '/api/v1/models/attendance.site', 'hana', {
        name: 'Head office',
        latitude: String(HEAD_OFFICE.latitude),
        longitude: String(HEAD_OFFICE.longitude),
        radius: 200,
      })
    ).status,
  ).toBe(201);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the phone: the location is needed, off site is refused, on site checks in', async () => {
  const blind = await call('POST', '/api/v1/attendance/punch', 'rahim', {});
  expect(blind.status).toBe(422);
  expect(blind.json.type).toContain('location-needed');
  const far = await call('POST', '/api/v1/attendance/punch', 'rahim', {
    latitude: 23.81,
    longitude: 90.41,
  });
  expect(far.status).toBe(422);
  expect(far.json.detail).toMatch(/m from Head office/);
  const near = await call('POST', '/api/v1/attendance/punch', 'rahim', {
    latitude: HEAD_OFFICE.latitude + 0.0005,
    longitude: HEAD_OFFICE.longitude,
  });
  expect(near.status, JSON.stringify(near.json)).toBe(200);
  expect(near.json.action).toBe('in');
  const twice = await call('POST', '/api/v1/attendance/punch', 'rahim', HEAD_OFFICE);
  expect(twice.status).toBe(422); // a second tap within the minute is not a check-out
  const me = await call('GET', '/api/v1/attendance/me', 'rahim');
  expect(me.json.checkedInSince).toBeTruthy();
  const records = (
    await call('GET', '/api/v1/models/attendance.record?fields=inside,distance,source', 'rahim')
  ).json.items as Json[];
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ inside: true, source: 'phone' });
  expect(records[0].distance).toBeGreaterThan(40);
});

test('the kiosk: a badge, a PIN, and the lock after five wrong PINs; badges and PINs for managers only', async () => {
  expect(
    (
      await call('POST', `/api/v1/attendance/employees/${employees['sumi']}/pin`, 'rahim', {
        pin: '2468',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('POST', `/api/v1/attendance/employees/${employees['sumi']}/pin`, 'hana', {
        pin: '24',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('POST', `/api/v1/attendance/employees/${employees['sumi']}/pin`, 'hana', {
        pin: '2468',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('PATCH', `/api/v1/models/hr.employee/${employees['rahim']}`, 'hana', {
        attendanceBadge: 'B-1001',
      })
    ).status,
  ).toBe(200);
  const seen = (await call('GET', `/api/v1/models/hr.employee/${employees['rahim']}`, 'rahim'))
    .json;
  expect(seen.attendanceBadge).toBeUndefined();
  expect(seen.attendancePin).toBeUndefined();

  const people = await call('GET', '/api/v1/attendance/kiosk/people', 'gate');
  expect(people.json.people.map((p: Json) => p.name)).toEqual(['sumi']);
  expect((await call('GET', '/api/v1/attendance/kiosk/people', 'rahim')).status).toBe(403);
  // Rahim is checked in from the phone: the badge checks him out (after the minute, so through the database).
  await driver.query({
    text: "UPDATE attendance_record SET check_in = check_in - interval '2 hours'",
    params: [],
  });
  const out = await call('POST', '/api/v1/attendance/kiosk/punch', 'gate', { badge: 'B-1001' });
  expect(out.status, JSON.stringify(out.json)).toBe(200);
  expect(out.json).toMatchObject({ action: 'out', employee: { id: employees['rahim'] } });
  expect(
    (await call('POST', '/api/v1/attendance/kiosk/punch', 'gate', { badge: 'NOPE' })).status,
  ).toBe(404);

  const ok = await call('POST', '/api/v1/attendance/kiosk/punch', 'gate', {
    employee: employees['sumi'],
    pin: '2468',
  });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(ok.json.action).toBe('in');
  for (let i = 0; i < 5; i += 1)
    expect(
      (
        await call('POST', '/api/v1/attendance/kiosk/punch', 'gate', {
          employee: employees['sumi'],
          pin: '0000',
        })
      ).status,
    ).toBe(401);
  const locked = await call('POST', '/api/v1/attendance/kiosk/punch', 'gate', {
    employee: employees['sumi'],
    pin: '2468',
  });
  expect(locked.status).toBe(429);
  // Back out of the way of the next test: Sumi's kiosk check-in removed.
  await driver.query({ text: 'DELETE FROM attendance_record WHERE check_out IS NULL', params: [] });
});

test('a device file: each punch once; the days with lateness, overtime, absence and a holiday', async () => {
  expect(
    (
      await call('PATCH', `/api/v1/models/hr.employee/${employees['sumi']}`, 'hana', {
        deviceUserId: '12',
      })
    ).status,
  ).toBe(200);
  const log = [
    '  12\t2026-10-19 08:58:00\t1\t0\t1\t0', // Monday: on time, out at 19:40 (an hour and a half over)
    '  12\t2026-10-19 19:40:00\t1\t0\t1\t0',
    '  12\t2026-10-20 09:30:00\t1\t0\t1\t0', // Tuesday: 20 minutes late
    '  12\t2026-10-20 18:00:00\t1\t0\t1\t0',
    '  99\t2026-10-20 09:00:00\t1\t0\t1\t0', // nobody
  ].join('\n');
  expect(
    (await call('POST', '/api/v1/attendance/import', 'rahim', { format: 'zkteco', content: log }))
      .status,
  ).toBe(403);
  const first = await call('POST', '/api/v1/attendance/import', 'hana', {
    format: 'zkteco',
    content: log,
  });
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  expect(first.json).toMatchObject({ read: 5, imported: 2, skipped: 0, unknown: ['99'] });
  const again = await call('POST', '/api/v1/attendance/import', 'hana', {
    format: 'zkteco',
    content: log,
  });
  expect(again.json).toMatchObject({ imported: 0, skipped: 2 });

  expect(
    (
      await call('POST', '/api/v1/models/work.holiday', 'hana', {
        name: 'Durga Puja',
        dateFrom: '2026-10-21',
        dateTo: '2026-10-21',
      })
    ).status,
  ).toBe(201);
  const computed = await call('POST', '/api/v1/attendance/days/compute', 'hana', {
    from: '2026-10-18',
    to: '2026-10-21',
    employees: [employees['sumi']],
  });
  expect(computed.status, JSON.stringify(computed.json)).toBe(200);
  const days = (
    await call(
      'GET',
      `${D}?filter=${encodeURIComponent(JSON.stringify({ employee: employees['sumi'] }))}&fields=date,status,lateMinutes,overtimeHours,overtimeApproved&order=date%20asc`,
      'hana',
    )
  ).json.items as Json[];
  const byDate = Object.fromEntries(days.map((d) => [String(d.date).slice(0, 10), d]));
  expect(byDate['2026-10-18']).toMatchObject({ status: 'absent' }); // Sunday is a working day here
  expect(byDate['2026-10-19']).toMatchObject({ status: 'present', lateMinutes: 0 });
  expect(Number(byDate['2026-10-19'].overtimeHours)).toBe(1.5);
  expect(Number(byDate['2026-10-19'].overtimeApproved)).toBe(1.5);
  expect(byDate['2026-10-20']).toMatchObject({ status: 'present', lateMinutes: 20 });
  expect(byDate['2026-10-21']).toBeUndefined(); // a holiday nobody worked: nothing to say

  // Approved by a manager; never by the person; recomputing leaves it.
  const monday = byDate['2026-10-19'].id;
  expect((await call('PATCH', `${D}/${monday}`, 'hana', { overtimeApproved: '1' })).status).toBe(
    200,
  );
  expect((await call('POST', `${D}/${monday}/transitions/approve`, 'sumi')).status).toBe(403);
  const approved = await call('POST', `${D}/${monday}/transitions/approve`, 'hana');
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  await call('POST', '/api/v1/attendance/days/compute', 'hana', {
    from: '2026-10-19',
    to: '2026-10-19',
    employees: [employees['sumi']],
  });
  const kept = (await call('GET', `${D}/${monday}?fields=state,overtimeApproved`, 'hana')).json;
  expect(kept.state).toBe('approved');
  expect(Number(kept.overtimeApproved)).toBe(1);

  // People see their own days.
  const rahimSees = (await call('GET', `${D}?fields=employee`, 'rahim')).json.items as Json[];
  expect(rahimSees.every((d) => (d.employee?.id ?? d.employee) === employees['rahim'])).toBe(true);
  const sumiSees = (await call('GET', `${D}?fields=employee`, 'sumi')).json.items as Json[];
  expect(sumiSees.length).toBeGreaterThanOrEqual(3);
});

test('an approved official tour: its working days are On tour, not absent; cancelled, they are absent again', async () => {
  const TOUR = '/api/v1/models/hr.tour';
  // Friday 6 to Thursday 12 November 2026: a weekend, then five working days.
  const tour = await call('POST', TOUR, 'hana', {
    employee: employees['sumi'],
    dateFrom: '2026-11-06',
    dateTo: '2026-11-12',
    places: 'Khulna depot',
    purpose: 'Stock audit',
  });
  expect(tour.status, JSON.stringify(tour.json)).toBe(201);
  const step = (name: string) =>
    call('POST', `${TOUR}/${tour.json.id}/transitions/${name}`, 'hana');
  const statuses = async () => {
    const computed = await call('POST', '/api/v1/attendance/days/compute', 'hana', {
      from: '2026-11-05',
      to: '2026-11-12',
      employees: [employees['sumi']],
    });
    expect(computed.status, JSON.stringify(computed.json)).toBe(200);
    const days = (
      await call(
        'GET',
        `${D}?filter=${encodeURIComponent(JSON.stringify({ employee: employees['sumi'], date: { gte: '2026-11-05', lte: '2026-11-12' } }))}&fields=date,status&order=date%20asc`,
        'hana',
      )
    ).json.items as Json[];
    return Object.fromEntries(days.map((d) => [String(d.date).slice(5, 10), d.status]));
  };
  // Asked for, not yet approved: she is absent on those days like anyone without a punch.
  expect((await step('submit')).status).toBe(200);
  expect(await statuses()).toEqual({
    '11-05': 'absent',
    '11-08': 'absent',
    '11-09': 'absent',
    '11-10': 'absent',
    '11-11': 'absent',
    '11-12': 'absent',
  });
  // Approved: the working days inside it are On tour; the day before stays absent, the weekend says nothing.
  expect((await step('approve')).status).toBe(200);
  expect(await statuses()).toEqual({
    '11-05': 'absent',
    '11-08': 'tour',
    '11-09': 'tour',
    '11-10': 'tour',
    '11-11': 'tour',
    '11-12': 'tour',
  });
  // Called off: absent again.
  await call('PATCH', `${TOUR}/${tour.json.id}`, 'hana', { decisionNote: 'Postponed' });
  expect((await step('cancel')).status).toBe(200);
  expect((await statuses())['11-10']).toBe('absent');
});

test('home office: asked by the person, decided by someone else; its days are Home office, and a check-in from anywhere', async () => {
  const REMOTE = '/api/v1/models/hr.remote';
  // Sunday 15 to Tuesday 17 November 2026: three working days.
  const asked = await call('POST', REMOTE, 'sumi', {
    employee: employees['sumi'],
    dateFrom: '2026-11-15',
    dateTo: '2026-11-17',
    reason: 'The plumber comes',
  });
  expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  expect(asked.json.days ?? 3).toBe(3);
  const step = (name: string, as: string) =>
    call('POST', `${REMOTE}/${asked.json.id}/transitions/${name}`, as);
  expect((await step('submit', 'sumi')).status).toBe(200);
  // Never her own to decide; HR approves.
  const own = await step('approve', 'sumi');
  expect(own.status).toBeGreaterThanOrEqual(400);
  expect((await step('approve', 'hana')).status).toBe(200);
  // No second request, nor a tour, over the same days.
  const again = await call('POST', REMOTE, 'sumi', {
    employee: employees['sumi'],
    dateFrom: '2026-11-17',
    dateTo: '2026-11-18',
    reason: 'Again',
  });
  expect(again.status).toBe(422);
  expect(JSON.stringify(again.json)).toContain('already has home office');
  // Somebody else's request is not hers to read.
  expect((await call('GET', `${REMOTE}/${asked.json.id}`, 'rahim')).status).toBeGreaterThanOrEqual(
    403,
  );
  const statuses = async () => {
    const computed = await call('POST', '/api/v1/attendance/days/compute', 'hana', {
      from: '2026-11-15',
      to: '2026-11-18',
      employees: [employees['sumi']],
    });
    expect(computed.status, JSON.stringify(computed.json)).toBe(200);
    const days = (
      await call(
        'GET',
        `${D}?filter=${encodeURIComponent(JSON.stringify({ employee: employees['sumi'], date: { gte: '2026-11-15', lte: '2026-11-18' } }))}&fields=date,status&order=date%20asc`,
        'hana',
      )
    ).json.items as Json[];
    return Object.fromEntries(days.map((d) => [String(d.date).slice(5, 10), d.status]));
  };
  // Without a check-in the days are Home office — present, not absent —; the day after is absent.
  expect(await statuses()).toEqual({
    '11-15': 'remote',
    '11-16': 'remote',
    '11-17': 'remote',
    '11-18': 'absent',
  });
  // Called off, with the reason: absent again.
  expect((await step('cancel', 'hana')).status).toBeGreaterThanOrEqual(400); // no reason yet
  await call('PATCH', `${REMOTE}/${asked.json.id}`, 'hana', { decisionNote: 'Needed on site' });
  expect((await step('cancel', 'hana')).status).toBe(200);
  expect((await statuses())['11-16']).toBe('absent');

  // Today, approved to work from home: the phone checks in far from the office, where it is otherwise refused.
  const today = new Date().toISOString().slice(0, 10);
  const far = { latitude: 23.95, longitude: 90.6 };
  expect((await call('POST', '/api/v1/attendance/punch', 'sumi', far)).status).toBe(422);
  const now = await call('POST', REMOTE, 'sumi', {
    employee: employees['sumi'],
    dateFrom: today,
    dateTo: today,
    reason: 'A delivery',
  });
  expect(now.status, JSON.stringify(now.json)).toBe(201);
  for (const [name, as] of [
    ['submit', 'sumi'],
    ['approve', 'hana'],
  ] as const)
    expect(
      (await call('POST', `${REMOTE}/${now.json.id}/transitions/${name}`, as)).status,
      name,
    ).toBe(200);
  const home = await call('POST', '/api/v1/attendance/punch', 'sumi', far);
  expect(home.status, JSON.stringify(home.json)).toBe(200);
  expect(home.json.action).toBe('in');
});

test('shift swaps: asked, accepted by the colleague, approved by a manager who is neither; each then works the other’s shift', async () => {
  const SWAP = '/api/v1/models/attendance.swap';
  const shifts = (await call('GET', '/api/v1/models/attendance.shift?fields=name', 'hana')).json
    .items as Json[];
  const general = shifts.find((s) => s.name === 'General').id as number;
  const night = shifts.find((s) => s.name === 'Night').id as number;
  // Tuesday 1 December 2026: Sumi is rostered on the night shift, Rahim on his usual General.
  expect(
    (
      await call('POST', '/api/v1/models/attendance.roster', 'hana', {
        employee: employees['sumi'],
        shift: night,
        dateFrom: '2026-12-01',
        dateTo: '2026-12-01',
      })
    ).status,
  ).toBe(201);
  const asked = await call('POST', SWAP, 'rahim', {
    employee: employees['rahim'],
    withEmployee: employees['sumi'],
    date: '2026-12-01',
    reason: 'A family dinner',
  });
  expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  const step = (name: string, as: string, id: number = asked.json.id) =>
    call('POST', `${SWAP}/${id}/transitions/${name}`, as);
  const idOf = (v: Json) => (typeof v === 'object' && v !== null ? v.id : v);
  // Nobody swaps with themselves.
  expect(
    (
      await call('POST', SWAP, 'rahim', {
        employee: employees['rahim'],
        withEmployee: employees['rahim'],
        date: '2026-12-03',
        reason: 'Alone',
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  // Asked: the two planned shifts are written down by the server.
  expect((await step('submit', 'rahim')).status).toBe(200);
  const written = (await call('GET', `${SWAP}/${asked.json.id}`, 'rahim')).json;
  expect(idOf(written.shift)).toBe(general);
  expect(idOf(written.withShift)).toBe(night);
  // The colleague answers, not the one who asks; nobody but a manager who is neither of them approves.
  expect((await step('accept', 'rahim')).status).toBeGreaterThanOrEqual(400);
  expect((await step('approve', 'hana')).status).toBeGreaterThanOrEqual(400); // not accepted yet
  const accepted = await step('accept', 'sumi');
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
  expect((await step('approve', 'sumi')).status).toBeGreaterThanOrEqual(400);
  expect((await step('approve', 'rahim')).status).toBeGreaterThanOrEqual(400);
  // A swap is read by its two people and by managers only.
  expect((await call('GET', `${SWAP}/${asked.json.id}`, 'gate')).status).toBeGreaterThanOrEqual(
    403,
  );
  const approved = await step('approve', 'hana');
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  // One swap a day per person.
  const again = await call('POST', SWAP, 'sumi', {
    employee: employees['sumi'],
    withEmployee: employees['rahim'],
    date: '2026-12-01',
    reason: 'Again',
  });
  expect(again.status).toBe(422);
  expect(JSON.stringify(again.json)).toContain('already has a swap');

  const shiftsWorked = async () => {
    const computed = await call('POST', '/api/v1/attendance/days/compute', 'hana', {
      from: '2026-12-01',
      to: '2026-12-01',
      employees: [employees['rahim'], employees['sumi']],
    });
    expect(computed.status, JSON.stringify(computed.json)).toBe(200);
    const days = (
      await call(
        'GET',
        `${D}?filter=${encodeURIComponent(JSON.stringify({ date: '2026-12-01', employee: { in: [employees['rahim'], employees['sumi']] } }))}&fields=employee,shift`,
        'hana',
      )
    ).json.items as Json[];
    return Object.fromEntries(days.map((d) => [idOf(d.employee), idOf(d.shift)]));
  };
  // The rosters stay as planned; the day is computed on the other's shift.
  expect(await shiftsWorked()).toEqual({
    [employees['rahim'] as number]: night,
    [employees['sumi'] as number]: general,
  });
  // Called off, with the reason: the planned shifts are back.
  expect((await step('cancel', 'hana')).status).toBeGreaterThanOrEqual(400); // no reason yet
  await call('PATCH', `${SWAP}/${asked.json.id}`, 'hana', { decisionNote: 'The line is short' });
  expect((await step('cancel', 'hana')).status).toBe(200);
  expect(await shiftsWorked()).toEqual({
    [employees['rahim'] as number]: general,
    [employees['sumi'] as number]: night,
  });

  // Both on the same shift: there is nothing to swap.
  const same = await call('POST', SWAP, 'rahim', {
    employee: employees['rahim'],
    withEmployee: employees['sumi'],
    date: '2026-12-02',
    reason: 'No difference',
  });
  expect(same.status, JSON.stringify(same.json)).toBe(201);
  const nothing = await step('submit', 'rahim', same.json.id);
  expect(nothing.status).toBe(422);
  expect(JSON.stringify(nothing.json)).toContain('nothing to swap');
});

test('many people: a long request is computed in the background, and every night computes yesterday for everybody — once', async () => {
  // Sixty people on the general shift who never punch.
  type Model = {
    create(rows: readonly unknown[]): Promise<{ ids: number[] }>;
    search(q: unknown): Promise<{ ids: number[] }>;
  };
  const made = await host.server.shutro.bootstrap(
    { reason: 'test: people', company },
    async (env) => {
      const model = (name: string) => env.model(name as never) as unknown as Model;
      const [shift] = (await model('attendance.shift').search({ where: { name: 'General' } })).ids;
      return (
        await model('hr.employee').create(
          Array.from({ length: 60 }, (_, i) => ({ name: `Crew ${i + 1}`, attendanceShift: shift })),
        )
      ).ids;
    },
  );
  const daysOf = async (employee: number, from: string, to: string) =>
    (
      await driver.query<{ status: string; n: string }>({
        text: `SELECT status, count(*)::text AS n FROM attendance_day
                WHERE employee_id = $1 AND date BETWEEN $2 AND $3 GROUP BY status`,
        params: [employee, from, to],
      })
    ).map((r) => `${r.status} ${r.n}`);
  const crew = made[0] as number;

  // Three months for everybody: more than a request computes at once — answered at once, done by the jobs.
  const asked = await call('POST', '/api/v1/attendance/days/compute', 'hana', {
    from: '2027-01-01',
    to: '2027-03-31',
  });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(asked.json).toMatchObject({ written: 0 });
  expect(asked.json.people).toBeGreaterThanOrEqual(60);
  expect(asked.json.queued).toBeGreaterThanOrEqual(1);
  expect(await daysOf(crew, '2027-01-01', '2027-03-31')).toEqual([]);
  const worker = attendanceWorker({ shutro: host.server.shutro });
  expect(await worker.drain()).toBe(asked.json.queued);
  // Absent on every working day of the three months (the weekends have nothing to say).
  const [absent] = await daysOf(crew, '2027-01-01', '2027-03-31');
  expect(absent).toMatch(/^absent 6\d$/);
  // A short request is still computed in the request.
  const short = await call('POST', '/api/v1/attendance/days/compute', 'hana', {
    from: '2027-04-04',
    to: '2027-04-04',
    employees: [crew],
  });
  expect(short.json).toMatchObject({ written: 1, queued: 0, people: 1 });
  // Not for those who do not manage Attendance.
  expect(
    (
      await call('POST', '/api/v1/attendance/days/compute', 'rahim', {
        from: '2027-01-01',
        to: '2027-03-31',
      })
    ).status,
  ).toBe(403);

  // The night after Monday 3 May 2027: everybody's Monday, without anybody asking.
  const tuesday = new Date('2027-05-04T10:00:00Z');
  expect(await enqueueYesterday({ shutro: host.server.shutro }, tuesday)).toBeGreaterThanOrEqual(1);
  expect(await worker.drain()).toBeGreaterThanOrEqual(1);
  expect(await daysOf(crew, '2027-05-03', '2027-05-03')).toEqual(['absent 1']);
  // The next tick of the same night, or another server's: nothing more to do.
  expect(await enqueueYesterday({ shutro: host.server.shutro }, tuesday)).toBe(0);
  expect(await worker.drain()).toBe(0);
  // The night after is another night.
  expect(
    await enqueueYesterday({ shutro: host.server.shutro }, new Date('2027-05-05T10:00:00Z')),
  ).toBeGreaterThanOrEqual(1);
  await worker.drain();
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const summary = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Attendance');
});
