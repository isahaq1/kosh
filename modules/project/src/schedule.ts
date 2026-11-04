/**
 * A project's schedule (RFC 0026 step 5): finish-to-start dependencies with a lag in days, the critical path by the
 * critical path method, and moving tasks that start before what they wait for is finished (keeping their length).
 * Dates are `YYYY-MM-DD`; a task's end is its deadline (inclusive). The pure functions are unit-tested; the database
 * ones run as the caller, so record rules decide what is scheduled.
 */
import type { Env } from './.kosh/bindings.js';

const DAY = 86_400_000;
const toDay = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const toIso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

export interface PlanTask {
  readonly id: number;
  readonly start: string | null;
  readonly end: string | null;
  /** Planned hours: the length in days (8 hours a day) of a task without both dates. */
  readonly hours: number;
  readonly predecessors: readonly { readonly id: number; readonly lag: number }[];
}

export interface Scheduled {
  readonly id: number;
  /** Earliest start and finish (inclusive), latest start and finish, as dates. */
  readonly earlyStart: string;
  readonly earlyFinish: string;
  readonly lateStart: string;
  readonly lateFinish: string;
  /** Days it may slip without moving the project's end. */
  readonly float: number;
  readonly critical: boolean;
}

/** The tasks in an order where each comes after what it waits for (links are acyclic: a constraint keeps them so). */
function ordered(tasks: readonly PlanTask[]): PlanTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: PlanTask[] = [];
  const seen = new Set<number>();
  const visit = (t: PlanTask, path: Set<number>) => {
    if (seen.has(t.id) || path.has(t.id)) return;
    path.add(t.id);
    for (const p of t.predecessors) {
      const pred = byId.get(p.id);
      if (pred !== undefined) visit(pred, path);
    }
    seen.add(t.id);
    out.push(t);
  };
  for (const t of tasks) visit(t, new Set());
  return out;
}

/** The length of a task in days (at least one). */
function lengthOf(t: PlanTask): number {
  if (t.start !== null && t.end !== null) return Math.max(toDay(t.end) - toDay(t.start) + 1, 1);
  return Math.max(Math.ceil(t.hours / 8), 1);
}

/**
 * The critical path method over `tasks` from `projectStart`: each task starts no earlier than its own start (when set)
 * and the day after each predecessor finishes plus the lag; the project ends with the last finish; working back,
 * each task's latest dates and its float. Tasks with no float are critical.
 */
export function criticalPath(tasks: readonly PlanTask[], projectStart: string): Scheduled[] {
  const order = ordered(tasks);
  const ids = new Set(tasks.map((t) => t.id));
  const es = new Map<number, number>();
  const ef = new Map<number, number>();
  const base = toDay(projectStart);
  for (const t of order) {
    let start = t.start === null ? base : toDay(t.start);
    for (const p of t.predecessors) {
      const finish = ef.get(p.id);
      if (finish !== undefined) start = Math.max(start, finish + 1 + p.lag);
    }
    es.set(t.id, start);
    ef.set(t.id, start + lengthOf(t) - 1);
  }
  const end = Math.max(...[...ef.values()], base);
  const successors = new Map<number, { id: number; lag: number }[]>();
  for (const t of tasks)
    for (const p of t.predecessors)
      if (ids.has(p.id))
        successors.set(p.id, [...(successors.get(p.id) ?? []), { id: t.id, lag: p.lag }]);
  const ls = new Map<number, number>();
  const lf = new Map<number, number>();
  for (const t of [...order].reverse()) {
    let finish = end;
    for (const s of successors.get(t.id) ?? []) {
      const start = ls.get(s.id);
      if (start !== undefined) finish = Math.min(finish, start - 1 - s.lag);
    }
    lf.set(t.id, finish);
    ls.set(t.id, finish - lengthOf(t) + 1);
  }
  return tasks.map((t) => {
    const float = (ls.get(t.id) ?? 0) - (es.get(t.id) ?? 0);
    return {
      id: t.id,
      earlyStart: toIso(es.get(t.id) ?? base),
      earlyFinish: toIso(ef.get(t.id) ?? base),
      lateStart: toIso(ls.get(t.id) ?? base),
      lateFinish: toIso(lf.get(t.id) ?? base),
      float,
      critical: float <= 0,
    };
  });
}

/**
 * The moves that put every dated task after what it waits for: a task starting before the day after a predecessor's
 * end plus the lag moves later, its end with it (its length kept); what waits for it follows in turn.
 */
