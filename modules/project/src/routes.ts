/**
 * Projects' routes (RFC 0026 step 3):
 *
 * - `GET /api/v1/projects/workload?from=YYYY-MM-DD&weeks=12`  each person's allocation week by week across the
 *   projects they are members of (active projects only): the highest total on any day of the week, with the projects
 *   behind it. Projects managers see everyone; others see themselves.
 * - `POST /api/v1/projects/refresh` `{ projects? }`             Projects managers: the booked and committed costs (from
 *   the bridges) and the health of active projects (these, or all), now; hourly too.
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from './.kosh/bindings.js';
import { type HealthRules, judgeHealth, peakAllocation } from './module.js';

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The Monday on or before `date` (YYYY-MM-DD). */
export function mondayOf(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  const weekday = (new Date(t).getUTCDay() + 6) % 7; // Monday 0
  return iso(t - weekday * DAY);
}

export interface WorkloadRow {
  readonly user: number;
  readonly name: string;
  /** The week's peak allocation, in %. */
  readonly weeks: readonly number[];
  readonly projects: readonly {
    readonly id: number;
    readonly name: string;
    readonly allocation: number;
    readonly from: string | null;
    readonly to: string | null;
  }[];
}

export async function workload(
  env: Env,
  from: string,
  weeks: number,
): Promise<{ weeks: string[]; people: WorkloadRow[] }> {
  const start = Date.parse(`${mondayOf(from)}T00:00:00Z`);
  const mondays = Array.from({ length: weeks }, (_, i) => iso(start + i * 7 * DAY));
  const last = iso(start + weeks * 7 * DAY - DAY);
  const everyone = env.administrator || env.groups.has('project.manager');
  const first = mondays[0] ?? last;
  const where: Record<string, unknown> = {
    'project.active': true,
    ...(everyone ? {} : { user: env.userId }),
  };
  const all = await env.asSuperuser({ reason: 'workload' }, async (su) =>
    (
      await su
        .model('project.member')
        .search({ where: where as never })
        .then((r) => r.load({ user: ['name'], project: ['name'] }))
    ).map((m) => ({
      user: m.user.id as number,
      name: String(m.user.name),
      project: m.project.id as number,
      projectName: String(m.project.name),
      allocation: m.allocation,
      from: m.dateFrom === null ? null : String(m.dateFrom),
      to: m.dateTo === null ? null : String(m.dateTo),
    })),
  );
  // Memberships that touch the weeks shown.
  const members = all.filter(
    (m) => (m.from === null || m.from <= last) && (m.to === null || m.to >= first),
  );
  const byUser = new Map<number, typeof members>();
  for (const m of members) byUser.set(m.user, [...(byUser.get(m.user) ?? []), m]);
  const people: WorkloadRow[] = [...byUser.values()]
    .map((rows) => ({
      user: rows[0]?.user ?? 0,
      name: rows[0]?.name ?? '',
      weeks: mondays.map((monday) =>
        peakAllocation(rows, monday, iso(Date.parse(`${monday}T00:00:00Z`) + 6 * DAY)),
      ),
      projects: rows.map((r) => ({
        id: r.project,
        name: r.projectName,
        allocation: r.allocation,
        from: r.from,
        to: r.to,
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { weeks: mondays, people };
}

/** A date-only value as `YYYY-MM-DD` (PostgreSQL dates may read as local midnights). */
function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (!(v instanceof Date)) return String(v).slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

/**
 * The booked and committed costs and the health of the active projects (`ids`, or all of the company), as the
 * system: the bridges' figures through `moneyOf()`, then the worst of schedule, late milestones and cost against the
 * company's thresholds. Returns how many were refreshed.
 */
export async function refreshProjects(su: Env, ids?: readonly number[]): Promise<number> {
  const found = await su.model('project.project').search({
    where: { active: true, ...(ids === undefined ? {} : { id: { in: ids as never } }) } as never,
  });
  if (found.ids.length === 0) return 0;
  const projects = await found.load({ company: true });
  const money = await su.model('project.project').browse(found.ids).moneyOf();
  const today = isoDate(su.today()) ?? new Date().toISOString().slice(0, 10);
  const late = new Map<number, number>();
  for (const t of await su
    .model('project.task')
    .search({
      where: {
        project: { in: found.ids as never },
        milestone: true,
        done: false,
        deadline: { lt: today },
      } as never,
    })
    .then((r) => r.load(['project'])))
    late.set(t.project.id as number, (late.get(t.project.id as number) ?? 0) + 1);
  const rules = new Map<number, HealthRules>();
  for (const p of projects) {
    const company = p.company.id as number;
    let r = rules.get(company);
    if (r === undefined) {
      const [c] = (
        await su
          .model('res.company')
          .browse([company as never])
          .load(['projectHealthBehindRisk', 'projectHealthBehindOff', 'projectHealthCostRisk'])
      ).read(['projectHealthBehindRisk', 'projectHealthBehindOff', 'projectHealthCostRisk']);
      r = {
        behindRisk: Number(c?.['projectHealthBehindRisk'] ?? 10),
        behindOff: Number(c?.['projectHealthBehindOff'] ?? 25),
        costRisk: Number(c?.['projectHealthCostRisk'] ?? 90),
      };
      rules.set(company, r);
    }
    const figures = money.get(p.id as number) ?? { booked: '0', committed: '0' };
    const spent = Number(p.labourCost ?? 0) + Number(figures.booked) + Number(figures.committed);
    const judged = judgeHealth(
      {
        today,
        dateStart: isoDate(p.dateStart),
        dateEnd: isoDate(p.dateEnd),
        progress: Number(p.progress ?? 0),
        milestonesLate: late.get(p.id as number) ?? 0,
        budget: Number(p.budget ?? 0),
        spent,
      },
      r,
    );
    await su
      .model('project.project')
      .browse([p.id])
      .write({
        bookedCost: figures.booked,
        committedCost: figures.committed,
        healthComputed: judged.health,
        healthNotes: judged.reasons.join(' '),
        healthCheckedAt: new Date(),
      } as never);
  }
  // Phases past their end and not finished: late (what the overview and the Late filter read).
  const phases = await su
    .model('project.phase')
    .search({ where: { project: { in: found.ids as never } } as never })
    .then((r) => r.load(['dateEnd', 'status', 'late']));
  for (const ph of phases) {
    const end = isoDate(ph.dateEnd);
    const late = end !== null && end < today && !['done', 'cancelled'].includes(ph.status);
    if (late !== ph.late)
      await su
        .model('project.phase')
        .browse([ph.id])
        .write({ late } as never);
  }
  await su.flush();
  return projects.length;
}

export function registerProjectRoutes(context: ModuleContext): void {
  const { app, shutro } = context;
  app.post('/api/v1/projects/refresh', async (request) => {
    const body = (request.body ?? {}) as { projects?: unknown };
    const ids = Array.isArray(body.projects)
      ? body.projects.filter((x): x is number => Number.isSafeInteger(x))
      : undefined;
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.groups.has('project.manager'))
          throw new HttpProblem(
            403,
            'access',
            'Projects managers',
            'This needs the Projects manager role.',
          );
        // The projects as the manager sees them, refreshed as the system.
        const visible =
          ids === undefined
            ? undefined
            : ((await env.model('project.project').search({ where: { id: { in: ids as never } } }))
                .ids as unknown as number[]);
        return env.asSuperuser({ reason: 'project figures' }, async (su) => ({
          refreshed: await refreshProjects(su, visible),
        }));
      },
      { write: true },
    );
  });

  app.get('/api/v1/projects/workload', async (request) => {
    const query = request.query as { from?: string; weeks?: string };
    const from = query.from ?? new Date().toISOString().slice(0, 10);
    const weeks = query.weeks === undefined ? 12 : Number(query.weeks);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from)))
      throw new HttpProblem(422, 'invalid-date', 'Which week?', 'Give `from` as YYYY-MM-DD.');
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52)
      throw new HttpProblem(422, 'invalid-weeks', 'How many weeks?', '`weeks` is from 1 to 52.');
    // asSuperuser writes an audit row: the request runs in a write scope.
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.groups.has('project.user'))
          throw new HttpProblem(403, 'access', 'Projects users', 'This needs a Projects role.');
        return workload(env, from, weeks);
      },
      { write: true },
    );
  });

  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const run = async () => {
    try {
      const companies = await shutro.bootstrap(
        { reason: 'project figures' },
        async (env) =>
          (await (env as unknown as Env).model('res.company').search({}))
            .ids as unknown as number[],
      );
      for (const company of companies)
        await shutro.bootstrap({ reason: 'project figures', company }, (env) =>
          (env as unknown as Env).asSuperuser({ reason: 'project figures' }, (su) =>
            refreshProjects(su),
          ),
        );
    } catch (error) {
      app.log.error({ err: error }, 'project figures');
    }
  };
  const timer = setInterval(() => void run(), 3_600_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
