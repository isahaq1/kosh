/**
 * WebAuthn on Node's crypto (RFC 0034 §2.4, passkeys): what a browser's passkey sends at registration and at
 * sign-in, checked — the ceremony's type, our challenge, our origin, our relying-party id, that the person was
 * present and verified (a PIN, a fingerprint, a face), and at sign-in the signature by the key kept at registration.
 * No dependency: a CBOR reader for the two structures WebAuthn uses, COSE keys turned into Node keys.
 *
 * Attestation is not asked for (`attestation: "none"`) and its statement is not read: which make of authenticator
 * a person uses is not ours to decide.
 */
import { createHash, createPublicKey, constants as cryptoConstants, verify } from 'node:crypto';

/** Why a passkey's answer was refused. The message is for the audit log, not for the person. */
export class PasskeyError extends Error {}
const refuse = (why: string): never => {
  throw new PasskeyError(why);
};

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
export const fromB64url = (value: unknown, what: string): Buffer => {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9_-]+$/.test(value))
    return refuse(`${what} is not base64url`);
  return Buffer.from(value, 'base64url');
};
const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

// ---- CBOR (RFC 8949), the definite-length subset authenticators produce

type Cbor = number | Buffer | string | boolean | null | Cbor[] | Map<number | string, Cbor>;
/** Reads one CBOR item at `at`; returns it and where the next one starts. */
export function readCbor(bytes: Buffer, at = 0, depth = 0): [Cbor, number] {
  if (depth > 8) return refuse('CBOR nested too deep');
  const first = bytes[at];
  if (first === undefined) return refuse('CBOR ends early');
  const major = first >> 5;
  const info = first & 0x1f;
  let pos = at + 1;
  let length = info;
  if (info >= 24) {
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (size === 0 || major === 7) {
      if (major !== 7) return refuse('CBOR of indefinite length');
    } else {
      if (pos + size > bytes.length) return refuse('CBOR ends early');
      const wide = size === 8 ? Number(bytes.readBigUInt64BE(pos)) : bytes.readUIntBE(pos, size);
      if (!Number.isSafeInteger(wide)) return refuse('CBOR number too large');
      length = wide;
      pos += size;
    }
  }
  switch (major) {
    case 0:
      return [length, pos];
    case 1:
      return [-1 - length, pos];
    case 2:
    case 3: {
      if (pos + length > bytes.length) return refuse('CBOR ends early');
      const slice = bytes.subarray(pos, pos + length);
      return [major === 2 ? Buffer.from(slice) : slice.toString('utf8'), pos + length];
    }
    case 4: {
      if (length > 64) return refuse('CBOR array too long');
      const items: Cbor[] = [];
      for (let i = 0; i < length; i++) {
        const [item, next] = readCbor(bytes, pos, depth + 1);
        items.push(item);
        pos = next;
      }
      return [items, pos];
    }
    case 5: {
      if (length > 64) return refuse('CBOR map too long');
      const map = new Map<number | string, Cbor>();
      for (let i = 0; i < length; i++) {
        const [key, afterKey] = readCbor(bytes, pos, depth + 1);
        if (typeof key !== 'number' && typeof key !== 'string') return refuse('CBOR map key');
        const [value, next] = readCbor(bytes, afterKey, depth + 1);
        map.set(key, value);
        pos = next;
      }
      return [map, pos];
    }
    case 7:
      if (info === 20) return [false, pos];
      if (info === 21) return [true, pos];
      if (info === 22) return [null, pos];
      return refuse('CBOR value not supported');
    default:
      return refuse('CBOR tag not supported');
  }
}

// ---- COSE keys (RFC 9052) → a key Node verifies with

/** The signature algorithms accepted, by their COSE number: ES256, EdDSA, RS256. */
export const PASSKEY_ALGORITHMS: readonly number[] = [-7, -8, -257];
/** A COSE public key as SPKI (base64) with its algorithm. */
function coseKey(cose: Cbor): { publicKey: string; alg: number } {
  if (!(cose instanceof Map)) return refuse('the credential key is not a COSE key');
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (label: number): string => {
    const v = cose.get(label);
    return Buffer.isBuffer(v) ? b64url(v) : refuse('the credential key lacks a part');
  };
  let jwk: Record<string, string>;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1)
    jwk = { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) };
  else if (kty === 1 && alg === -8 && cose.get(-1) === 6)
    jwk = { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) };
  else if (kty === 3 && alg === -257) jwk = { kty: 'RSA', n: bytes(-1), e: bytes(-2) };
  else return refuse(`the credential key's algorithm (${String(alg)}) is not accepted`);
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (alg === -257 && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      return refuse('the credential key is too short');
    return {
      publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64'),
      alg: alg as number,
    };
  } catch (error) {
    if (error instanceof PasskeyError) throw error;
    return refuse('the credential key is not a valid key');
  }
}

// ---- the two ceremonies

