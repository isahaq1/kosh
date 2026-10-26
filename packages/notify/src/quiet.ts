/**
 * Quiet hours (RFC 0006 §8.2): a user's quiet period in their own time zone — daily hours that may cross midnight
 * (22:00–07:00) and whole days off — and when it ends. Pure functions on instants; the time zone's offsets (and
 * daylight saving) come from `Intl`.
 */

/** A user's notification settings (`notify.settings`), as far as timing goes. */
export interface QuietSettings {
  /** `HH:MM`, local; with `quietTo`, the daily quiet hours. */
  readonly quietFrom?: string | null;
  readonly quietTo?: string | null;
  /** Whole days off: `mon` … `sun`. */
  readonly quietDays?: readonly string[] | null;
}

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` → minutes after midnight; null when not a time. */
export function minutesOf(value: string | null | undefined): number | null {
  const match = TIME.exec(value ?? '');
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/** A valid IANA time zone, else UTC. */
export function zoneOf(tz: string | null | undefined): string {
  if (tz === null || tz === undefined || tz === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The local weekday and minutes after midnight of an instant in a time zone. */
export function localTime(
  at: Date,
  tz: string,
): { readonly day: number; readonly minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zoneOf(tz),
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = DAYS.indexOf(get('weekday').toLowerCase().slice(0, 3) as (typeof DAYS)[number]);
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Minutes from `at` to the next local `minutes` (strictly later; at least one minute). */
function minutesUntil(at: Date, tz: string, minutes: number): number {
  const now = localTime(at, tz).minutes;
  const ahead = (minutes - now + 24 * 60) % (24 * 60);
  return ahead === 0 ? 24 * 60 : ahead;
}

/** Whether an instant falls in the quiet period. */
export function isQuiet(at: Date, settings: QuietSettings, tz: string): boolean {
  const { day, minutes } = localTime(at, tz);
  if ((settings.quietDays ?? []).includes(DAYS[day] ?? '')) return true;
  const from = minutesOf(settings.quietFrom);
  const to = minutesOf(settings.quietTo);
  if (from === null || to === null || from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * When the quiet period around `at` ends (the first instant that is not quiet), or null when `at` is not quiet.
 * Steps through adjacent periods (a day off ending into quiet morning hours); always ends within eight days.
 */
export function quietUntil(at: Date, settings: QuietSettings, tz: string): Date | null {
  if (!isQuiet(at, settings, tz)) return null;
  let t = at;
  for (let step = 0; step < 16 && isQuiet(t, settings, tz); step++) {
    const { day } = localTime(t, tz);
    const to = minutesOf(settings.quietTo);
    const offDay = (settings.quietDays ?? []).includes(DAYS[day] ?? '');
    // A day off ends at the next local midnight; quiet hours at `quietTo`.
    const ahead = offDay || to === null ? minutesUntil(t, tz, 0) : minutesUntil(t, tz, to);
    t = new Date(t.getTime() + ahead * 60_000);
    t = new Date(Math.floor(t.getTime() / 60_000) * 60_000); // on the minute
  }
  return isQuiet(t, settings, tz) ? null : t;
}
