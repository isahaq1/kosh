/**
 * Attendance's routes (RFC 0024 §2.2):
 *
 * - `GET  /api/v1/attendance/me`                   the user's employee, whether checked in and since when, today's day
 * - `POST /api/v1/attendance/punch`                `{ latitude?, longitude? }`: the user checks in or out from the
 *                                                  phone — inside a site's radius where its geofence is on
 * - `GET  /api/v1/attendance/kiosk/people`         kiosks: the people who check in there (names only)
 * - `POST /api/v1/attendance/kiosk/punch`          kiosks: `{ badge }` or `{ employee, pin }`; five wrong PINs lock
 *                                                  the person at the kiosks for 15 minutes
 * - `POST /api/v1/attendance/employees/:id/pin`    managers: `{ pin }` (4 to 8 digits), stored hashed
 * - `POST /api/v1/attendance/import`               managers: `{ format: 'zkteco' | 'csv', content }`
 * - `POST /api/v1/attendance/days/compute`         managers: `{ from, to, employees? }`
 * - `GET  /api/v1/attendance/formats`              the device file formats
 */
import { audit, HttpProblem, hashPassword, type ModuleContext, verifyPassword } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import {
  DEVICE_FORMATS,
  distanceMetres,
  importPunches,
  localDate,
  punch,
  recomputeDays,
  timeZoneOf,
} from './days.js';

type Row = Record<string, unknown>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

/** Wrong PINs per employee at the kiosks of this node: `{ count, until }`. */
const failures = new Map<number, { count: number; until: number }>();

const isManager = (env: Env) => env.administrator || env.groups.has('attendance.manager');
const asProblem = (error: unknown): never => {
  if (error instanceof orm.ValidationError)
    throw new HttpProblem(422, 'invalid', 'Not possible', error.message);
  throw error;
};

