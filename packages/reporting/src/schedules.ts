/**
 * Scheduled reports (RFC 0005 §5): a `report.schedule` names a pivot, list or document over a model and a cadence
 * (daily / weekly / monthly at an hour, in the owner's time zone). A ticker enqueues due schedules as jobs (with a
 * key, so two server instances never enqueue the same run twice); the job renders **as the schedule's owner**
 * (their rules and field security), stores a `report.output` for the owner and recipients, and hands it to the
 * delivery adapters (the notification system of RFC 0006 plugs in here).
 *
 * The job queue is Shutro's (`env.enqueue` / `shutro.work`), behind {@link JobQueue}: swapping it for another
 * backend is this file only.
 */
import type { Env, Shutro } from '@isahaq/kosh-server/orm';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec: unknown): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
const ref = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    search(q: unknown): Promise<Rows>;
    browse(ids: readonly number[]): Rows;
    create(rows: readonly unknown[]): Promise<Rows>;
  };
async function rows(env: Env, name: string, where: unknown, keys: string[]): Promise<Row[]> {
  const found = await ref(env, name).search({ where });
  return found.length === 0 ? [] : (await found.load(keys)).read(keys);
}

/** A schedule as the engine reads it. */
export interface ScheduleSpec {
  readonly frequency: 'daily' | 'weekly' | 'monthly';
  readonly hour: number;
  readonly day: number;
  readonly tz: string;
}

/** The local date-time parts of an instant in `tz`. */
function partsIn(
  date: Date,
  tz: string,
): { y: number; m: number; d: number; h: number; weekday: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    y: Number(p['year']),
    m: Number(p['month']),
    d: Number(p['day']),
    h: Number(p['hour']),
    weekday: weekdays.indexOf(p['weekday'] ?? 'Mon') + 1,
  };
}

/** The instant of `y-m-d h:00` in `tz`. */
function instantOf(y: number, m: number, d: number, h: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h));
  const local = partsIn(guess, tz);
  const localAsUtc = Date.UTC(local.y, local.m - 1, local.d, local.h);
  return new Date(guess.getTime() - (localAsUtc - guess.getTime()));
}

