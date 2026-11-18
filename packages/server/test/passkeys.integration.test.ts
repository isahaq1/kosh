/**
 * Passkeys (RFC 0034 §2.4) on real PostgreSQL, with a software authenticator: a signed-in person adds a passkey and
 * signs in with it — no password, no code, and the session has its second factor —; an answer from another origin,
 * for another site, without the person verified, by another key, to a challenge used already, or with a counter
 * that did not move is refused with one answer; a removed passkey and a deactivated person cannot sign in; nobody
 * removes someone else's; everything is in the audit log.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { base, createServer, installBase, type KoshServer, totp } from '../src/index.js';
import { orm } from '../src/orm.js';
import { type FakePasskey, fakePasskey, type TestDatabase, testDatabase } from '../src/testing.js';

const PASSWORD = 'correct horse battery';
const BASE = 'https://erp.example.test';
const P = '/api/v1/auth/passkeys';

let container: TestDatabase;
let server: KoshServer;
let rumi = 0;
let laptop: FakePasskey;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const send = async (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token?: string,
  payload?: unknown,
) => {
  const res = await server.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
};
/** A password sign-in's token. */
const tokenOf = async (login: string): Promise<string> => {
  let token = tokens.get(login);
  if (token === undefined) {
    token = String(
      (await send('POST', '/api/v1/auth/login', undefined, { login, password: PASSWORD })).json
        .token,
    );
    tokens.set(login, token);
  }
  return token;
};
/** The person adds a passkey: options, the device's answer, the registration. */
const add = async (login: string, passkey: FakePasskey, name: string) => {
  const token = await tokenOf(login);
  const options = await send('POST', `${P}/register/options`, token, {});
  expect(options.status, JSON.stringify(options.json)).toBe(200);
  return send('POST', `${P}/register`, token, { name, credential: passkey.register(options.json) });
};
/** A sign-in with a passkey: our challenge, the device's answer. */
const signIn = async (passkey: FakePasskey) => {
  const options = await send('POST', `${P}/signin/options`, undefined, {});
  expect(options.status).toBe(200);
  return send('POST', `${P}/signin`, undefined, { credential: passkey.signIn(options.json) });
};
const audited = async (kind: string) =>
  (
    await server.driver.query<{ summary: string }>({
      text: 'SELECT summary FROM audit_event WHERE kind = $1 ORDER BY id',
      params: [kind],
    })
  ).map((r) => r.summary);

