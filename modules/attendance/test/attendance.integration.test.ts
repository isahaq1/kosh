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
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { attendance } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, attendance];
const D = '/api/v1/models/attendance.day';
const HEAD_OFFICE = { latitude: 23.7806, longitude: 90.4078 };

let container: StartedPostgreSqlContainer;
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
  container = await new PostgreSqlContainer('postgres:18').start();
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
      await call('POST', '/api/v1/models/attendance.holiday', 'hana', {
        name: 'Durga Puja',
        date: '2026-10-21',
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
