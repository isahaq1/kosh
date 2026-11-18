/**
 * Passkeys (RFC 0034 §2.4, design of 2026-11-18): a person signs in with their device — a fingerprint, a face, a
 * PIN, a security key — instead of a password and a code. Phishing cannot take a passkey: the browser answers only
 * for this installation's address.
 *
 * - **Adding one** needs a full session (the second factor entered when the account has one). The device must
 *   verify the person, and keeps the passkey so no login has to be typed.
 * - **Signing in** with one is the whole sign-in: possession of the device and what unlocked it are two factors, so
 *   no code is owed and the session counts as having its second factor. A deactivated person is refused.
 * - Each challenge is ours, random, stored hashed, good for five minutes and used once.
 * - A counter that does not move forward (a copied key) refuses the sign-in and is audited.
 * - Passwords and authenticator codes stay as they are: a passkey is beside them, not instead of them, so a lost
 *   device locks nobody out. Where the policy asks for two-factor sign-in, the authenticator app is still set up.
 *
 * - `GET    /api/v1/auth/passkeys`                    your passkeys
 * - `POST   /api/v1/auth/passkeys/register/options`   what to pass to `navigator.credentials.create`
 * - `POST   /api/v1/auth/passkeys/register`           `{ name, credential }` → the passkey
 * - `DELETE /api/v1/auth/passkeys/:id`                removes one of yours
 * - `POST   /api/v1/auth/passkeys/signin/options`     public: what to pass to `navigator.credentials.get`
 * - `POST   /api/v1/auth/passkeys/signin`             public: `{ credential }` → the session, as a sign-in gives it
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { HttpProblem } from '../errors.js';
import type { Env, Shutro } from '../orm.js';
import type { AuthService } from './service.js';
import {
  PASSKEY_ALGORITHMS,
  PasskeyError,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
} from './webauthn.js';

type Row = Record<string, unknown>;
type Recs = {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<Recs>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
  unlink(): Promise<void>;
};
interface Loose {
  search(q: unknown): Promise<Recs>;
  create(values: unknown): Promise<Recs>;
}
const model = (env: Env, name: string): Loose => env.model(name as never) as unknown as Loose;
const rows = async (set: Recs | Promise<Recs>, keys: readonly string[]): Promise<Row[]> => {
  const s = await set;
  return s.length === 0 ? [] : (await s.load(keys)).read(['id', ...keys]);
};
const idOf = (v: unknown): number =>
  typeof v === 'object' && v !== null ? Number((v as { id: unknown }).id) : Number(v);
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const CHALLENGE_MS = 5 * 60_000;
/** Passkeys one person may keep. */
export const PASSKEYS_PER_PERSON = 20;

/**
 * Who this installation is to a browser, from its address: the relying-party id (its host name) and the origins
 * its pages are served from. On `localhost` any port is ours (development and tests).
 */
export function passkeyParty(baseUrl: string): {
  readonly rpId: string;
  readonly origin: (origin: string) => boolean;
} {
  const base = new URL(baseUrl);
  return {
    rpId: base.hostname,
    origin: (origin) => {
      if (origin === base.origin) return true;
      try {
        const url = new URL(origin);
        return base.hostname === 'localhost' && url.hostname === 'localhost';
      } catch {
        return false;
      }
    },
  };
}