export function registerAttendanceRoutes({ app }: ModuleContext): void {
  const managers = (env: Env) => {
    if (!isManager(env))
      throw new HttpProblem(
        403,
        'access',
        'Attendance managers',
        'This needs the Attendance manager role.',
      );
  };
  /** The user's own employee. @throws {HttpProblem} 404 without one */
  const ownEmployee = async (su: Env, uid: number) => {
    const [e] = await (
      await su.model('hr.employee').search({ where: { user: uid as never }, limit: 1 })
    ).load({ company: true });
    if (e === undefined)
      throw new HttpProblem(
        404,
        'no-employee',
        'Not an employee',
        'Ask HR to add you as an employee.',
      );
    return e;
  };

  app.get('/api/v1/attendance/me', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        return env.asSuperuser({ reason: 'own attendance' }, async (su) => {
          const e = await ownEmployee(su, env.uid);
          const [open] = await (
            await su
              .model('attendance.record')
              .search({ where: { employee: e.id, checkOut: { isNull: true } }, limit: 1 })
          ).load(['checkIn']);
          const tz = await timeZoneOf(su);
          const [today] = await (
            await su
              .model('attendance.day')
              .search({ where: { employee: e.id, date: localDate(new Date(), tz) }, limit: 1 })
          ).load(['status', 'workedHours', 'lateMinutes', 'overtimeHours']);
          return {
            employee: { id: e.id, name: e.name },
            checkedInSince: open === undefined ? null : open.checkIn.toISOString(),
            today:
              today === undefined
                ? null
                : {
                    status: today.status,
                    workedHours: today.workedHours.toString(),
                    lateMinutes: today.lateMinutes,
                    overtimeHours: today.overtimeHours.toString(),
                  },
          };
        });
      },
      { write: true },
    ),
  );

  app.post('/api/v1/attendance/punch', async (request) => {
    const body = (request.body ?? {}) as Row;
    const lat = typeof body['latitude'] === 'number' ? body['latitude'] : null;
    const lon = typeof body['longitude'] === 'number' ? body['longitude'] : null;
    if (
      (lat === null) !== (lon === null) ||
      (lat !== null && (Math.abs(lat) > 90 || Math.abs(lon as number) > 180))
    )
      throw new HttpProblem(
        422,
        'invalid-location',
        'Invalid location',
        'Send latitude and longitude together.',
      );
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.groups.has('attendance.user'))
          throw new HttpProblem(403, 'access', 'Attendance', 'This needs access to Attendance.');
        return env.asSuperuser({ reason: 'check in from the phone' }, async (su) => {
          const e = await ownEmployee(su, env.uid);
          // The nearest site with coordinates; its geofence decides.
          const sites = [
            ...(await (
              await su.model('attendance.site').search({
                where: { company: e.company.id, latitude: { isNull: false } },
              })
            ).load(['latitude', 'longitude', 'radius', 'geofence', 'name'])),
          ];
          let site: number | null = null;
          let inside: boolean | null = null;
          let distance: number | null = null;
          if (sites.length > 0) {
            const fenced = sites.some((s) => s.geofence);
            if (lat === null || lon === null) {
              if (fenced)
                throw new HttpProblem(
                  422,
                  'location-needed',
                  'Location needed',
                  'Allow the location so the check-in is on site.',
                );
            } else {
              const measured = sites
                .map((s) => ({
                  s,
                  d: distanceMetres(
                    { lat, lon },
                    { lat: Number(s.latitude), lon: Number(s.longitude) },
                  ),
                }))
                .sort((a, b) => a.d - b.d);
              const nearest = measured[0] as (typeof measured)[number];
              site = nearest.s.id;
              distance = nearest.d;
              inside = nearest.d <= nearest.s.radius;
              if (!inside && nearest.s.geofence)
                throw new HttpProblem(
                  422,
                  'outside-site',
                  'Not on site',
                  `You are ${nearest.d} m from ${nearest.s.name}; check in within ${nearest.s.radius} m.`,
                );
            }
          }
          const out = await punch(su, e.id, new Date(), {
            source: 'phone',
            site,
            inside,
            distance,
          }).catch(asProblem);
          return out;
        });
      },
      { write: true },
    );
  });

  app.get('/api/v1/attendance/kiosk/people', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.groups.has('attendance.kiosk') && !isManager(env))
          throw new HttpProblem(403, 'access', 'Kiosk', 'This needs the kiosk role.');
        return env.asSuperuser({ reason: 'kiosk people' }, async (su) => ({
          people: [
            ...(await (
              await su.model('hr.employee').search({
                where: { company: env.companyId as never, attendancePin: { isNull: false } },
              })
            ).load(['name'])),
          ]
            .map((e) => ({ id: e.id, name: e.name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }));
      },
      { write: true }, // the system read is audited
    ),
  );

  app.post('/api/v1/attendance/kiosk/punch', async (request) => {
    const body = (request.body ?? {}) as Row;
    const badge = typeof body['badge'] === 'string' ? body['badge'].trim() : '';
    const pin = typeof body['pin'] === 'string' ? body['pin'] : '';
    const employee = Number(body['employee']);
    const site = body['site'] === undefined || body['site'] === null ? null : Number(body['site']);
    if (badge === '' && (!Number.isSafeInteger(employee) || pin === ''))
      throw new HttpProblem(
        422,
        'who',
        'Who is it?',
        'Scan the badge, or choose your name and type your PIN.',
      );
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.groups.has('attendance.kiosk') && !isManager(env))
          throw new HttpProblem(403, 'access', 'Kiosk', 'This needs the kiosk role.');
        return env.asSuperuser({ reason: 'kiosk check-in' }, async (su) => {
          let who: { id: number; name: string } | undefined;
          if (badge !== '') {
            const [e] = await (
              await su.model('hr.employee').search({
                where: { attendanceBadge: badge, company: env.companyId as never },
                limit: 1,
              })
            ).load(['name']);
            if (e === undefined)
              throw new HttpProblem(
                404,
                'unknown-badge',
                'Unknown badge',
                'This badge belongs to nobody here.',
              );
            who = { id: e.id, name: e.name };
          } else {
            const lock = failures.get(employee);
            if (lock !== undefined && lock.until > Date.now())
              throw new HttpProblem(
                429,
                'locked',
                'Locked',
                'Too many wrong PINs: try again in 15 minutes.',
              );
            const [e] = await (
              await su.model('hr.employee').search({
                where: { id: employee as never, company: env.companyId as never },
                limit: 1,
              })
            ).load(['name', 'attendancePin']);
            const ok = e?.attendancePin != null && (await verifyPassword(pin, e.attendancePin));
            if (e === undefined || !ok) {
              const count = (lock?.until ?? 0) > Date.now() ? 0 : (lock?.count ?? 0) + 1;
              failures.set(employee, {
                count: count >= LOCK_AFTER ? 0 : count,
                until: count >= LOCK_AFTER ? Date.now() + LOCK_MS : 0,
              });
              await audit(env, {
                kind: 'attendance.kiosk_pin_failed',
                summary: `A wrong kiosk PIN for employee ${employee}.`,
                targetModel: 'hr.employee',
                targetId: employee,
                ip: request.ip,
              });
              throw new HttpProblem(401, 'wrong-pin', 'Wrong PIN', 'The PIN does not match.');
            }
            failures.delete(employee);
            who = { id: e.id, name: e.name };
          }
          const out = await punch(su, who.id, new Date(), { source: 'kiosk', site }).catch(
            asProblem,
          );
          return { ...out, employee: who };
        });
      },
      { write: true },
    );
  });

  app.post('/api/v1/attendance/employees/:id/pin', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    const pin = (request.body as Row | null)?.['pin'];
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin))
      throw new HttpProblem(422, 'invalid-pin', 'Invalid PIN', 'A PIN is 4 to 8 digits.');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        managers(env);
        const hashed = await hashPassword(pin);
        return env.asSuperuser({ reason: 'kiosk PIN' }, async (su) => {
          const found = await su
            .model('hr.employee')
            .search({ where: { id: id as never }, limit: 1 });
          if (found.length === 0)
            throw new HttpProblem(
              404,
              'missing-record',
              'Not found',
              `There is no employee ${id}.`,
            );
          await found.write({ attendancePin: hashed } as never);
          await audit(env, {
            kind: 'attendance.pin_set',
            summary: `Kiosk PIN set for employee ${id}.`,
            targetModel: 'hr.employee',
            targetId: id,
            ip: request.ip,
          });
          await su.flush();
          return { id, pin: true };
        });
      },
      { write: true },
    );
  });

  app.get('/api/v1/attendance/formats', async () => ({
    formats: DEVICE_FORMATS.map((f) => ({ key: f.key, label: f.label })),
  }));

  app.post('/api/v1/attendance/import', async (request) => {
    const body = (request.body ?? {}) as Row;
    const format = DEVICE_FORMATS.find((f) => f.key === body['format']);
    const content = body['content'];
    if (format === undefined || typeof content !== 'string' || content.length > 5_000_000)
      throw new HttpProblem(
        422,
        'invalid-file',
        'Invalid file',
        `Give the format (${DEVICE_FORMATS.map((f) => f.key).join(', ')}) and the file's text.`,
      );
    const punches = format.parse(content);
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        managers(env);
        return env.asSuperuser({ reason: 'device import' }, async (su) => {
          const result = await importPunches(su, punches).catch(asProblem);
          await audit(env, {
            kind: 'attendance.imported',
            summary: `${result.imported} punches imported from a ${format.label} file.`,
            details: { ...result },
            ip: request.ip,
          });
          return { read: punches.length, ...result };
        });
      },
      { write: true },
    );
  });

  app.post('/api/v1/attendance/days/compute', async (request) => {
    const body = (request.body ?? {}) as Row;
    const from = body['from'];
    const to = body['to'];
    if (
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !DATE.test(from) ||
      !DATE.test(to) ||
      to < from
    )
      throw new HttpProblem(
        422,
        'invalid-dates',
        'Invalid dates',
        'Give from and to as YYYY-MM-DD, in order.',
      );
    if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000)
      throw new HttpProblem(422, 'too-long', 'Too long', 'Compute at most three months at a time.');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        managers(env);
        return env.asSuperuser({ reason: 'attendance days' }, async (su) => {
          const ids = Array.isArray(body['employees'])
            ? (body['employees'] as unknown[]).map(Number)
            : (
                await su.model('hr.employee').search({ where: { company: env.companyId as never } })
              ).ids.map(Number);
          const written = await recomputeDays(su, ids, from, to);
          await su.flush();
          return { written };
        });
      },
      { write: true },
    );
  });
}
