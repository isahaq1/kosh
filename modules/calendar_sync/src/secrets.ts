/**
 * A person's tokens for their other calendar, at rest (RFC 0034 §2.4): sealed with AES-256-GCM under a key that is
 * the server's alone — `KOSH_SECRETS_KEY`, from the environment or a secret manager, never in a record. Without
 * the key nothing can be sealed, and nobody connects a calendar. A sealed value that was tampered with, or sealed
 * under another key, opens as nothing.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const keyOf = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/** The server's key for secrets at rest; `null` when none is set (at least 32 characters). */
export function secretsKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env['KOSH_SECRETS_KEY'] ?? '';
  return key.length >= 32 ? key : null;
}

/** Seals `plain` under `secret`: `v1.<iv>.<tag>.<data>`, base64url. */
export function seal(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** Opens what {@link seal} made; `null` when it is not that, was changed, or was sealed under another key. */
export function open(sealed: string | null | undefined, secret: string): string | null {
  const [version, iv, tag, data] = (sealed ?? '').split('.');
  if (version !== 'v1' || iv === undefined || tag === undefined || data === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
