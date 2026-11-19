/**
 * Attendance machines that push (RFC 0037 §2) on real PostgreSQL, with a simulated machine speaking the protocol's
 * requests: an unregistered serial is refused and waits for approval; a registered one gets its options; its punches
 * become check-ins and check-outs once — sent twice, in pieces, late or out of order —, a night shift closes after
 * midnight, a second tap is ignored, an approved day is never changed, an unknown number is kept until its person
 * exists; a device switched off or sending from another address is refused; only managers see devices.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { attendance, parseAttlog } from '../src/index.js';

const SN = 'CKJB201260123';
let erp: TestInstallation;
const people: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, as: string, body?: unknown) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
/** The machine: a request as its firmware makes it. */
const machine = async (
  method: 'GET' | 'POST',
  path: string,
  body?: string,
  options: { contentType?: string | null } = {},
) => {
  const type = options.contentType === undefined ? 'text/plain' : options.contentType;
  const res = await erp.host.server.app.inject({
    method,
    url: path,
    ...(body === undefined
      ? {}
      : { payload: body, headers: type === null ? {} : { 'content-type': type } }),
  });
  return { status: res.statusCode, text: res.body };
};
const attlog = (lines: [number, string][], stamp = 1, serial = SN) =>
  machine(
    'POST',
    `/iclock/cdata?SN=${serial}&table=ATTLOG&Stamp=${stamp}`,
    `${lines.map(([user, at]) => `${user}\t${at}\t0\t1\t0\t0`).join('\n')}\n`,
  );
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  erp.host.server.driver.query<T>({ text, params });
/** A person's records as Dhaka wall-clock times: `10-20 08:58–17:31 push`. */
const records = async (who: string) =>
  (
    await sql<{ line: string }>(
      `SELECT to_char(check_in AT TIME ZONE 'Asia/Dhaka', 'MM-DD HH24:MI') || '–' ||
              coalesce(to_char(check_out AT TIME ZONE 'Asia/Dhaka', 'MM-DD HH24:MI'), 'open') || ' ' || source AS line
         FROM attendance_record WHERE employee_id = $1 ORDER BY check_in`,
      [people[who]],
    )
  ).map((r) => r.line);
const outcomes = async (code: number) =>
  (
    await sql<{ o: string }>(
      'SELECT outcome AS o FROM attendance_device_punch WHERE user_code = $1 ORDER BY at, id',
      [String(code)],
    )
  ).map((r) => r.o);
/** A Dhaka wall-clock time so many minutes from now, as the machine writes it. */
const nowInDhaka = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000 + 6 * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