export function slipMoves(
  tasks: readonly PlanTask[],
): { id: number; start: string; end: string; days: number }[] {
  const order = ordered(tasks);
  const start = new Map<number, number | null>();
  const end = new Map<number, number | null>();
  for (const t of tasks) {
    start.set(t.id, t.start === null ? null : toDay(t.start));
    end.set(t.id, t.end === null ? null : toDay(t.end));
  }
  const moves: { id: number; start: string; end: string; days: number }[] = [];
  for (const t of order) {
    const s = start.get(t.id) ?? null;
    if (s === null) continue;
    let required = s;
    for (const p of t.predecessors) {
      const finish = end.get(p.id);
      if (finish !== undefined && finish !== null)
        required = Math.max(required, finish + 1 + p.lag);
    }
    if (required === s) continue;
    const days = required - s;
    const e = end.get(t.id) ?? null;
    const newEnd = e === null ? required + lengthOf(t) - 1 : e + days;
    start.set(t.id, required);
    end.set(t.id, newEnd);
    moves.push({ id: t.id, start: toIso(required), end: toIso(newEnd), days });
  }
  return moves;
}

/** A date-only value as `YYYY-MM-DD`. */
function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (!(v instanceof Date)) return String(v).slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

export interface ScheduleRow extends Scheduled {
  readonly name: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly baselineStart: string | null;
  readonly baselineEnd: string | null;
  readonly done: boolean;
  readonly milestone: boolean;
  readonly progress: number;
  readonly predecessors: readonly { readonly id: number; readonly lag: number }[];
}

/** A project's top-level tasks as the caller sees them, for the schedule. */
async function planOf(
  env: Env,
  project: number,
): Promise<{
  tasks: PlanTask[];
  rows: Map<number, Omit<ScheduleRow, keyof Scheduled>>;
  start: string;
}> {
  const [p] = await env
    .model('project.project')
    .browse([project as never])
    .load(['dateStart']);
  const found = await env
    .model('project.task')
    .search({ where: { project, parentTask: { isNull: true } } as never })
    .then((r) =>
      r.load({
        predecessors: ['predecessor', 'lag'],
      }),
    );
  const rows = new Map<number, Omit<ScheduleRow, keyof Scheduled>>();
  const tasks: PlanTask[] = [];
  for (const t of found) {
    const predecessors = [...t.predecessors].map((l) => ({
      id: l.predecessor.id as number,
      lag: Number(l.lag ?? 0),
    }));
    const start = isoDate(t.dateStart);
    const end = isoDate(t.deadline);
    tasks.push({
      id: t.id as number,
      start,
      end,
      hours: Number(t.plannedHours ?? 0),
      predecessors,
    });
    rows.set(t.id as number, {
      name: String(t.name),
      start,
      end,
      baselineStart: isoDate(t.baselineStart),
      baselineEnd: isoDate(t.baselineEnd),
      done: t.done === true,
      milestone: t.milestone === true,
      progress: Number(t.progress ?? 0),
      predecessors,
    });
  }
  const starts = tasks.flatMap((t) => (t.start === null ? [] : [t.start])).sort();
  const start = isoDate(p?.dateStart) ?? starts[0] ?? new Date().toISOString().slice(0, 10);
  return { tasks, rows, start };
}

/** The schedule of a project: each task's dates, baseline, float and whether it is critical. */
export async function scheduleOf(
  env: Env,
  project: number,
): Promise<{ start: string; end: string; tasks: ScheduleRow[] }> {
  const { tasks, rows, start } = await planOf(env, project);
  const scheduled = criticalPath(tasks, start);
  const out = scheduled.map((s) => ({
    ...(rows.get(s.id) as Omit<ScheduleRow, keyof Scheduled>),
    ...s,
  }));
  out.sort((a, b) => a.earlyStart.localeCompare(b.earlyStart) || a.id - b.id);
  const end = out.reduce((m, r) => (r.earlyFinish > m ? r.earlyFinish : m), start);
  return { start, end, tasks: out };
}

/** Moves the project's tasks that start before what they wait for is finished; returns the moves. */
export async function applySlips(
  env: Env,
  project: number,
): Promise<{ id: number; start: string; end: string; days: number }[]> {
  const { tasks } = await planOf(env, project);
  const moves = slipMoves(tasks);
  for (const m of moves)
    await env
      .model('project.task')
      .browse([m.id as never])
      .write({ dateStart: m.start, deadline: m.end } as never);
  return moves;
}