beforeAll(async () => {
  container = await testDatabase();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [base],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    oauth: { baseUrl: BASE },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  for (const [login, name] of [
    ['rumi', 'Rumi'],
    ['tania', 'Tania'],
  ] as const) {
    const id = await auth.createUser({
      login,
      name,
      password: PASSWORD,
      company,
      companies: [company],
      groups: ['base.user'],
    });
    if (login === 'rumi') rumi = id;
  }
  laptop = fakePasskey({ origin: BASE });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('adding a passkey needs a session; the options say who we are and ask for a verified, kept passkey', async () => {
  expect((await send('POST', `${P}/register/options`, undefined, {})).status).toBe(401);
  expect((await send('GET', P)).status).toBe(401);
  const options = (await send('POST', `${P}/register/options`, await tokenOf('rumi'), {})).json;
  expect(options).toMatchObject({
    rp: { id: 'erp.example.test' },
    user: { name: 'rumi', displayName: 'Rumi' },
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: [],
  });
  expect(options.pubKeyCredParams.map((p: Json) => p.alg)).toEqual([-7, -8, -257]);
  expect(Buffer.from(options.challenge, 'base64url')).toHaveLength(32);
});

test('a registration is refused from another origin, for another site, unverified, or twice', async () => {
  const token = await tokenOf('rumi');
  const answer = async (change: FakePasskey['tamper']) => {
    const options = (await send('POST', `${P}/register/options`, token, {})).json;
    laptop.tamper = change;
    return send('POST', `${P}/register`, token, {
      name: 'My laptop',
      credential: laptop.register(options),
    });
  };
  for (const change of [
    { origin: 'https://erp.example.test.evil.example' },
    { rpId: 'evil.example' },
    { unverified: true },
    { type: 'webauthn.get' },
  ]) {
    const refused = await answer(change);
    expect(refused.status, JSON.stringify(change)).toBe(422);
    expect(refused.json.kind ?? refused.json.type, JSON.stringify(refused.json)).toBeDefined();
  }
  // No name; then the real one.
  const options = (await send('POST', `${P}/register/options`, token, {})).json;
  const credential = laptop.register(options);
  expect((await send('POST', `${P}/register`, token, { name: ' ', credential })).status).toBe(422);
  const made = await send('POST', `${P}/register`, token, { name: 'My laptop', credential });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  expect(made.json).toMatchObject({ name: 'My laptop', synced: false, lastUsedAt: null });
  // The same answer again: its challenge was used.
  expect((await send('POST', `${P}/register`, token, { name: 'Again', credential })).status).toBe(
    422,
  );
  // The same passkey with a fresh challenge: registered already.
  expect((await add('rumi', laptop, 'Again')).status).toBe(422);
  expect((await send('GET', P, token)).json.passkeys).toMatchObject([{ name: 'My laptop' }]);
  // What is kept is a public key: no secret.
  const [stored] = await server.driver.query<{ public_key: string; alg: number }>({
    text: 'SELECT public_key, alg FROM auth_passkey',
    params: [],
  });
  expect(stored?.alg).toBe(-7);
  expect(await audited('auth.passkey_added')).toEqual(['Passkey “My laptop” added.']);
  // The next options exclude it, so a device does not register twice.
  const next = (await send('POST', `${P}/register/options`, token, {})).json;
  expect(next.excludeCredentials).toEqual([{ type: 'public-key', id: laptop.id }]);
});

test('a passkey signs in: no password, no code, and the session has its second factor', async () => {
  const signedIn = await signIn(laptop);
  expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
  expect(signedIn.json.twoFactorRequired).toBe(false);
  const me = await send('GET', '/api/v1/auth/me', signedIn.json.token);
  expect(me.json.login).toBe('rumi');
  const [session] = await server.driver.query<{
    second_factor: boolean;
    two_factor_verified: boolean;
  }>({
    text: 'SELECT second_factor, two_factor_verified FROM auth_session ORDER BY id DESC LIMIT 1',
    params: [],
  });
  expect(session).toEqual({ second_factor: true, two_factor_verified: true });
  expect((await audited('auth.login')).at(-1)).toBe('rumi signed in by a passkey.');
  const listed = (await send('GET', P, signedIn.json.token)).json.passkeys;
  expect(listed[0].lastUsedAt).not.toBeNull();
});

test('an account with an authenticator app owes no code after a passkey', async () => {
  // Tania turns two-factor sign-in on, then adds a passkey.
  const token = await tokenOf('tania');
  const setup = await send('POST', '/api/v1/auth/2fa/setup', token, {});
  await send('POST', '/api/v1/auth/2fa/enable', token, { code: totp(setup.json.secret) });
  const phone = fakePasskey({ origin: BASE });
  expect((await add('tania', phone, 'My phone')).status).toBe(200);
  // By password she still owes her code…
  const byPassword = await send('POST', '/api/v1/auth/login', undefined, {
    login: 'tania',
    password: PASSWORD,
  });
  expect(byPassword.json.twoFactorRequired).toBe(true);
  // …and a session that owes its code cannot add a passkey.
  expect((await send('POST', `${P}/register/options`, byPassword.json.token, {})).status).toBe(401);
  // By passkey she is in.
  const byPasskey = await signIn(phone);
  expect(byPasskey.json.twoFactorRequired).toBe(false);
  expect((await send('GET', '/api/v1/auth/me', byPasskey.json.token)).json.login).toBe('tania');

  // Nobody removes someone else's passkey: Rumi is told there is none.
  const taniaKeys = (await send('GET', P, byPasskey.json.token)).json.passkeys;
  expect((await send('DELETE', `${P}/${taniaKeys[0].id}`, await tokenOf('rumi'))).status).toBe(404);
  expect((await signIn(phone)).status).toBe(200);
});

test('a sign-in is refused, with one answer, whatever is wrong', async () => {
  const wrong = async (change: FakePasskey['tamper']) => {
    laptop.tamper = change;
    return signIn(laptop);
  };
  for (const change of [
    { origin: 'https://evil.example' },
    { rpId: 'evil.example' },
    { unverified: true },
    { foreignKey: true },
    { type: 'webauthn.create' },
    { counter: 1 },
  ]) {
    const refused = await wrong(change);
    expect(refused.status, JSON.stringify(change)).toBe(401);
    expect(refused.json.detail).toBe('This passkey could not sign you in.');
  }
  // A passkey we never saw, and an answer replayed.
  expect((await signIn(fakePasskey({ origin: BASE }))).status).toBe(401);
  const options = (await send('POST', `${P}/signin/options`, undefined, {})).json;
  const credential = laptop.signIn(options);
  expect((await send('POST', `${P}/signin`, undefined, { credential })).status).toBe(200);
  expect((await send('POST', `${P}/signin`, undefined, { credential })).status).toBe(401);
  // A challenge of our own making, not the server's.
  const forged = laptop.signIn({ challenge: Buffer.alloc(32, 7).toString('base64url') });
  expect((await send('POST', `${P}/signin`, undefined, { credential: forged })).status).toBe(401);
  expect((await send('POST', `${P}/signin`, undefined, {})).status).toBe(401);

  const refusals = await audited('auth.passkey_refused');
  expect(refusals).toEqual(
    expect.arrayContaining([
      'Passkey “My laptop” refused: the page was at https://evil.example, which is not this installation.',
      'Passkey “My laptop” refused: the authenticator answered for another site.',
      'Passkey “My laptop” refused: the person was not verified by the device.',
      'Passkey “My laptop” refused: the signature is not by this passkey.',
    ]),
  );
  expect(refusals.some((r) => r.includes('it may have been copied'))).toBe(true);
  // Still good after all that.
  expect((await signIn(laptop)).status).toBe(200);
});

test('a deactivated person and a removed passkey cannot sign in', async () => {
  await server.driver.query({
    text: 'UPDATE res_users SET active = false WHERE id = $1',
    params: [rumi],
  });
  expect((await signIn(laptop)).status).toBe(401);
  await server.driver.query({
    text: 'UPDATE res_users SET active = true WHERE id = $1',
    params: [rumi],
  });
  const signedIn = await signIn(laptop);
  expect(signedIn.status).toBe(200);
  const [mine] = (await send('GET', P, signedIn.json.token)).json.passkeys;
  expect((await send('DELETE', `${P}/${mine.id}`, signedIn.json.token)).status).toBe(200);
  expect((await signIn(laptop)).status).toBe(401);
  expect(await audited('auth.passkey_removed')).toEqual(['Passkey “My laptop” removed.']);
  expect((await send('GET', P, signedIn.json.token)).json.passkeys).toEqual([]);
});
