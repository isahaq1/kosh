/**
 * Projects' routes (RFC 0026 step 3):
 *
 * - `GET /api/v1/projects/workload?from=YYYY-MM-DD&weeks=12`  each person's allocation week by week across the
 *   projects they are members of (active projects only): the highest total on any day of the week, with the projects
 *   behind it. Projects managers see everyone; others see themselves.
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from './.kosh/bindings.js';
import { peakAllocation } from './module.js';

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

export function registerProjectRoutes(context: ModuleContext): void {
  const { app } = context;
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
}
