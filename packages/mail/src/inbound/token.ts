/**
 * Reply addresses (RFC 0006 §7.1): every notification email of a record carries `Reply-To:
 * <alias>+<model>-<id>-<uid>-<token>@<domain>`, where the token is an HMAC of the model, the record and the
 * recipient with the installation's secret. A reply to that address proves the mail was sent by us to that
 * person about that record; nothing is guessable, and no `record-12@` aliases exist.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a reply address names. */
export interface ReplyTarget {
  readonly model: string;
  readonly id: number;
  /** The recipient (a `res.users` id). */
  readonly uid: number;
}

/** The installation's inbound settings (`MAIL_INBOUND_SECRET`, `MAIL_INBOUND_DOMAIN`, `MAIL_INBOUND_ALIAS`). */
export interface InboundConfig {
  readonly secret: string;
  readonly domain: string;
  readonly alias: string;
}

const TOKEN_LENGTH = 20;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase base32 (RFC 4648 alphabet) of the first bytes of `buffer`, without padding. */
function base32(buffer: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (out.length === length) return out;
    }
  }
  return out;
}

function tokenOf(secret: string, target: ReplyTarget): string {
  const mac = createHmac('sha256', secret)
    .update(`${target.model}:${target.id}:${target.uid}`)
    .digest();
  return base32(mac, TOKEN_LENGTH);
}

/** The inbound settings from the environment, or none when replies by email are not configured. */
export function inboundConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InboundConfig | undefined {
  const secret = env['MAIL_INBOUND_SECRET'];
  const domain = env['MAIL_INBOUND_DOMAIN'];
  if (secret === undefined || secret === '' || domain === undefined || domain === '')
    return undefined;
  return { secret, domain, alias: env['MAIL_INBOUND_ALIAS'] ?? 'reply' };
}

/** The reply address of a notification about `target` sent to `target.uid`. */
export function replyAddress(config: InboundConfig, target: ReplyTarget): string {
  return `${config.alias}+${target.model}-${target.id}-${target.uid}-${tokenOf(config.secret, target)}@${config.domain}`;
}

const ADDRESS = /^([^+@]+)\+([a-z0-9_.]+)-(\d{1,12})-(\d{1,12})-([a-z2-7]{20})@(.+)$/i;

/**
 * The target a reply address names, when the address is ours and its token is right; `null` for any other
 * address (a plain mailbox, a tampered token, another domain).
 */
export function parseReplyAddress(config: InboundConfig, address: string): ReplyTarget | null {
  const match = ADDRESS.exec(address.trim().toLowerCase());
  if (match === null) return null;
  const [, alias, model, id, uid, token, domain] = match;
  if (alias !== config.alias.toLowerCase() || domain !== config.domain.toLowerCase()) return null;
  const target: ReplyTarget = { model: String(model), id: Number(id), uid: Number(uid) };
  if (!Number.isSafeInteger(target.id) || target.id <= 0 || target.uid <= 0) return null;
  const expected = Buffer.from(tokenOf(config.secret, target));
  const given = Buffer.from(String(token));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return target;
}
