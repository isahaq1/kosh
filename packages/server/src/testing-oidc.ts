/**
 * A fake OpenID Connect provider for tests (RFC 0034 §2.4): discovery, an authorization endpoint that approves at
 * once as the person set by the test, a token endpoint that checks the client secret, the redirect address and the
 * PKCE verifier, and its published keys. The test can make it misbehave — a token for another audience, expired,
 * signed by another key — to prove each is refused.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakePerson {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  /** Any other claim of the ID token (`groups`). */
  readonly [claim: string]: unknown;
}

export interface FakeOidc {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Who the next authorization is approved as. */
  person: FakePerson;
  /** Changes to the next ID token's claims (`{ aud: 'another' }`, `{ exp: 1 }`, `{ nonce: 'x' }`). */
  tamper: Record<string, unknown>;
  /** Sign the next ID token with a key the provider does not publish. */
  foreignKey: boolean;
  close(): Promise<void>;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function fakeOidc(): Promise<FakeOidc> {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fake-key-1';
  const codes = new Map<
    string,
    { person: FakePerson; nonce: string; challenge: string; redirect: string }
  >();
  let issuer = '';
  const state: Pick<FakeOidc, 'person' | 'tamper' | 'foreignKey'> = {
    person: { sub: 'nobody' },
    tamper: {},
    foreignKey: false,
  };
  const idToken = (person: FakePerson, nonce: string, clientId: string, key: KeyObject) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT', kid });
    const body = b64({
      iss: issuer,
      aud: clientId,
      iat: now,
      exp: now + 300,
      nonce,
      ...person,
      ...state.tamper,
    });
    return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
  };
  const clientId = 'kosh-test-client';
  const clientSecret = 'a-secret-of-the-fake-provider';
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (url.pathname === '/jwks')
      return json(200, {
        keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }],
      });
    if (url.pathname === '/authorize') {
      // Approves at once, as the person the test set.
      const code = `code-${codes.size + 1}-${Date.now()}`;
      codes.set(code, {
        person: state.person,
        nonce: url.searchParams.get('nonce') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirect: url.searchParams.get('redirect_uri') ?? '',
      });
      const back = new URL(url.searchParams.get('redirect_uri') ?? issuer);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk) => {
        raw += String(chunk);
      });
      request.on('end', () => {
        const form = new URLSearchParams(raw);
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          grant === undefined ||
          form.get('client_id') !== clientId ||
          form.get('client_secret') !== clientSecret ||
          form.get('redirect_uri') !== grant.redirect ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        )
          return json(400, { error: 'invalid_grant' });
        return json(200, {
          token_type: 'Bearer',
          access_token: 'unused',
          id_token: idToken(
            grant.person,
            grant.nonce,
            clientId,
            state.foreignKey ? foreign.privateKey : keys.privateKey,
          ),
        });
      });
      return;
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    get person() {
      return state.person;
    },
    set person(value) {
      state.person = value;
    },
    get tamper() {
      return state.tamper;
    },
    set tamper(value) {
      state.tamper = value;
    },
    get foreignKey() {
      return state.foreignKey;
    },
    set foreignKey(value) {
      state.foreignKey = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
