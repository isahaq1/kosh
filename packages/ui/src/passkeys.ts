/**
 * Passkeys in the browser (RFC 0034 §2.4): the WebAuthn calls, with the server's options turned into the buffers
 * the browser wants and its answer turned back into JSON. Nothing is decided here: the server makes the challenge
 * and checks the answer.
 */

const toBytes = (value: string): ArrayBuffer => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};
const toText = (buffer: ArrayBuffer): string => {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Whether this browser can make and use passkeys (it needs a secure page: https, or localhost). */
export const passkeysSupported = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential === 'function' &&
  typeof navigator.credentials?.create === 'function';

/** The person closed the browser's passkey dialog, or it timed out: nothing to report. */
export const passkeyCancelled = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === 'NotAllowedError' || error.name === 'AbortError');

/** The server's registration options, as `POST /api/v1/auth/passkeys/register/options` answers. */
export interface PasskeyCreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: AttestationConveyancePreference;
  readonly authenticatorSelection: AuthenticatorSelectionCriteria;
  readonly excludeCredentials: readonly { readonly type: 'public-key'; readonly id: string }[];
}
/** The server's sign-in options, as `POST /api/v1/auth/passkeys/signin/options` answers. */
export interface PasskeyRequestOptions {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout: number;
  readonly userVerification: UserVerificationRequirement;
}

/** Makes a passkey on this device; returns what to post to `…/passkeys/register` as `credential`. */
export async function createPasskey(options: PasskeyCreationOptions): Promise<unknown> {
  const made = (await navigator.credentials.create({
    publicKey: {
      challenge: toBytes(options.challenge),
      rp: options.rp,
      user: { ...options.user, id: toBytes(options.user.id) },
      pubKeyCredParams: [...options.pubKeyCredParams],
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: toBytes(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (made === null) throw new DOMException('No passkey was made.', 'NotAllowedError');
  const response = made.response as AuthenticatorAttestationResponse;
  return {
    id: made.id,
    type: made.type,
    response: {
      clientDataJSON: toText(response.clientDataJSON),
      attestationObject: toText(response.attestationObject),
    },
  };
}

/** Asks the device for a passkey of this address; returns what to post to `…/passkeys/signin` as `credential`. */
export async function getPasskey(options: PasskeyRequestOptions): Promise<unknown> {
  const got = (await navigator.credentials.get({
    publicKey: {
      challenge: toBytes(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
    },
  })) as PublicKeyCredential | null;
  if (got === null) throw new DOMException('No passkey was chosen.', 'NotAllowedError');
  const response = got.response as AuthenticatorAssertionResponse;
  return {
    id: got.id,
    type: got.type,
    response: {
      clientDataJSON: toText(response.clientDataJSON),
      authenticatorData: toText(response.authenticatorData),
      signature: toText(response.signature),
    },
  };
}
