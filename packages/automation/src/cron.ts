/**
 * Cron expressions (RFC 0011 §5.1, `schedule` triggers): five fields (minute, hour, day of month, month, day of
 * week) with `*`, lists, ranges and steps, as in crontab; `@hourly`, `@daily`, `@weekly`, `@monthly` too. Times are
 * UTC. Enough for "every night at two", "every Monday morning", "every 15 minutes".
 */

export interface Cron {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
}

const ALIASES: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in '${part}'.`);
    let from = min;
    let to = max;
    if (range !== '*' && range !== undefined && range !== '') {
      const [a, b] = range.split('-');
      from = Number(a);
      to = b === undefined ? (stepText === undefined ? from : max) : Number(b);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to)
        throw new Error(`Bad range '${part}' (${min}–${max}).`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Parses an expression. @throws on a malformed one */
export function parseCron(expression: string): Cron {
  const text = ALIASES[expression.trim()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression has five fields.');
  const [m, h, d, mo, w] = parts as [string, string, string, string, string];
  return {
    minutes: field(m, 0, 59),
    hours: field(h, 0, 23),
    days: field(d, 1, 31),
    months: field(mo, 1, 12),
    weekdays: field(w.replace(/7/g, '0'), 0, 6),
  };
}

/** The first instant after `after` (strictly) that matches, within two years; `null` when none. */
export function nextRun(cron: Cron, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 2 * 366 * 24 * 60 * 60 * 1000;
  while (t.getTime() <= limit) {
    if (!cron.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.days.has(t.getUTCDate()) || !cron.weekdays.has(t.getUTCDay())) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

/** Whether a slot is due: the next run after `last` (or after `created` when it never ran) is at or before `now`. */
export function isDue(cron: Cron, last: Date | null, created: Date, now: Date): Date | null {
  const next = nextRun(cron, last ?? created);
  return next !== null && next.getTime() <= now.getTime() ? next : null;
}
