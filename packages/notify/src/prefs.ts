/**
 * A recipient's wishes (RFC 0006 §5.3, §8.1–8.2): whether a kind reaches them on a channel, how by email (instant,
 * daily, off), when their quiet hours end, and their digest hour and fallback channel. Read as the system.
 */
import type { Env } from '@kosh/server/orm';
import type { EmailMode } from './jobs.js';
import { minutesOf, quietUntil, zoneOf } from './quiet.js';

type Row = Record<string, unknown>;
interface Ref {
  search(q: unknown): Promise<{
    readonly length: number;
    load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  }>;
  browse(ids: readonly number[]): {
    load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  };
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
async function rows(env: Env, model: string, where: unknown, keys: string[]): Promise<Row[]> {
  const found = await ref(env, model).search({ where });
  return found.length === 0 ? [] : (await found.load(keys)).read(keys);
}

/** Kinds off on a channel unless the user switches them on (RFC 0006 §6.3: chat never emails by default). */
const OFF_BY_DEFAULT: ReadonlySet<string> = new Set(['chat.direct:email']);
/** Channels off for every kind unless the user switches them on (they cost money: SMS, WhatsApp). */
const OPT_IN_CHANNELS: ReadonlySet<string> = new Set(['sms', 'whatsapp']);

/** Whether a kind reaches a channel for a user who never set it: on, except the opt-in ones. */
export function defaultEnabled(kind: string, channel: string): boolean {
  return !OPT_IN_CHANNELS.has(channel) && !OFF_BY_DEFAULT.has(`${kind}:${channel}`);
}

/** The recipient's preference for the kind on a channel (the default unless they set it). */
export async function wants(su: Env, uid: number, kind: string, channel: string): Promise<boolean> {
  const [pref] = await rows(su, 'notify.preference', { user: uid, kind, channel }, ['enabled']);
  if (pref === undefined) return defaultEnabled(kind, channel);
  return pref['enabled'] === true;
}

/** How a kind reaches the recipient by email: their mode, else on / off as `enabled` (RFC 0006 §8.1). */
export async function emailModeOf(su: Env, uid: number, kind: string): Promise<EmailMode> {
  const [pref] = await rows(su, 'notify.preference', { user: uid, kind, channel: 'email' }, [
    'enabled',
    'mode',
  ]);
  if (pref === undefined) return defaultEnabled(kind, 'email') ? 'instant' : 'off';
  const mode = pref['mode'];
  if (mode === 'instant' || mode === 'daily' || mode === 'off') return mode;
  return pref['enabled'] === true ? 'instant' : 'off';
}

/** When the recipient's quiet hours end, if they are in them now (RFC 0006 §8.2); null: send now. */
export async function holdUntil(
  su: Env,
  uid: number,
  now: Date = new Date(),
): Promise<Date | null> {
  const [settings] = await rows(su, 'notify.settings', { user: uid }, [
    'quietFrom',
    'quietTo',
    'quietDays',
  ]);
  if (settings === undefined) return null;
  const [user] = (await ref(su, 'res.users').browse([uid]).load(['tz'])).read(['tz']);
  return quietUntil(
    now,
    {
      quietFrom: settings['quietFrom'] as string | null,
      quietTo: settings['quietTo'] as string | null,
      quietDays: Array.isArray(settings['quietDays']) ? (settings['quietDays'] as string[]) : null,
    },
    zoneOf(user?.['tz'] as string | null),
  );
}

/** The recipient's digest hour (minutes after local midnight), fallback channel and time zone. */
export async function deliverySettingsOf(
  su: Env,
  uid: number,
): Promise<{ readonly digestMinutes: number; readonly fallback: string; readonly tz: string }> {
  const [settings] = await rows(su, 'notify.settings', { user: uid }, ['digestHour', 'fallback']);
  const [user] = (await ref(su, 'res.users').browse([uid]).load(['tz'])).read(['tz']);
  return {
    digestMinutes: minutesOf(settings?.['digestHour'] as string | undefined) ?? 8 * 60,
    fallback: (settings?.['fallback'] as string | undefined) ?? 'email',
    tz: zoneOf(user?.['tz'] as string | null),
  };
}