/** What we expect of an answer: the challenge we gave, who we are, and where the page may be. */
export interface PasskeyExpectation {
  /** The challenge as given to the browser (base64url). */
  readonly challenge: string;
  /** The relying-party id: this installation's host name. */
  readonly rpId: string;
  /** Whether a page at this origin is ours. */
  readonly origin: (origin: string) => boolean;
}

function clientData(raw: Buffer, type: string, expected: PasskeyExpectation): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new PasskeyError('the client data is not JSON');
  }
  if (data['type'] !== type) refuse(`the ceremony is ${String(data['type'])}, not ${type}`);
  if (data['challenge'] !== expected.challenge) refuse('the challenge is not the one given');
  if (typeof data['origin'] !== 'string' || !expected.origin(data['origin']))
    refuse(`the page was at ${String(data['origin'])}, which is not this installation`);
  if (data['crossOrigin'] === true) refuse('the page was inside another site');
}

interface AuthData {
  readonly signCount: number;
  readonly backedUp: boolean;
  /** Where the attested credential data starts, when there is any. */
  readonly attested: number | null;
}
function authData(data: Buffer, expected: PasskeyExpectation): AuthData {
  if (data.length < 37) return refuse('the authenticator data is too short');
  if (!data.subarray(0, 32).equals(sha256(expected.rpId)))
    refuse('the authenticator answered for another site');
  const flags = data[32] as number;
  if ((flags & 0x01) === 0) refuse('the person was not present');
  // A passkey stands for both factors: the device, and the PIN or biometric that unlocked it.
  if ((flags & 0x04) === 0) refuse('the person was not verified by the device');
  return {
    signCount: data.readUInt32BE(33),
    backedUp: (flags & 0x10) !== 0,
    attested: (flags & 0x40) === 0 ? null : 37,
  };
}

/** A registered passkey, as kept. */
export interface PasskeyRegistration {
  /** base64url. */
  readonly credentialId: string;
  /** SPKI, base64. */
  readonly publicKey: string;
  readonly alg: number;
  readonly signCount: number;
  /** Synced by its provider (iCloud Keychain, Google Password Manager…): its counter stays 0. */
  readonly backedUp: boolean;
}

/** Checks a registration (`navigator.credentials.create`). @throws {PasskeyError} */
export function verifyPasskeyRegistration(
  response: { readonly clientDataJSON: unknown; readonly attestationObject: unknown },
  expected: PasskeyExpectation,
): PasskeyRegistration {
  clientData(fromB64url(response.clientDataJSON, 'clientDataJSON'), 'webauthn.create', expected);
  const [attestation] = readCbor(fromB64url(response.attestationObject, 'attestationObject'));
  const data = attestation instanceof Map ? attestation.get('authData') : undefined;
  if (!Buffer.isBuffer(data)) return refuse('the attestation has no authenticator data');
  const parsed = authData(data, expected);
  if (parsed.attested === null) return refuse('the attestation has no credential');
  if (data.length < parsed.attested + 18) return refuse('the credential data is too short');
  const idLength = data.readUInt16BE(parsed.attested + 16);
  const idStart = parsed.attested + 18;
  if (idLength === 0 || idLength > 1023 || data.length < idStart + idLength)
    return refuse('the credential id has an impossible length');
  const [cose] = readCbor(data, idStart + idLength);
  return {
    credentialId: b64url(data.subarray(idStart, idStart + idLength)),
    ...coseKey(cose),
    signCount: parsed.signCount,
    backedUp: parsed.backedUp,
  };
}

/**
 * Checks a sign-in (`navigator.credentials.get`) against the key kept at registration. Returns the authenticator's
 * new counter. @throws {PasskeyError}
 */
export function verifyPasskeyAssertion(
  response: {
    readonly clientDataJSON: unknown;
    readonly authenticatorData: unknown;
    readonly signature: unknown;
  },
  stored: { readonly publicKey: string; readonly alg: number; readonly signCount: number },
  expected: PasskeyExpectation,
): { signCount: number; backedUp: boolean } {
  const client = fromB64url(response.clientDataJSON, 'clientDataJSON');
  clientData(client, 'webauthn.get', expected);
  const data = fromB64url(response.authenticatorData, 'authenticatorData');
  const parsed = authData(data, expected);
  const signature = fromB64url(response.signature, 'signature');
  const signed = Buffer.concat([data, sha256(client)]);
  let ok = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(stored.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    ok =
      stored.alg === -8
        ? verify(null, signed, key, signature)
        : stored.alg === -257
          ? verify('sha256', signed, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signature)
          : stored.alg === -7
            ? verify('sha256', signed, key, signature) // ECDSA, DER-encoded as WebAuthn sends it
            : false;
  } catch {
    ok = false;
  }
  if (!ok) refuse('the signature is not by this passkey');
  // A counter that does not move forward means the key exists twice. Synced passkeys always say 0.
  if ((parsed.signCount !== 0 || stored.signCount !== 0) && parsed.signCount <= stored.signCount)
    refuse(
      `the passkey's counter went from ${stored.signCount} to ${parsed.signCount}: it may have been copied`,
    );
  return { signCount: parsed.signCount, backedUp: parsed.backedUp };
}