export function registerPasskeyRoutes(
  app: FastifyInstance,
  auth: AuthService,
  shutro: () => Shutro,
  options: { readonly baseUrl: string; readonly name?: string; readonly signInLimit?: number },
): void {
  const party = passkeyParty(options.baseUrl);
  const system = <T>(reason: string, fn: (env: Env) => Promise<T>): Promise<T> =>
    shutro().bootstrap({ reason }, async (env) => {
      const out = await fn(env);
      await env.flush();
      return out;
    });
  /** A challenge of ours, remembered (hashed) for one use within five minutes. */
  const challenge = async (kind: 'register' | 'signin', user: number | null): Promise<string> => {
    const value = randomBytes(32).toString('base64url');
    await system('passkey challenge', (env) =>
      model(env, 'auth.passkey_challenge').create([
        {
          kind,
          challengeHash: sha256(value),
          user,
          expiresAt: new Date(Date.now() + CHALLENGE_MS),
        },
      ]),
    );
    return value;
  };
  /** The challenge a browser signed (read from its client data), if it is ours, unused and in time: used now. */
  const redeem = async (
    env: Env,
    kind: 'register' | 'signin',
    clientDataJSON: unknown,
    user: number | null,
  ): Promise<string | null> => {
    let value: unknown;
    try {
      value = (
        JSON.parse(Buffer.from(String(clientDataJSON), 'base64url').toString('utf8')) as Row
      )['challenge'];
    } catch {
      return null;
    }
    if (typeof value !== 'string' || value === '') return null;
    const set = await model(env, 'auth.passkey_challenge').search({
      where: { kind, challengeHash: sha256(value) },
      limit: 1,
    });
    const [row] = await rows(set, ['user', 'expiresAt', 'usedAt']);
    if (row === undefined || row['usedAt'] !== null) return null;
    await set.write({ usedAt: new Date() });
    if (new Date(String(row['expiresAt'])).getTime() <= Date.now()) return null;
    if (user !== null && idOf(row['user']) !== user) return null;
    return value;
  };
  const shown = (row: Row) => ({
    id: row['id'] as number,
    name: String(row['name']),
    /** Synced by its provider to the person's other devices. */
    synced: row['backedUp'] === true,
    createdAt: row['createdAt'] ?? null,
    lastUsedAt: row['lastUsedAt'] ?? null,
  });
  const KEYS = ['name', 'backedUp', 'createdAt', 'lastUsedAt'];
  const config = { config: { auth: false } };

  app.get('/api/v1/auth/passkeys', config, async (request) => {
    const session = await auth.requireSession(request);
    return system('passkeys', async (env) => ({
      passkeys: (
        await rows(
          model(env, 'auth.passkey').search({ where: { user: session.user }, order: ['id asc'] }),
          KEYS,
        )
      ).map(shown),
    }));
  });

  app.post('/api/v1/auth/passkeys/register/options', config, async (request) => {
    const session = await auth.requireSession(request);
    const person = await system('passkey registration', async (env) => {
      const [user] = await rows(model(env, 'res.users').search({ where: { id: session.user } }), [
        'login',
        'name',
      ]);
      const mine = await rows(
        model(env, 'auth.passkey').search({ where: { user: session.user } }),
        ['credentialId'],
      );
      return { user, mine };
    });
    if (person.user === undefined)
      throw new HttpProblem(401, 'unauthenticated', 'Not authenticated', 'Sign in first.');
    if (person.mine.length >= PASSKEYS_PER_PERSON)
      throw new HttpProblem(
        409,
        'passkey-limit',
        'Too many passkeys',
        `You have ${PASSKEYS_PER_PERSON} passkeys already.`,
        'Remove one you no longer use.',
      );
    return {
      challenge: await challenge('register', session.user),
      rp: { id: party.rpId, name: options.name ?? 'Shutro ERP' },
      user: {
        // An opaque handle: the person's id here, nothing about them.
        id: Buffer.from(`u${session.user}`).toString('base64url'),
        name: String(person.user['login']),
        displayName: String(person.user['name']),
      },
      pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
      timeout: CHALLENGE_MS,
      attestation: 'none',
      // Kept on the device (no login to type) and unlocked by the person (two factors in one).
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: person.mine.map((p) => ({
        type: 'public-key',
        id: String(p['credentialId']),
      })),
    };
  });

  app.post('/api/v1/auth/passkeys/register', config, async (request) => {
    const session = await auth.requireSession(request);
    const body = (request.body ?? {}) as Row;
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (name === '' || name.length > 60)
      throw new HttpProblem(
        422,
        'invalid',
        'Invalid name',
        'The passkey has a name of at most 60 characters.',
        'For example: My laptop.',
      );
    const response = (((body['credential'] ?? {}) as Row)['response'] ?? {}) as Row;
    const refused = (why: string) =>
      new HttpProblem(
        422,
        'passkey-invalid',
        'Passkey not added',
        'The device’s answer could not be accepted.',
        `Try again. (${why})`,
      );
    return system('passkey registered', async (env) => {
      const given = await redeem(env, 'register', response['clientDataJSON'], session.user);
      if (given === null) throw refused('the request took too long or was used already');
      let made: ReturnType<typeof verifyPasskeyRegistration>;
      try {
        made = verifyPasskeyRegistration(
          {
            clientDataJSON: response['clientDataJSON'],
            attestationObject: response['attestationObject'],
          },
          { challenge: given, ...party },
        );
      } catch (error) {
        if (!(error instanceof PasskeyError)) throw error;
        throw refused(error.message);
      }
      const taken = await model(env, 'auth.passkey').search({
        where: { credentialId: made.credentialId },
        limit: 1,
      });
      if (taken.length > 0) throw refused('this passkey is registered already');
      const created = await model(env, 'auth.passkey').create([
        {
          user: session.user,
          name,
          credentialId: made.credentialId,
          publicKey: made.publicKey,
          alg: made.alg,
          signCount: made.signCount,
          backedUp: made.backedUp,
        },
      ]);
      await audit(env, {
        kind: 'auth.passkey_added',
        summary: `Passkey “${name}” added.`.slice(0, 300),
        actor: session.user,
        company: null,
        targetModel: 'res.users',
        targetId: session.user,
        ip: request.ip,
      });
      const [row] = await rows(created, KEYS);
      return shown(row as Row);
    });
  });

  app.delete('/api/v1/auth/passkeys/:id', config, async (request) => {
    const session = await auth.requireSession(request);
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The id is a positive integer.');
    return system('passkey removed', async (env) => {
      // Yours only: someone else's id is as if it did not exist.
      const found = await model(env, 'auth.passkey').search({
        where: { id, user: session.user },
        limit: 1,
      });
      const [row] = await rows(found, ['name']);
      if (row === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `No passkey ${id}.`);
      await found.unlink();
      await audit(env, {
        kind: 'auth.passkey_removed',
        summary: `Passkey “${String(row['name'])}” removed.`.slice(0, 300),
        actor: session.user,
        company: null,
        targetModel: 'res.users',
        targetId: session.user,
        ip: request.ip,
      });
      return { ok: true };
    });
  });

  const limited = options.signInLimit !== 0;
  const publicConfig = {
    config: {
      auth: false,
      ...(limited
        ? {
            rateLimit: {
              max: options.signInLimit ?? 20,
              timeWindow: '15 minutes',
              keyGenerator: (request: FastifyRequest) => `passkey:${request.ip}`,
            },
          }
        : {}),
    },
  };
  app.post('/api/v1/auth/passkeys/signin/options', publicConfig, async () => ({
    challenge: await challenge('signin', null),
    rpId: party.rpId,
    timeout: CHALLENGE_MS,
    userVerification: 'required',
    // No list of credentials: the device offers the passkeys it keeps for this address.
    allowCredentials: [],
  }));

  app.post('/api/v1/auth/passkeys/signin', publicConfig, async (request, reply) => {
    const credential = (((request.body ?? {}) as Row)['credential'] ?? {}) as Row;
    const response = (credential['response'] ?? {}) as Row;
    const outcome = await system('passkey sign-in', async (env) => {
      const given = await redeem(env, 'signin', response['clientDataJSON'], null);
      const set =
        typeof credential['id'] !== 'string'
          ? null
          : await model(env, 'auth.passkey').search({
              where: { credentialId: credential['id'] },
              limit: 1,
            });
      const [passkey] =
        set === null ? [] : await rows(set, ['user', 'name', 'publicKey', 'alg', 'signCount']);
      if (given === null || set === null || passkey === undefined)
        return {
          user: null,
          why: given === null ? 'a challenge not ours, used or late' : 'an unknown passkey',
        };
      const user = idOf(passkey['user']);
      try {
        const verified = verifyPasskeyAssertion(
          {
            clientDataJSON: response['clientDataJSON'],
            authenticatorData: response['authenticatorData'],
            signature: response['signature'],
          },
          {
            publicKey: String(passkey['publicKey']),
            alg: Number(passkey['alg']),
            signCount: Number(passkey['signCount'] ?? 0),
          },
          { challenge: given, ...party },
        );
        await set.write({
          signCount: verified.signCount,
          backedUp: verified.backedUp,
          lastUsedAt: new Date(),
        });
        return { user, why: null };
      } catch (error) {
        if (!(error instanceof PasskeyError)) throw error;
        await audit(env, {
          kind: 'auth.passkey_refused',
          summary: `Passkey “${String(passkey['name'])}” refused: ${error.message}.`.slice(0, 300),
          actor: user,
          company: null,
          targetModel: 'res.users',
          targetId: user,
          ip: request.ip,
        });
        return { user: null, why: error.message };
      }
    });
    if (outcome.user === null)
      // One answer whatever was wrong: nothing to learn about which passkeys exist.
      throw new HttpProblem(
        401,
        'passkey-invalid',
        'Not authenticated',
        'This passkey could not sign you in.',
        'Try again, or sign in with your password.',
      );
    // The device and what unlocked it: both factors, so no code is owed.
    const result = await auth.signInAs(request, outcome.user, 'a passkey', { verified: true });
    reply.header('set-cookie', auth.cookie(result.token));
    return result;
  });
}