/** The next run strictly after `after`. */
export function nextRun(spec: ScheduleSpec, after: Date): Date {
  const tz = spec.tz || 'UTC';
  const hour = Math.max(0, Math.min(23, spec.hour));
  const now = partsIn(after, tz);
  for (let offset = 0; offset < 400; offset++) {
    const candidate = new Date(Date.UTC(now.y, now.m - 1, now.d + offset));
    const c = partsIn(candidate, tz);
    const matches =
      spec.frequency === 'daily' ||
      (spec.frequency === 'weekly' && c.weekday === Math.max(1, Math.min(7, spec.day))) ||
      (spec.frequency === 'monthly' && c.d === Math.max(1, Math.min(28, spec.day)));
    if (!matches) continue;
    const at = instantOf(c.y, c.m, c.d, hour, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return new Date(after.getTime() + 86_400_000);
}

/** A rendered file. */
export interface Rendered {
  readonly filename: string;
  readonly mime: string;
  readonly content: Buffer;
}

/** Renders a schedule as `env`'s user (the owner); provided by the routes module, which owns the renderers. */
export type ScheduleRenderer = (env: Env, schedule: Row) => Promise<Rendered>;

/** Where outputs go besides the `report.output` record: email, chat, push (RFC 0006). */
export interface DeliveryAdapter {
  readonly name: string;
  deliver(
    env: Env,
    output: {
      readonly id: number;
      readonly schedule: Row;
      readonly file: Rendered;
      readonly recipients: readonly number[];
    },
  ): Promise<void>;
}

/** The job queue the engine uses (Shutro's by default). */
export interface JobQueue {
  enqueue(
    env: Env,
    name: string,
    payload: unknown,
    options: { readonly key: string },
  ): Promise<number | null>;
}

const JOB = 'report.run';

/** The schedule engine of one server. */
export class ScheduleEngine {
  readonly #shutro: Shutro;
  readonly #render: ScheduleRenderer;
  readonly #adapters: DeliveryAdapter[] = [];
  readonly #queue: JobQueue;
  #ticker: ReturnType<typeof setInterval> | undefined;
  #worker: { start(): void; stop(): Promise<void>; drain(): Promise<number> } | undefined;

  constructor(shutro: Shutro, render: ScheduleRenderer, queue?: JobQueue) {
    this.#shutro = shutro;
    this.#render = render;
    this.#queue = queue ?? {
      enqueue: (env, name, payload, options) => env.enqueue(name, payload, options),
    };
  }

  /** Adds a delivery adapter (RFC 0006 registers email, chat, push here). */
  use(adapter: DeliveryAdapter): this {
    this.#adapters.push(adapter);
    return this;
  }

  /** Sets `nextRunAt` of a schedule from its cadence (after `after`). */
  static plan(spec: ScheduleSpec, after: Date = new Date()): Date {
    return nextRun(spec, after);
  }

  /** Enqueues every due schedule (as its owner), once per due time. Returns how many were enqueued. */
  async tick(now: Date = new Date()): Promise<number> {
    const keys = ['createdBy', 'nextRunAt', 'frequency', 'hour', 'day', 'tz'];
    const { due, unplanned } = await this.#shutro.bootstrap(
      { reason: 'report schedules: tick' },
      async (env) => ({
        due: await rows(env, 'report.schedule', { nextRunAt: { lte: now }, active: true }, keys),
        unplanned: await rows(env, 'report.schedule', { nextRunAt: null, active: true }, keys),
      }),
    );
    for (const s of unplanned)
      await this.#shutro.bootstrap({ reason: 'report schedules: plan' }, (env) =>
        ref(env, 'report.schedule')
          .browse([s['id'] as number])
          .write({
            nextRunAt: nextRun(
              {
                frequency: s['frequency'] as ScheduleSpec['frequency'],
                hour: Number(s['hour']),
                day: Number(s['day']),
                tz: String(s['tz'] ?? 'UTC'),
              },
              now,
            ),
          }),
      );
    let count = 0;
    for (const s of due) {
      const owner = s['createdBy'] as number | null;
      const at = s['nextRunAt'] instanceof Date ? s['nextRunAt'] : new Date(String(s['nextRunAt']));
      const next = nextRun(
        {
          frequency: s['frequency'] as ScheduleSpec['frequency'],
          hour: Number(s['hour']),
          day: Number(s['day']),
          tz: String(s['tz'] ?? 'UTC'),
        },
        now,
      );
      // Advance first (as the system), then enqueue as the owner, so the job runs under their rules.
      await this.#shutro.bootstrap({ reason: 'report schedules: advance' }, (env) =>
        ref(env, 'report.schedule')
          .browse([s['id'] as number])
          .write({ nextRunAt: next }),
      );
      if (owner === null) continue;
      // The job runs as the owner, in their default company (their rules and field security).
      const ownerScope = await this.#shutro.bootstrap(
        { reason: 'report schedules: owner' },
        async (env) => {
          const [user] = await rows(env, 'res.users', { id: owner }, ['company']);
          if (user === undefined) return null; // archived owner: the schedule stays planned but never runs
          const company = typeof user['company'] === 'number' ? user['company'] : 1;
          const groups = (
            await rows(
              env,
              'auth.user_group',
              { user: owner, or: [{ company: null }, { company }] },
              ['group'],
            )
          ).map((g) => String(g['group']));
          return { user: owner, company, groups: [...new Set(groups)] };
        },
      );
      if (ownerScope === null) continue;
      const id = await this.#shutro.run(ownerScope, (env) =>
        this.#queue.enqueue(
          env,
          JOB,
          { schedule: s['id'], at: at.toISOString() },
          { key: `report:${s['id']}:${at.toISOString()}` },
        ),
      );
      if (id !== null) count++;
    }
    return count;
  }

  /** Renders a schedule now as `env`'s user, stores the output, delivers it. Returns the output id. */
  async run(env: Env, scheduleId: number): Promise<number> {
    const [schedule] = await rows(env, 'report.schedule', { id: scheduleId }, [
      'name',
      'targetModel',
      'kind',
      'query',
      'template',
      'format',
    ]);
    if (schedule === undefined)
      throw new Error(`Schedule ${scheduleId} is not readable by this user.`);
    const [withRecipients] = (
      await ref(env, 'report.schedule').browse([scheduleId]).load({ recipients: true })
    ).read(['recipients']);
    const recipients = [
      ...new Set([env.uid, ...((withRecipients?.['recipients'] as number[] | undefined) ?? [])]),
    ];
    let file: Rendered;
    try {
      file = await this.#render(env, schedule);
    } catch (error) {
      // The caller's transaction may be aborted by the failed statement: record the failure in its own transaction.
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await this.#shutro
        .bootstrap({ reason: 'report schedule: record failure' }, (su) =>
          ref(su, 'report.schedule')
            .browse([scheduleId])
            .write({ lastRunAt: new Date(), lastError: message }),
        )
        .catch(() => undefined);
      throw error;
    }
    const created = await env.asSuperuser(
      { reason: 'report schedule: store output' },
      async (su) => {
        const out = await ref(su, 'report.output').create([
          {
            schedule: scheduleId,
            name: String(schedule['name']),
            filename: file.filename,
            mime: file.mime,
            size: file.content.length,
            content: file.content,
            recipients: { set: recipients },
          },
        ]);
        await ref(su, 'report.schedule')
          .browse([scheduleId])
          .write({ lastRunAt: new Date(), lastError: null });
        return out.ids[0] as number;
      },
    );
    for (const adapter of this.#adapters)
      await adapter
        .deliver(env, { id: created, schedule, file, recipients })
        .catch(() => undefined); // delivery failures never fail the run (adapters retry on their own)
    return created;
  }

  /** The job worker (`report.run` jobs). */
  worker(): { start(): void; stop(): Promise<void>; drain(): Promise<number> } {
    this.#worker ??= this.#shutro.work({
      [JOB]: async (payload, env) => {
        const { schedule } = payload as { schedule: number };
        await this.run(env, schedule);
      },
    });
    return this.#worker;
  }

  /** Starts the ticker (every `everyMs`) and the worker. */
  start(everyMs = 60_000): void {
    this.worker().start();
    this.#ticker ??= setInterval(() => void this.tick().catch(() => undefined), everyMs);
    this.#ticker.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#ticker !== undefined) clearInterval(this.#ticker);
    this.#ticker = undefined;
    await this.#worker?.stop();
  }
}
