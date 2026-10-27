/**
 * Kosh-native authentication on Shutro (CLAUDE.md, decided 2026-10-18): sessions, TOTP two-factor authentication,
 * recovery codes, passwords. All reads and writes go through Shutro in audited system scopes (`shutro.bootstrap`), on
 * the private models of the `base` module.
 *
 * Sessions: a random token (cookie `kosh_session`, httpOnly, SameSite=Lax; or `Authorization: Bearer`) stored as a
 * SHA-256 digest, with an idle timeout and an absolute lifetime. Cookie sessions need `X-CSRF-Token` on unsafe
 * methods. A session of a user with 2FA enabled is limited to `/auth/2fa/verify` and `/auth/logout` until verified.
 */
import type { FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { HttpProblem } from '../errors.js';
import type { RequestIdentity } from '../identity.js';
import type { Env, Shutro, VerifiedIdentity } from '../orm.js';
import { keepingAdministrator } from './admins.js';
import {
  digest,
  hashPassword,
  newTotpSecret,
  otpauthUri,
  randomToken,
  verifyPassword,
  verifyTotp,
} from './crypto.js';

/** Options of the session layer. */
export interface AuthOptions {
  /** `Secure` cookies (default true; turn off only for plain-HTTP development). */
  readonly secureCookies?: boolean;
  /** Idle timeout (default 12 h). */
  readonly idleMs?: number;
  /** Absolute session lifetime (default 7 days). */
  readonly lifetimeMs?: number;
  /** How long a session lookup is cached (default 5 s): bounds how long a revoked session keeps working elsewhere. */
  readonly cacheMs?: number;
}

/** A resolved session. */
export interface SessionInfo {
  readonly id: number;
  readonly user: number;
  readonly twoFactorRequired: boolean;
  /** A second factor was entered in this session: administrator groups need it (and 2FA still on). */
  readonly secondFactor: boolean;
  readonly via: 'cookie' | 'bearer';
}

/** A user's sign-in state as `/auth/me` returns it. */
export interface UserInfo {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly company: number | null;
  readonly companies: readonly number[];
  /** The number grouping of each of the user's companies (RFC 0016): `lakh` or `international`. */
  readonly groupings: Readonly<Record<string, 'international' | 'lakh'>>;
  readonly twoFactorEnabled: boolean;
  /** Holds an administrator role (in some company). */
  readonly administrator: boolean;
  /** Administrator rights are withheld until this session has a second factor (enable or verify 2FA). */
  readonly administratorNeedsSecondFactor: boolean;
}

export const SESSION_COOKIE = 'kosh_session';
const MIN_PASSWORD = 12;

// Loosely typed ORM access: these models belong to `base`, read with plain values here.
interface Records {
  readonly ids: readonly number[];
  readonly length: number;
  read(keys: readonly string[]): Record<string, unknown>[];
  write(values: unknown): Promise<void>;
  load(spec?: unknown): Promise<Records>;
}
interface Ref {
  search(query?: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly unknown[]): Promise<Records>;
}
const model = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
/** Milliseconds of a datetime value as Shutro returns it (`Date`, or an ISO text), or `null`. */
export function timeOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}
const one = (rows: Record<string, unknown>[]): Record<string, unknown> | undefined => rows[0];
/** Loads `keys` (scalar fields) and returns plain rows. */
async function fetch(
  records: Records | Promise<Records>,
  keys: readonly string[],
): Promise<Record<string, unknown>[]> {
  const set = await records;
  return set.length === 0 ? [] : (await set.load(keys)).read(keys);
}

function unauthenticated(type: string, detail: string, hint = 'Sign in again.'): HttpProblem {
  return new HttpProblem(401, type, 'Not authenticated', detail, hint);
}

