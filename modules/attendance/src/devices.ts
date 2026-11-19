/**
 * Attendance machines that push (RFC 0037 §2): ZKTeco's push protocol ("ADMS"). The machine calls fixed paths over
 * plain HTTP and is answered in plain text:
 *
 * - `GET  /iclock/cdata?SN=<serial>&options=all`           its options: send attendance logs, in real time
 * - `POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=…`  lines `<user>\t<YYYY-MM-DD HH:MM:SS>\t<status>…` → `OK: n`
 * - `POST /iclock/cdata?…&table=OPERLOG` (and others)      `OK: 0`: not kept
 * - `GET  /iclock/getrequest?SN=<serial>`                  `OK`: no command for it
 * - `POST /iclock/devicecmd?SN=<serial>`                   `OK`
 *
 * The protocol has no password: a machine is its serial number, registered and active here, optionally sending only
 * from known addresses. It can only add punches of people who exist; it reads nothing. An unregistered serial is
 * refused and remembered — at most {@link PENDING_LIMIT} waiting — for a manager to approve.
 *
 * Each line is kept once (`attendance.device.punch`); a person's punches are then **replayed in order** into
 * check-ins and check-outs, so a backlog sent late or twice gives the same days. Approved days are never changed.
 *
 * - `POST /api/v1/attendance/devices/:id/apply`  managers: matches the punches of numbers unknown until now, and
 *   replays them
 */
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from './.kosh/bindings.js';
import { addDays, instantOf, localDate, recomputeDays, timeZoneOf } from './days.js';

/** Unregistered machines remembered for approval. */
export const PENDING_LIMIT = 20;
/** A punch this long after a check-in is not its check-out: the check-in was never closed. */
const SHIFT_MS = 16 * 3_600_000;
/** A second tap. */
const TAP_MS = 60_000;
const SERIAL = /^[A-Za-z0-9_-]{4,64}$/;
const LINE = /^(\S{1,32})\s+(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\s|$)/;

/** A line of an attendance log: the person's number on the machine and its local time. */
export interface PushedPunch {
  readonly user: string;
  /** `YYYY-MM-DD HH:MM:SS`, as the machine's clock says. */
  readonly localTime: string;
}
/** The punches of an `ATTLOG` body; lines that are not punches are left out. */
export function parseAttlog(body: string): PushedPunch[] {
  const out: PushedPunch[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const found = LINE.exec(raw.trim());
    if (found === null) continue;
    out.push({
      user: found[1] as string,
      localTime: `${found[2]} ${found[3]}:${found[4]}:${found[5]}`,
    });
  }
  return out;
}
const instant = (localTime: string, tz: string): Date => {
  const [date, time] = localTime.split(' ') as [string, string];
  const [h, m, sec] = time.split(':').map(Number) as [number, number, number];
  return new Date(instantOf(date, h * 60 + m, tz).getTime() + sec * 1000);
};
/** A time zone's hours ahead of UTC now, as the machine wants it (`6`, `5.5`). */
const offsetHours = (tz: string): string => {
  const now = new Date();
  const local = instantOf(localDate(now, tz), 0, tz).getTime();
  const utc = Date.parse(`${localDate(now, tz)}T00:00:00Z`);
  return String(Math.round(((utc - local) / 3_600_000) * 100) / 100);
};

/**
 * Replays a person's pushed punches from `since` into check-ins and check-outs (RFC 0037 §2.3): the records made
 * from pushed punches from there on are made again from every punch kept, in order. A punch closes the open
 * check-in when it is between a minute and sixteen hours after it; otherwise it opens one. Days already approved
 * are left as they are. Returns the dates touched.
 */
