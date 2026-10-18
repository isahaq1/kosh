/**
 * Credentials without dependencies (node:crypto): scrypt password hashes, RFC 6238 TOTP for two-factor
 * authentication, random tokens, and SHA-256 digests for values stored only as hashes (sessions, recovery codes).
 */
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;

function scrypt(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize('NFKC'),
      salt,
      keylen,
      { N: n, r, p, maxmem: SCRYPT.maxmem },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    );
  });
}

/** `scrypt$N$r$p$salt$hash` (base64url); the parameters travel with the hash, so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time check of a password against a stored hash (false for malformed hashes). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(
    password,
    Buffer.from(salt, 'base64url'),
    Number(n),
    Number(r),
    Number(p),
    expected.length,
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A random token (base64url). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 of a token (hex), as stored for sessions and recovery codes. */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ------------------------------------------------------------------------------------------------- TOTP (RFC 6238)

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (no padding), as authenticator apps expect secrets. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new RangeError('Not a base32 string.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new TOTP secret (160 bits, base32). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The TOTP code for `secret` at `time` (6 digits, 30 s steps, HMAC-SHA1: what authenticator apps use). */
export function totp(
  secret: string,
  time: number = Date.now(),
  digits = 6,
  stepSeconds = 30,
): string {
  const counter = Math.floor(time / 1000 / stepSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 15;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}

/** True when `code` matches the current step or one step either side (clock drift). */
export function verifyTotp(secret: string, code: string, time: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((drift) => {
    const expected = Buffer.from(totp(secret, time + drift * 30_000));
    const given = Buffer.from(code);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** The `otpauth://` URI authenticator apps scan. */
export function otpauthUri(secret: string, account: string, issuer = 'Kosh'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