beforeAll(async () => {
  erp = await testInstallation({
    modules: [attendance],
    users: {
      hana: ['attendance.manager', 'hr.manager'],
      rafi: ['attendance.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  for (const [name, code] of [
    ['Asha', '101'],
    ['Babul', '102'],
    ['Chitra', '103'],
    ['Dipu', '104'],
  ] as const) {
    const made = await call('POST', '/api/v1/models/hr.employee', 'hana', {
      name,
      deviceUserId: code,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    people[name] = made.json.id;
  }
}, 240_000);

afterAll(async () => {
  await erp?.close();
});

test('a log’s lines are read; what is not a punch is left out', () => {
  expect(
    parseAttlog(
      '101\t2026-10-20 08:58:12\t0\t1\t0\t0\r\n  102 2026-10-20 09:01:00 1 1\nnot a line\n\n',
    ),
  ).toEqual([
    { user: '101', localTime: '2026-10-20 08:58:12' },
    { user: '102', localTime: '2026-10-20 09:01:00' },
  ]);
});

test('an unregistered machine is refused and waits for approval; only managers see devices', async () => {
  expect((await machine('GET', `/iclock/cdata?SN=${SN}&options=all`)).status).toBe(401);
  expect((await attlog([[101, '2026-10-19 09:00:00']])).status).toBe(401);
  expect((await machine('GET', '/iclock/cdata?SN=../../etc')).status).toBe(401);
  expect((await machine('GET', '/iclock/cdata')).status).toBe(401);
  // It knocked twice: it is listed once, waiting; nothing it sent was kept.
  const listed = (
    await call('GET', '/api/v1/models/attendance.device?fields=name,serial,status', 'hana')
  ).json.items;
  expect(listed).toMatchObject([{ serial: SN, status: 'pending', name: `Device ${SN}` }]);
  expect(await sql('SELECT 1 FROM attendance_device_punch')).toHaveLength(0);
  expect((await call('GET', '/api/v1/models/attendance.device', 'rafi')).status).toBe(403);
  expect(
    (
      await call('PATCH', `/api/v1/models/attendance.device/${listed[0].id}`, 'rafi', {
        status: 'active',
      })
    ).status,
  ).toBe(403);
  // A manager names it and approves it.
  const approved = await call('PATCH', `/api/v1/models/attendance.device/${listed[0].id}`, 'hana', {
    name: 'Main gate',
    status: 'active',
  });
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  const options = await machine('GET', `/iclock/cdata?SN=${SN}&options=all&pushver=2.4.1`);
  expect(options.status).toBe(200);
  expect(options.text).toContain(`GET OPTION FROM: ${SN}`);
  expect(options.text).toContain('ATTLOGStamp=None'); // nothing sent yet: send everything
  expect(options.text).toContain('Realtime=1');
  expect(options.text).toContain('TimeZone=6');
  expect((await machine('GET', `/iclock/getrequest?SN=${SN}`)).text).toBe('OK');
  expect((await machine('POST', `/iclock/devicecmd?SN=${SN}`, 'ID=1&Return=0')).text).toBe('OK');
  // Its operation log is acknowledged and not kept.
  expect(
    (await machine('POST', `/iclock/cdata?SN=${SN}&table=OPERLOG&Stamp=5`, 'OPLOG 4\t0\t...')).text,
  ).toBe('OK: 0');
});

test('a day’s punches become one check-in and check-out, once, however often they are sent', async () => {
  const day = [
    [101, '2026-10-20 08:58:12'],
    [101, '2026-10-20 08:58:40'], // a second tap
    [101, '2026-10-20 17:31:05'],
  ] as [number, string][];
  const sent = await attlog(day, 777);
  expect(sent.status).toBe(200);
  expect(sent.text).toBe('OK: 3');
  expect(await records('Asha')).toEqual(['10-20 08:58–10-20 17:31 push']);
  expect(await outcomes(101)).toEqual(['applied', 'duplicate', 'applied']);
  // The machine restarts and sends its whole memory again; and once more without a content type.
  await attlog(day, 778);
  const bare = await machine(
    'POST',
    `/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=779`,
    '101\t2026-10-20 08:58:12\t0\t1\n',
    { contentType: null },
  );
  expect(bare.status).toBe(200);
  expect(await records('Asha')).toEqual(['10-20 08:58–10-20 17:31 push']);
  expect(await outcomes(101)).toHaveLength(3);
  // It is told what it has sent, so that it sends only what is new.
  expect((await machine('GET', `/iclock/cdata?SN=${SN}&options=all`)).text).toContain(
    'ATTLOGStamp=779',
  );
  // The day was computed from the punches.
  const [computed] = await sql<{ status: string; worked: string }>(
    "SELECT status, worked_hours::text AS worked FROM attendance_day WHERE employee_id = $1 AND date = '2026-10-20'",
    [people['Asha']],
  );
  expect(computed).toBeDefined();
  expect(Number(computed?.worked)).toBeGreaterThan(7);
});

test('a night shift closes after midnight; a check-in never closed is unpaired, not counted', async () => {
  await attlog([
    [102, '2026-10-21 22:02:00'],
    [102, '2026-10-22 06:05:00'],
    // He forgot to punch out on the 23rd; the next punch is two days later.
    [102, '2026-10-23 09:00:00'],
    [102, '2026-10-25 09:01:00'],
    [102, '2026-10-25 17:00:00'],
  ]);
  expect(await records('Babul')).toEqual([
    '10-21 22:02–10-22 06:05 push',
    '10-25 09:01–10-25 17:00 push',
  ]);
  expect(await outcomes(102)).toEqual(['applied', 'applied', 'unpaired', 'applied', 'applied']);
});

test('a backlog sent late and out of order gives the same day', async () => {
  // The evening punch arrives first (the machine was offline in the morning's upload).
  await attlog([[103, '2026-10-26 17:10:00']]);
  expect(await records('Chitra')).toEqual([]); // alone and old: not a check-in to keep open
  expect(await outcomes(103)).toEqual(['unpaired']);
  await attlog([[103, '2026-10-26 08:50:00']]);
  expect(await records('Chitra')).toEqual(['10-26 08:50–10-26 17:10 push']);
  expect(await outcomes(103)).toEqual(['applied', 'applied']);
  // A lunch break sent later still: the day becomes two stretches.
  await attlog([
    [103, '2026-10-26 13:00:00'],
    [103, '2026-10-26 14:00:00'],
  ]);
  expect(await records('Chitra')).toEqual([
    '10-26 08:50–10-26 13:00 push',
    '10-26 14:00–10-26 17:10 push',
  ]);
});

test('live, one punch at a time: checked in, then out', async () => {
  await attlog([[104, nowInDhaka(-180)]]);
  const open = await records('Dipu');
  expect(open).toHaveLength(1);
  expect(open[0]).toContain('–open push');
  await attlog([[104, nowInDhaka(-5)]]);
  const closed = await records('Dipu');
  expect(closed).toHaveLength(1);
  expect(closed[0]).not.toContain('open');
  const [device] = await sql<{ last_punch_at: Date | null; last_seen_at: Date | null }>(
    'SELECT last_punch_at, last_seen_at FROM attendance_device WHERE serial = $1',
    [SN],
  );
  expect(device?.last_punch_at).not.toBeNull();
  expect(Date.now() - new Date(device?.last_seen_at ?? 0).getTime()).toBeLessThan(60_000);
});

test('an approved day is never changed: a punch for it is kept and marked too late', async () => {
  const [day] = await sql<{ id: number }>(
    "SELECT id FROM attendance_day WHERE employee_id = $1 AND date = '2026-10-20'",
    [people['Asha']],
  );
  const approved = await call(
    'POST',
    `/api/v1/models/attendance.day/${day?.id}/transitions/approve`,
    'hana',
  );
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  await attlog([[101, '2026-10-20 19:45:00']]);
  expect(await records('Asha')).toEqual(['10-20 08:58–10-20 17:31 push']);
  expect(await outcomes(101)).toEqual(['applied', 'duplicate', 'applied', 'late']);
});

test('an unknown number is kept until its person exists', async () => {
  await attlog([
    [900, '2026-10-27 09:00:00'],
    [900, '2026-10-27 17:00:00'],
  ]);
  expect(await outcomes(900)).toEqual(['unknown', 'unknown']);
  const made = await call('POST', '/api/v1/models/hr.employee', 'hana', {
    name: 'Emon',
    deviceUserId: '900',
  });
  people['Emon'] = made.json.id;
  const [device] = await sql<{ id: number }>('SELECT id FROM attendance_device WHERE serial = $1', [
    SN,
  ]);
  expect(
    (await call('POST', `/api/v1/attendance/devices/${device?.id}/apply`, 'rafi')).status,
  ).toBe(403);
  const applied = await call('POST', `/api/v1/attendance/devices/${device?.id}/apply`, 'hana');
  expect(applied.json).toEqual({ matched: 2, unknown: 0 });
  expect(await records('Emon')).toEqual(['10-27 09:00–10-27 17:00 push']);
});

test('a device switched off, or sending from another address, is refused', async () => {
  const [device] = await sql<{ id: number }>('SELECT id FROM attendance_device WHERE serial = $1', [
    SN,
  ]);
  const D = `/api/v1/models/attendance.device/${device?.id}`;
  await call('PATCH', D, 'hana', { allowedAddresses: '203.0.113.7, 203.0.113.8' });
  expect((await attlog([[101, '2026-10-28 09:00:00']])).status).toBe(401);
  await call('PATCH', D, 'hana', { allowedAddresses: '127.0.0.1' });
  expect((await attlog([[101, '2026-10-28 09:00:00']])).status).toBe(200);
  await call('PATCH', D, 'hana', { status: 'off' });
  expect((await attlog([[101, '2026-10-28 17:00:00']])).status).toBe(401);
  expect((await machine('GET', `/iclock/getrequest?SN=${SN}`)).status).toBe(401);
  // Only the punch taken while it was allowed is there.
  expect(
    await sql("SELECT 1 FROM attendance_device_punch WHERE local_time LIKE '2026-10-28%'"),
  ).toHaveLength(1);
});
