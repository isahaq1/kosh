/**
 * A software passkey for tests (RFC 0034 §2.4): what an authenticator and a browser do together — a P-256 key, the
 * attestation object of a registration, the signed assertion of a sign-in, with the client data a browser writes.
 * The test can make it misbehave (another origin, another site's id, no user verification, an old counter) to
 * prove each is refused.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

/** CBOR, the little an attestation needs: small ints, byte and text strings, maps. */
const head = (major: number, n: number): Buffer =>
  n < 24
    ? Buffer.from([(major << 5) | n])
    : n < 256
      ? Buffer.from([(major << 5) | 24, n])
      : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
const cbor = (value: unknown): Buffer => {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Map)
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]),
    ]);
  throw new Error('fake passkey: value not encoded');
};

export interface FakePasskeyOptions {
  /** The page's origin (`https://erp.example.test`). */
  readonly origin: string;
  /** The relying-party id; default: the origin's host name. */
  readonly rpId?: string;
}

export interface FakePasskey {
  /** The credential's id (base64url). */
  readonly id: string;
  /** Changes to the next answer. */
  tamper: {
    origin?: string;
    rpId?: string;
    /** The device did not verify the person. */
    unverified?: boolean;
    /** The counter this answer says, instead of the next one (an old one: a copy of the key answering). */
    counter?: number;
    /** Signed by another key. */
    foreignKey?: boolean;
    type?: string;
  };
  /** The answer of `navigator.credentials.create` to these options, as the page posts it. */
  register(options: { readonly challenge: string }): {
    id: string;
    type: 'public-key';
    response: { clientDataJSON: string; attestationObject: string };
  };
  /** The answer of `navigator.credentials.get` to these options. */
  signIn(options: { readonly challenge: string }): {
    id: string;
    type: 'public-key';
    response: { clientDataJSON: string; authenticatorData: string; signature: string };
  };
}

export function fakePasskey(options: FakePasskeyOptions): FakePasskey {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const foreign = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = randomBytes(32);
  const rpId = options.rpId ?? new URL(options.origin).hostname;
  let counter = 0;
  const passkey: FakePasskey = {
    id: b64(credentialId),
    tamper: {},
    register: ({ challenge }) => {
      const t = take();
      const jwk = keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
      const cose = cbor(
        new Map<number, unknown>([
          [1, 2], // kty: EC2
          [3, -7], // alg: ES256
          [-1, 1], // crv: P-256
          [-2, Buffer.from(jwk.x, 'base64url')],
          [-3, Buffer.from(jwk.y, 'base64url')],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        authenticatorData(t, true),
        Buffer.alloc(16), // aaguid
        length,
        credentialId,
        cose,
      ]);
      return {
        id: passkey.id,
        type: 'public-key',
        response: {
          clientDataJSON: clientData(t, 'webauthn.create', challenge),
          attestationObject: b64(
            cbor(
              new Map<string, unknown>([
                ['fmt', 'none'],
                ['attStmt', new Map()],
                ['authData', authData],
              ]),
            ),
          ),
        },
      };
    },
    signIn: ({ challenge }) => {
      const t = take();
      const client = clientData(t, 'webauthn.get', challenge);
      const authData = authenticatorData(t, false);
      const key: KeyObject = t.foreignKey === true ? foreign.privateKey : keys.privateKey;
      return {
        id: passkey.id,
        type: 'public-key',
        response: {
          clientDataJSON: client,
          authenticatorData: b64(authData),
          signature: b64(
            sign(
              'sha256',
              Buffer.concat([authData, sha256(Buffer.from(client, 'base64url'))]),
              key,
            ),
          ),
        },
      };
    },
  };
  /** This answer's tampering, cleared for the next. */
  const take = (): FakePasskey['tamper'] => {
    const t = passkey.tamper;
    passkey.tamper = {};
    return t;
  };
  const clientData = (t: FakePasskey['tamper'], type: string, challenge: string): string =>
    b64(
      Buffer.from(
        JSON.stringify({
          type: t.type ?? type,
          challenge,
          origin: t.origin ?? options.origin,
          crossOrigin: false,
        }),
      ),
    );
  const authenticatorData = (t: FakePasskey['tamper'], attested: boolean): Buffer => {
    if (t.counter === undefined) counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(t.counter ?? counter);
    // present, verified (unless tampered), and with a credential at registration
    const flags = 0x01 | (t.unverified === true ? 0 : 0x04) | (attested ? 0x40 : 0);
    return Buffer.concat([sha256(t.rpId ?? rpId), Buffer.from([flags]), count]);
  };
  return passkey;
}
