/**
 * AWS Signature Version 4 for S3-compatible storage (header signing), on `node:crypto`. The S3 calls Kosh makes are
 * four (put, get, delete, create bucket); signing them is a page of well-specified code, so no SDK is needed.
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */
import { createHash, createHmac } from 'node:crypto';

/** SHA-256 of an empty payload. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256` (lowercase names). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body (`EMPTY_SHA256` without one). */
  readonly payloadHash: string;
  readonly date: Date;
  readonly service?: string;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as S3 expects it (`encodeURIComponent` leaves `!'()*` alone). */
function encode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The canonical URI: each path segment encoded once, slashes kept. */
function canonicalPath(url: URL): string {
  return url.pathname
    .split('/')
    .map((segment) => encode(decodeURIComponent(segment)))
    .join('/');
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** The headers to send: the given ones plus `x-amz-date`, `x-amz-content-sha256` and `authorization`. */
export function signRequest(input: SignInput, credentials: Credentials): Record<string, string> {
  const amzDate = input.date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const service = input.service ?? 's3';
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names
    .map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), credentials.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