/** Reads `name` from the Cookie header. */
export function cookieOf(request: FastifyRequest, name: string): string | undefined {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The authentication service of one server. */
export class AuthService {
  readonly #shutro: () => Shutro;
  readonly #options: Required<AuthOptions>;
  readonly #cache = new Map<string, { at: number; session: SessionInfo & { csrfHash: string } }>();
  readonly #dummy: Promise<string> = hashPassword(randomToken());

  constructor(shutro: () => Shutro, options: AuthOptions = {}) {
    this.#shutro = shutro;
    this.#options = {
      secureCookies: options.secureCookies ?? true,
      idleMs: options.idleMs ?? 12 * 3_600_000,
      lifetimeMs: options.lifetimeMs ?? 7 * 86_400_000,
      cacheMs: options.cacheMs ?? 5_000,
    };
  }

  #system<T>(reason: string, fn: (env: Env) => Promise<T>): Promise<T> {
    return this.#shutro().bootstrap({ reason: `auth: ${reason}` }, fn);
  }

  /** The `Set-Cookie` value for a session token (empty token: clears it). */
  cookie(token: string | null): string {
    const parts = [
      `${SESSION_COOKIE}=${token ?? ''}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${token === null ? 0 : Math.floor(this.#options.lifetimeMs / 1000)}`,
    ];
    if (this.#options.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  /** Hashes and sets a user's password. @throws {HttpProblem} 422 for a too-short password */
  async setPassword(env: Env, user: number, password: string): Promise<void> {
    if (password.length < MIN_PASSWORD)
      throw new HttpProblem(
        422,
        'weak-password',
        'Weak password',
        `Passwords have at least ${MIN_PASSWORD} characters.`,
      );
    const hash = await hashPassword(password);
    const existing = await model(env, 'auth.credential').search({ where: { user } });
    if (existing.length === 0)
      await model(env, 'auth.credential').create([{ user, passwordHash: hash }]);
    else await existing.write({ passwordHash: hash });
  }

  /** Creates a user with a password and group assignments (installation, tests, admin tools). */
  async createUser(input: {
    readonly login: string;
    readonly name: string;
    readonly password: string;
    readonly company?: number;
    readonly companies?: readonly number[];
    /** Group codes, all companies (`company` omitted) or per company. */
    readonly groups?: readonly (string | { readonly group: string; readonly company: number })[];
  }): Promise<number> {
    return this.#system(`create user ${input.login}`, async (env) => {
      const created = await model(env, 'res.users').create([
        {
          login: input.login,
          name: input.name,
          ...(input.company === undefined ? {} : { company: input.company }),
          ...(input.companies === undefined ? {} : { companies: { set: [...input.companies] } }),
        },
      ]);
      const user = created.ids[0] as number;
      await this.setPassword(env, user, input.password);
      const assignments = (input.groups ?? []).map((g) =>
        typeof g === 'string' ? { user, group: g } : { user, group: g.group, company: g.company },
      );
      if (assignments.length > 0) await model(env, 'auth.user_group').create(assignments);
      return user;
    });
  }

  /** Signs in: a new session (pending second factor when 2FA is on). @throws {HttpProblem} 401 */
  async login(
    request: FastifyRequest,
    login: string,
    password: string,
  ): Promise<{ token: string; csrfToken: string; twoFactorRequired: boolean }> {
    const outcome = await this.#system(`login ${login}`, async (env) => {
      const user = one(
        await fetch(model(env, 'res.users').search({ where: { login } }), ['login']),
      );
      const credential =
        user === undefined
          ? undefined
          : one(
              await fetch(model(env, 'auth.credential').search({ where: { user: user['id'] } }), [
                'passwordHash',
                'totpEnabled',
              ]),
            );
      const hash =
        typeof credential?.['passwordHash'] === 'string'
          ? (credential['passwordHash'] as string)
          : await this.#dummy;
      const ok =
        (await verifyPassword(password, hash)) && user !== undefined && credential !== undefined;
      if (!ok) return null;
      const token = randomToken();
      const csrfToken = randomToken(24);
      const now = Date.now();
      const twoFactorRequired = credential?.['totpEnabled'] === true;
      await model(env, 'auth.session').create([
        {
          tokenHash: digest(token),
          csrfHash: digest(csrfToken),
          user: user['id'],
          twoFactorVerified: !twoFactorRequired,
          expiresAt: new Date(now + this.#options.lifetimeMs),
          lastSeenAt: new Date(now),
          ip: request.ip,
          userAgent: String(request.headers['user-agent'] ?? '').slice(0, 300),
        },
      ]);
      await audit(env, {
        kind: 'auth.login',
        summary: `${login} signed in${twoFactorRequired ? ' (second factor pending)' : ''}.`,
        actor: user['id'] as number,
        company: null,
        ip: request.ip,
      });
      return { token, csrfToken, twoFactorRequired };
    });
    if (outcome === null) {
      // The failed attempt is audited in its own scope (the login scope stored nothing).
      await this.#system(`failed login ${login}`, (env) =>
        audit(env, {
          kind: 'auth.login_failed',
          summary: `Failed sign-in for ${login.slice(0, 100)}.`,
          details: { login: login.slice(0, 100) },
          ip: request.ip,
        }),
      );
      throw unauthenticated(
        'invalid-credentials',
        'The login or password is wrong.',
        'Check them and try again.',
      );
    }
    return outcome;
  }

  /** The request's session, or `null`. Cookie sessions need the CSRF header on unsafe methods. */
  async session(request: FastifyRequest): Promise<SessionInfo | null> {
    const header = String(request.headers.authorization ?? '');
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const token = bearer ?? cookieOf(request, SESSION_COOKIE);
    if (token === undefined || token === '') return null;
    const via = bearer === undefined ? 'cookie' : 'bearer';
    const tokenHash = digest(token);
    const cached = this.#cache.get(tokenHash);
    let session =
      cached !== undefined && Date.now() - cached.at < this.#options.cacheMs
        ? cached.session
        : undefined;
    if (session === undefined) {
      const found = await this.#system('session', async (env) => {
        const rows = await fetch(
          model(env, 'auth.session').search({ where: { tokenHash, revoked: false } }),
          ['user', 'twoFactorVerified', 'secondFactor', 'expiresAt', 'lastSeenAt', 'csrfHash'],
        );
        const row = one(rows);
        if (row === undefined) return null;
        const now = Date.now();
        const lastSeen = new Date(String(row['lastSeenAt'])).getTime();
        if (
          new Date(String(row['expiresAt'])).getTime() <= now ||
          lastSeen + this.#options.idleMs <= now
        )
          return null;
        if (now - lastSeen > 5 * 60_000)
          await model(env, 'auth.session')
            .browse([row['id'] as number])
            .write({ lastSeenAt: new Date(now) });
        const active =
          (await model(env, 'res.users').search({ where: { id: row['user'] } })).length > 0; // archived users cannot sign in
        return active ? row : null;
      });
      if (found === null) {
        this.#cache.delete(tokenHash);
        return null;
      }
      session = {
        id: found['id'] as number,
        user: found['user'] as number,
        twoFactorRequired: found['twoFactorVerified'] !== true,
        secondFactor: found['secondFactor'] === true,
        via,
        csrfHash: String(found['csrfHash']),
      };
      this.#cache.set(tokenHash, { at: Date.now(), session });
    }
    if (via === 'cookie' && UNSAFE.has(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || digest(csrf) !== session.csrfHash)
        throw new HttpProblem(
          403,
          'csrf',
          'CSRF check failed',
          'Cookie-authenticated requests that change data need the X-CSRF-Token header.',
          'Send the csrfToken returned at sign-in.',
        );
    }
    return {
      id: session.id,
      user: session.user,
      twoFactorRequired: session.twoFactorRequired,
      secondFactor: session.secondFactor,
      via: session.via,
    };
  }

  /** The verified session of a request. @throws {HttpProblem} 401 without one, or before the second factor */
  async requireSession(
    request: FastifyRequest,
    options: { readonly allowPending?: boolean } = {},
  ): Promise<SessionInfo> {
    const session = await this.session(request);
    if (session === null)
      throw unauthenticated(
        'unauthenticated',
        'This route needs a signed-in user.',
        'Sign in first.',
      );
    if (session.twoFactorRequired && options.allowPending !== true)
      throw unauthenticated(
        'two-factor-required',
        'Enter the code from your authenticator app first.',
        'POST /api/v1/auth/2fa/verify.',
      );
    return session;
  }

  /** Authenticator for the server (RFC 0002 §6.2): the session's user, company from `X-Company`, groups for it. */
  async authenticate(request: FastifyRequest): Promise<RequestIdentity | null> {
    const session = await this.session(request);
    if (session === null) return null;
    if (session.twoFactorRequired)
      throw unauthenticated(
        'two-factor-required',
        'Enter the code from your authenticator app first.',
        'POST /api/v1/auth/2fa/verify.',
      );
    const info = await this.#identityOf(session.user);
    if (info === null) return null;
    const asked = Number(request.headers['x-company']);
    const company =
      Number.isSafeInteger(asked) && info.companies.includes(asked)
        ? asked
        : (info.company ?? info.companies[0]);
    if (company === undefined)
      throw new HttpProblem(
        403,
        'no-company',
        'No company',
        'This user is not allowed in any company.',
        'An administrator assigns the companies of the user.',
      );
    // Mandatory 2FA for administrators (RFC 0003 §5.2): their administrator groups count only in sessions that
    // entered a second factor, while 2FA is on. The user keeps every other group.
    const elevated = session.secondFactor && info.twoFactorEnabled;
    const groups = info.assignments
      .filter((a) => a.company === null || a.company === company)
      .map((a) => a.group)
      .filter((g) => elevated || !info.administratorGroups.has(g));
    const now = Date.now();
    const grants = info.grants
      .filter(
        (g) =>
          (g.company === null || g.company === company) &&
          (g.expiresAt === null || g.expiresAt > now),
      )
      .map((g) => g.grant);
    return {
      user: session.user,
      company,
      companies: info.companies,
      groups: [...new Set(groups)],
      grants: [...new Set(grants)],
      lang: info.lang,
      tz: info.tz,
    };
  }

  /** Identity loader for Shutro (`createShutro({ identity })`): the user is active; companies and groups from the database. */
  async verify(uid: number): Promise<VerifiedIdentity | null> {
    const info = await this.#identityOf(uid);
    if (info === null) return null;
    const now = Date.now();
    return {
      companies: info.companies,
      // The closure (implied groups included): Shutro checks the groups a unit of work passes against these, and
      // what it passes may be a closure, e.g. the groups stored with an outbox event, replayed for its subscriber.
      groups: [
        ...(this.#shutro().registry?.security.closure(info.assignments.map((a) => a.group)) ??
          new Set(info.assignments.map((a) => a.group))),
      ],
      grants: [
        ...new Set(
          info.grants.filter((g) => g.expiresAt === null || g.expiresAt > now).map((g) => g.grant),
        ),
      ],
    };
  }

  async #identityOf(uid: number): Promise<{
    company: number | null;
    companies: number[];
    lang: string;
    tz: string;
    assignments: { group: string; company: number | null }[];
    grants: { grant: string; company: number | null; expiresAt: number | null }[];
    administratorGroups: ReadonlySet<string>;
    twoFactorEnabled: boolean;
  } | null> {
    return this.#system('identity', async (env) => {
      const users = await model(env, 'res.users').search({ where: { id: uid } });
      if (users.length === 0) return null; // unknown or archived
      const loaded = await users.load(['company', 'lang', 'tz']);
      const withCompanies = await loaded.load({ companies: true });
      const [row] = withCompanies.read(['company', 'companies', 'lang', 'tz']);
      const company = typeof row?.['company'] === 'number' ? (row['company'] as number) : null;
      const companies = [
        ...new Set([
          ...((row?.['companies'] as number[] | undefined) ?? []),
          ...(company === null ? [] : [company]),
        ]),
      ];
      const assignments = (
        await fetch(model(env, 'auth.user_group').search({ where: { user: uid } }), [
          'group',
          'company',
        ])
      ).map((a) => ({
        group: String(a['group']),
        company: typeof a['company'] === 'number' ? (a['company'] as number) : null,
      }));
      const grants = (
        await fetch(model(env, 'auth.user_grant').search({ where: { user: uid } }), [
          'grant',
          'company',
          'expiresAt',
        ])
      ).map((g) => ({
        grant: String(g['grant']),
        company: typeof g['company'] === 'number' ? (g['company'] as number) : null,
        expiresAt: timeOf(g['expiresAt']),
      }));
      const [credential] = await fetch(
        model(env, 'auth.credential').search({ where: { user: uid } }),
        ['totpEnabled'],
      );
      return {
        company,
        companies,
        lang: String(row?.['lang'] ?? 'en_US'),
        tz: String(row?.['tz'] ?? 'UTC'),
        assignments,
        grants,
        administratorGroups: env.access.administratorGroups(),
        twoFactorEnabled: credential?.['totpEnabled'] === true,
      };
    });
  }

  /** The signed-in user's state. */
  async me(session: SessionInfo): Promise<UserInfo> {
    return this.#system('me', async (env) => {
      const [user] = (
        await (
          await model(env, 'res.users').browse([session.user]).load(['login', 'name', 'company'])
        ).load({ companies: true })
      ).read(['login', 'name', 'company', 'companies']);
      const [credential] = await fetch(
        model(env, 'auth.credential').search({ where: { user: session.user } }),
        ['totpEnabled'],
      );
      const administrator = await this.#holdsAdministrator(env, session.user);
      const twoFactorEnabled = credential?.['totpEnabled'] === true;
      const companyIds = (user?.['companies'] as number[] | undefined) ?? [];
      const groupings: Record<string, 'international' | 'lakh'> = {};
      if (companyIds.length > 0)
        for (const c of await fetch(
          model(env, 'res.company').search({ where: { id: { in: companyIds } } }),
          ['numberGrouping'],
        ))
          groupings[String(c['id'])] = c['numberGrouping'] === 'lakh' ? 'lakh' : 'international';
      return {
        id: session.user,
        login: String(user?.['login']),
        name: String(user?.['name']),
        company: typeof user?.['company'] === 'number' ? (user['company'] as number) : null,
        companies: companyIds,
        groupings,
        twoFactorEnabled,
        administrator,
        administratorNeedsSecondFactor:
          administrator && !(session.secondFactor && twoFactorEnabled),
      };
    });
  }

  /** Revokes a session. */
  async logout(session: SessionInfo): Promise<void> {
    await this.#system('logout', async (env) => {
      await model(env, 'auth.session').browse([session.id]).write({ revoked: true });
      await audit(env, { kind: 'auth.logout', summary: 'Signed out.', actor: session.user });
    });
    this.#forgetUser(session.user, session.id);
  }

  #forgetUser(user: number, onlySession?: number): void {
    for (const [hash, entry] of this.#cache)
      if (
        entry.session.user === user &&
        (onlySession === undefined || entry.session.id === onlySession)
      )
        this.#cache.delete(hash);
  }

  /** Starts 2FA enrolment: a new secret, not active until confirmed with a code. */
  async setupTwoFactor(session: SessionInfo): Promise<{ secret: string; otpauthUri: string }> {
    return this.#system('2fa setup', async (env) => {
      const secret = newTotpSecret();
      const [user] = (await model(env, 'res.users').browse([session.user]).load(['login'])).read([
        'login',
      ]);
      const credentials = await model(env, 'auth.credential').search({
        where: { user: session.user },
      });
      const [current] = await fetch(credentials, ['totpEnabled']);
      if (current?.['totpEnabled'] === true)
        throw new HttpProblem(
          409,
          'two-factor-enabled',
          'Already enabled',
          'Two-factor authentication is already on.',
          'Disable it first to enrol a new device.',
        );
      if (credentials.length === 0)
        await model(env, 'auth.credential').create([{ user: session.user, totpSecret: secret }]);
      else await credentials.write({ totpSecret: secret });
      return { secret, otpauthUri: otpauthUri(secret, String(user?.['login'])) };
    });
  }

  /** Confirms enrolment with a code; returns ten recovery codes (shown once, stored as digests). */
  async enableTwoFactor(session: SessionInfo, code: string): Promise<{ recoveryCodes: string[] }> {
    return this.#system('2fa enable', async (env) => {
      const credentials = await model(env, 'auth.credential').search({
        where: { user: session.user },
      });
      const [row] = await fetch(credentials, ['totpSecret', 'totpEnabled']);
      if (typeof row?.['totpSecret'] !== 'string' || row['totpEnabled'] === true)
        throw new HttpProblem(
          409,
          'two-factor-not-pending',
          'Nothing to confirm',
          'Start with POST /api/v1/auth/2fa/setup.',
        );
      if (!verifyTotp(row['totpSecret'], code))
        throw new HttpProblem(
          422,
          'invalid-code',
          'Invalid code',
          'The code does not match.',
          'Use the current code of the authenticator app.',
        );
      const recoveryCodes = Array.from({ length: 10 }, () => randomToken(9));
      await credentials.write({ totpEnabled: true, recoveryCodes: recoveryCodes.map(digest) });
      // The code just entered is this session's second factor.
      await model(env, 'auth.session').browse([session.id]).write({ secondFactor: true });
      await audit(env, {
        kind: 'auth.2fa_enabled',
        summary: 'Two-factor authentication enabled.',
        actor: session.user,
      });
      await this.#auditAdministratorSession(env, session.user);
      return { recoveryCodes };
    });
  }

  /** Completes a pending sign-in with a TOTP or recovery code (a recovery code works once). */
  async verifyTwoFactor(session: SessionInfo, code: string): Promise<void> {
    await this.#system('2fa verify', async (env) => {
      const credentials = await model(env, 'auth.credential').search({
        where: { user: session.user },
      });
      const [row] = await fetch(credentials, ['totpSecret', 'totpEnabled', 'recoveryCodes']);
      const secret = row?.['totpSecret'];
      if (row?.['totpEnabled'] !== true || typeof secret !== 'string')
        throw new HttpProblem(
          409,
          'two-factor-off',
          'Two-factor authentication is off',
          'This account does not use a second factor.',
        );
      const recovery = (row['recoveryCodes'] as string[] | null) ?? [];
      const used = recovery.indexOf(digest(code.trim()));
      if (!verifyTotp(secret, code.trim()) && used < 0)
        throw new HttpProblem(
          422,
          'invalid-code',
          'Invalid code',
          'The code does not match.',
          'Use the current code of the authenticator app, or a recovery code.',
        );
      if (used >= 0)
        await credentials.write({ recoveryCodes: recovery.filter((_, i) => i !== used) });
      await model(env, 'auth.session')
        .browse([session.id])
        .write({ twoFactorVerified: true, secondFactor: true });
      await audit(env, {
        kind: 'auth.2fa_verified',
        summary:
          used >= 0
            ? 'Second factor: a recovery code (now used up).'
            : 'Second factor: authenticator code.',
        actor: session.user,
      });
      await this.#auditAdministratorSession(env, session.user);
    });
    this.#forgetUser(session.user, session.id);
  }

  async #holdsAdministrator(env: Env, user: number): Promise<boolean> {
    const codes = [...env.access.administratorGroups()];
    return (
      codes.length > 0 &&
      (await model(env, 'auth.user_group').search({ where: { user, group: { in: codes } } }))
        .length > 0
    );
  }

  /** Administrator sessions are audited when they start (when the second factor makes the user an administrator). */
  async #auditAdministratorSession(env: Env, user: number): Promise<void> {
    if (await this.#holdsAdministrator(env, user))
      await audit(env, {
        kind: 'admin.session',
        summary: 'Administrator session started.',
        actor: user,
      });
  }

  /** Turns 2FA off (password and a current code required). */
  async disableTwoFactor(session: SessionInfo, password: string, code: string): Promise<void> {
    await this.#system('2fa disable', async (env) => {
      const credentials = await model(env, 'auth.credential').search({
        where: { user: session.user },
      });
      const [row] = await fetch(credentials, ['passwordHash', 'totpSecret', 'totpEnabled']);
      const ok =
        typeof row?.['passwordHash'] === 'string' &&
        (await verifyPassword(password, row['passwordHash'])) &&
        typeof row['totpSecret'] === 'string' &&
        verifyTotp(row['totpSecret'], code);
      if (!ok)
        throw new HttpProblem(
          422,
          'invalid-credentials',
          'Invalid credentials',
          'The password or code is wrong.',
        );
      // Administrators need 2FA: turning it off for the last one is refused (credentials change only here).
      await keepingAdministrator(env, () =>
        credentials.write({ totpEnabled: false, totpSecret: null, recoveryCodes: null }),
      );
      await audit(env, {
        kind: 'auth.2fa_disabled',
        summary: 'Two-factor authentication disabled.',
        actor: session.user,
      });
    });
    this.#forgetUser(session.user);
  }

  /** Changes the password; every other session of the user is revoked. */
  async changePassword(session: SessionInfo, current: string, next: string): Promise<void> {
    await this.#system('password change', async (env) => {
      const [row] = await fetch(
        model(env, 'auth.credential').search({ where: { user: session.user } }),
        ['passwordHash'],
      );
      if (
        typeof row?.['passwordHash'] !== 'string' ||
        !(await verifyPassword(current, row['passwordHash']))
      )
        throw new HttpProblem(
          422,
          'invalid-credentials',
          'Invalid credentials',
          'The current password is wrong.',
        );
      await this.setPassword(env, session.user, next);
      const others = (
        await model(env, 'auth.session').search({ where: { user: session.user, revoked: false } })
      ).ids.filter((id) => id !== session.id);
      if (others.length > 0)
        await model(env, 'auth.session').browse(others).write({ revoked: true });
      await audit(env, {
        kind: 'auth.password_changed',
        summary: `Password changed; ${others.length} other session(s) revoked.`,
        actor: session.user,
      });
    });
    this.#forgetUser(session.user);
    this.#cache.clear(); // other sessions of this user, cached by token
  }
}