export async function replayPunches(
  env: Env,
  employee: number,
  since: Date,
): Promise<{ from: string; to: string } | null> {
  const tz = await timeZoneOf(env);
  const [person] = await env
    .model('hr.employee')
    .browse([employee as never])
    .load({ company: true });
  if (person === undefined) return null;
  // Start where nothing is carried over: at the check-in that is still open at `since`, if there is one.
  const [carried] = await (
    await env.model('attendance.record').search({
      where: {
        employee: employee as never,
        source: 'push',
        checkIn: { lt: since },
        or: [{ checkOut: { isNull: true } }, { checkOut: { gte: since } }],
      },
      order: ['checkIn asc'],
      limit: 1,
    })
  ).load(['checkIn']);
  const start = carried?.checkIn ?? since;
  const approved = new Set(
    [
      ...(await (
        await env.model('attendance.day').search({
          where: {
            employee: employee as never,
            state: 'approved',
            date: { gte: addDays(localDate(start, tz), -1) },
          },
        })
      ).load(['date'])),
    ].map((d) => String(d.date).slice(0, 10)),
  );
  const frozen = (at: Date) => approved.has(localDate(at, tz));

  const old = await (
    await env.model('attendance.record').search({
      where: { employee: employee as never, source: 'push', checkIn: { gte: start } },
    })
  ).load(['checkIn']);
  const kept = new Set<number>();
  const stale: number[] = [];
  for (const r of old) {
    if (frozen(r.checkIn)) kept.add(r.checkIn.getTime());
    else stale.push(r.id);
  }
  if (stale.length > 0)
    await env
      .model('attendance.record')
      .browse(stale as never)
      .unlink();

  const punches = await (
    await env.model('attendance.device.punch').search({
      where: { employee: employee as never, at: { gte: start } },
      order: ['at asc', 'id asc'],
      limit: 20_000,
    })
  ).load(['at', 'outcome', 'device']);
  const outcomes = new Map<number, string>();
  const rows: { checkIn: Date; checkOut: Date | null; site: number | null }[] = [];
  const sites = new Map<number, number | null>();
  const siteOf = async (device: number): Promise<number | null> => {
    if (!sites.has(device)) {
      const [d] = await env
        .model('attendance.device')
        .browse([device as never])
        .load({ site: true });
      sites.set(device, (d?.site?.id as number | undefined) ?? null);
    }
    return sites.get(device) ?? null;
  };
  let open: { at: Date; id: number; device: number } | null = null;
  let last: Date | null = null;
  let first: Date | null = null;
  let final: Date | null = null;
  for (const p of punches) {
    if (frozen(p.at)) {
      // The day is approved: what was counted then stands; what arrives now is too late.
      outcomes.set(p.id, p.outcome === 'applied' ? 'applied' : 'late');
      continue;
    }
    if (last !== null && p.at.getTime() - last.getTime() < TAP_MS) {
      outcomes.set(p.id, 'duplicate');
      continue;
    }
    last = p.at;
    first ??= p.at;
    final = p.at;
    if (open !== null && p.at.getTime() - open.at.getTime() <= SHIFT_MS) {
      rows.push({ checkIn: open.at, checkOut: p.at, site: await siteOf(open.device) });
      outcomes.set(open.id, 'applied');
      outcomes.set(p.id, 'applied');
      open = null;
      continue;
    }
    if (open !== null) outcomes.set(open.id, 'unpaired');
    open = { at: p.at, id: p.id, device: p.device.id as number };
  }
  if (open !== null) {
    // Still inside a shift's length: the person is checked in. Older than that: never closed.
    if (Date.now() - open.at.getTime() <= SHIFT_MS) {
      rows.push({ checkIn: open.at, checkOut: null, site: await siteOf(open.device) });
      outcomes.set(open.id, 'applied');
    } else outcomes.set(open.id, 'unpaired');
  }
  const fresh = rows.filter((r) => !kept.has(r.checkIn.getTime()));
  if (fresh.length > 0)
    await env.model('attendance.record').create(
      fresh.map((r) => ({
        employee,
        company: person.company.id,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        source: 'push',
        site: r.site,
      })) as never,
    );
  for (const p of punches) {
    const outcome = outcomes.get(p.id);
    if (outcome !== undefined && outcome !== p.outcome)
      await env
        .model('attendance.device.punch')
        .browse([p.id as never])
        .write({ outcome } as never);
  }
  await env.flush();
  if (first === null || final === null) return null;
  const span = { from: localDate(start < first ? start : first, tz), to: localDate(final, tz) };
  await recomputeDays(env, [employee], span.from, span.to);
  return span;
}

/** Punches of a device as received: kept once, matched to people, and replayed. */
export async function takePunches(
  env: Env,
  device: number,
  punches: readonly PushedPunch[],
): Promise<{ received: number; kept: number; unknown: number }> {
  const tz = await timeZoneOf(env);
  // Numbers unknown until now may have their person since: they are taken with this batch.
  const waiting = await (
    await env
      .model('attendance.device.punch')
      .search({ where: { device: device as never, outcome: 'unknown' }, limit: 5000 })
  ).load(['userCode', 'at']);
  const codes = [...new Set([...punches.map((p) => p.user), ...waiting.map((w) => w.userCode)])];
  const people = new Map<string, number>();
  if (codes.length > 0)
    for (const e of await (
      await env.model('hr.employee').search({
        where: { or: [{ deviceUserId: { in: codes } }, { attendanceBadge: { in: codes } }] },
      })
    ).load(['deviceUserId', 'attendanceBadge'])) {
      if (e.deviceUserId !== null) people.set(e.deviceUserId, e.id);
      if (e.attendanceBadge !== null && !people.has(e.attendanceBadge))
        people.set(e.attendanceBadge, e.id);
    }
  const earliest = new Map<number, Date>();
  const touch = (employee: number, at: Date) => {
    const known = earliest.get(employee);
    if (known === undefined || at < known) earliest.set(employee, at);
  };
  for (const w of waiting) {
    const employee = people.get(w.userCode);
    if (employee === undefined) continue;
    await env
      .model('attendance.device.punch')
      .browse([w.id as never])
      .write({ employee, outcome: 'new' } as never);
    touch(employee, w.at);
  }
  // Once: a line received before (the same device, number and time) is not kept again.
  const seen = new Set(
    punches.length === 0
      ? []
      : [
          ...(await (
            await env.model('attendance.device.punch').search({
              where: {
                device: device as never,
                userCode: { in: [...new Set(punches.map((p) => p.user))] },
                localTime: { in: [...new Set(punches.map((p) => p.localTime))] },
              },
            })
          ).load(['userCode', 'localTime'])),
        ].map((p) => `${p.userCode} ${p.localTime}`),
  );
  let kept = 0;
  let unknown = 0;
  let latest: Date | null = null;
  const rows: Record<string, unknown>[] = [];
  for (const p of punches) {
    const key = `${p.user} ${p.localTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = instant(p.localTime, tz);
    if (Number.isNaN(at.getTime())) continue;
    const employee = people.get(p.user) ?? null;
    rows.push({
      device,
      userCode: p.user,
      localTime: p.localTime,
      at,
      employee,
      outcome: employee === null ? 'unknown' : 'new',
    });
    kept += 1;
    if (employee === null) unknown += 1;
    else touch(employee, at);
    if (latest === null || at > latest) latest = at;
  }
  if (rows.length > 0) await env.model('attendance.device.punch').create(rows as never);
  if (latest !== null)
    await env
      .model('attendance.device')
      .browse([device as never])
      .write({ lastPunchAt: latest } as never);
  await env.flush();
  for (const [employee, since] of earliest) await replayPunches(env, employee, since);
  return { received: punches.length, kept, unknown };
}

export function registerDeviceRoutes({ app, shutro }: ModuleContext): void {
  const system = <T>(reason: string, fn: (env: Env) => Promise<T>, company?: number): Promise<T> =>
    shutro.bootstrap(
      { reason: `attendance device: ${reason}`, ...(company === undefined ? {} : { company }) },
      async (raw) => {
        const env = raw as unknown as Env;
        const out = await fn(env);
        await env.flush();
        return out;
      },
    );
  const text = (reply: FastifyReply, status: number, body: string) =>
    reply.code(status).header('content-type', 'text/plain').send(body);

  /**
   * The machine of a request: registered, active, and sending from an address it may. Its visit is noted. An
   * unregistered serial is remembered for approval. Returns null when the request is refused.
   */
  const machine = async (
    request: FastifyRequest,
  ): Promise<{ id: number; serial: string; stamp: string | null } | null> => {
    const serial = String((request.query as { SN?: unknown } | null)?.SN ?? '');
    if (!SERIAL.test(serial)) return null;
    return system('visit', async (env) => {
      const found = await env.model('attendance.device').search({ where: { serial }, limit: 1 });
      const [device] = await found.load(['status', 'allowedAddresses', 'stamp']);
      if (device === undefined) {
        const pending = await env
          .model('attendance.device')
          .search({ where: { status: 'pending' } });
        if (pending.length < PENDING_LIMIT) {
          await env.model('attendance.device').create([
            {
              name: `Device ${serial}`,
              serial,
              status: 'pending',
              lastSeenAt: new Date(),
              lastAddress: request.ip,
            } as never,
          ]);
          await audit(env, {
            kind: 'attendance.device_knocked',
            summary: `An unregistered attendance device (${serial}) asked to send punches: waiting for approval.`,
            company: null,
            ip: request.ip,
          });
        }
        return null;
      }
      await found.write({ lastSeenAt: new Date(), lastAddress: request.ip } as never);
      if (device.status !== 'active') return null;
      const allowed = (device.allowedAddresses ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a !== '');
      if (allowed.length > 0 && !allowed.includes(request.ip)) return null;
      return { id: device.id as number, serial, stamp: device.stamp ?? null };
    });
  };

  void app.register(async (iclock) => {
    // Machines send text, with one content type or another, or none.
    for (const type of ['text/plain', '*'])
      iclock.addContentTypeParser(
        type,
        { parseAs: 'string', bodyLimit: 2_000_000 },
        (_request, body, done) => done(null, body),
      );
    const config = {
      config: {
        auth: false,
        rateLimit: {
          max: 600,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => `iclock:${request.ip}`,
        },
      },
    };

    iclock.get('/iclock/cdata', config, async (request, reply) => {
      const device = await machine(request);
      if (device === null) return text(reply, 401, 'Unauthorized');
      const tz = await system('options', (env) => timeZoneOf(env));
      return text(
        reply,
        200,
        [
          `GET OPTION FROM: ${device.serial}`,
          // What it has sent already: it sends only what is newer (everything, the first time).
          `ATTLOGStamp=${device.stamp ?? 'None'}`,
          'OPERLOGStamp=9999',
          'ATTPHOTOStamp=None',
          'ErrorDelay=30',
          'Delay=10',
          'TransTimes=00:00;14:05',
          'TransInterval=1',
          'TransFlag=TransData AttLog',
          `TimeZone=${offsetHours(tz)}`,
          'Realtime=1',
          'Encrypt=None',
          '',
        ].join('\n'),
      );
    });

    iclock.post('/iclock/cdata', config, async (request, reply) => {
      const device = await machine(request);
      if (device === null) return text(reply, 401, 'Unauthorized');
      const query = request.query as { table?: unknown; Stamp?: unknown };
      if (String(query.table ?? '').toUpperCase() !== 'ATTLOG') return text(reply, 200, 'OK: 0');
      const punches = parseAttlog(typeof request.body === 'string' ? request.body : '');
      const stamp = /^\d{1,32}$/.test(String(query.Stamp ?? '')) ? String(query.Stamp) : null;
      // Kept first, outside any company: a machine is nobody's in particular. Then each company takes the punches
      // of its own people (employees are seen within their company only).
      const companies = await system('punches', async (env) => {
        await takePunches(env, device.id, punches);
        return [...(await env.model('res.company').search({ where: {} })).ids] as number[];
      });
      for (const company of companies)
        await system('punches of a company', (env) => takePunches(env, device.id, []), company);
      await system('stamp', async (env) => {
        if (stamp !== null)
          await env
            .model('attendance.device')
            .browse([device.id as never])
            .write({ stamp } as never);
      });
      return text(reply, 200, `OK: ${punches.length}`);
    });

    iclock.get('/iclock/getrequest', config, async (request, reply) =>
      (await machine(request)) === null ? text(reply, 401, 'Unauthorized') : text(reply, 200, 'OK'),
    );
    iclock.post('/iclock/devicecmd', config, async (request, reply) =>
      (await machine(request)) === null ? text(reply, 401, 'Unauthorized') : text(reply, 200, 'OK'),
    );
  });

  app.post('/api/v1/attendance/devices/:id/apply', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'A device id.');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!(env.administrator || env.groups.has('attendance.manager')))
          throw new HttpProblem(
            403,
            'access',
            'Attendance managers',
            'This needs the Attendance manager role.',
          );
        return env.asSuperuser({ reason: 'device punches applied again' }, async (su) => {
          const found = await su.model('attendance.device').search({ where: { id: id as never } });
          if (found.length === 0)
            throw new HttpProblem(404, 'missing-record', 'Not found', `No device ${id}.`);
          const before = await su
            .model('attendance.device.punch')
            .search({ where: { device: id as never, outcome: 'unknown' } });
          await takePunches(su, id, []);
          const after = await su
            .model('attendance.device.punch')
            .search({ where: { device: id as never, outcome: 'unknown' } });
          return { matched: before.length - after.length, unknown: after.length };
        });
      },
      { write: true },
    );
  });
}
