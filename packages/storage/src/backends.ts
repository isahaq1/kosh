/**
 * Where attachment bytes live (RFC 0006 §5.1): S3-compatible object storage in production (S3, SeaweedFS, MinIO),
 * a directory for development and tests. The database keeps only the metadata and the object key.
 */
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { type Credentials, EMPTY_SHA256, sha256Hex, signRequest } from './sigv4.js';

/** An object store. Keys are `[a-z0-9/._-]` paths chosen by Kosh, never by users. */
export interface Storage {
  readonly name: string;
  put(key: string, body: Uint8Array, mime: string): Promise<void>;
  /** The object's bytes as a stream. @throws {StorageError} `missing` when there is no such object */
  read(key: string): Promise<Readable>;
  /** Removes the object; a missing one is not an error. */
  delete(key: string): Promise<void>;
}

/** A storage failure: `missing` (no such object), `unavailable` (the store refused or could not be reached). */
export class StorageError extends Error {
  readonly code: 'missing' | 'unavailable';
  constructor(code: 'missing' | 'unavailable', message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

const KEY = /^[a-z0-9][a-z0-9/._-]{0,511}$/;

function checkKey(key: string): string {
  if (!KEY.test(key) || key.includes('..') || key.includes('//'))
    throw new StorageError('unavailable', `Invalid storage key '${key}'.`);
  return key;
}

/** Objects as files under a directory (development, tests, single-node installs with a backed-up volume). */
export class FileStorage implements Storage {
  readonly name = 'file';
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    const path = resolve(join(this.#root, checkKey(key)));
    if (!path.startsWith(this.#root + sep))
      throw new StorageError('unavailable', `Invalid key '${key}'.`);
    return path;
  }

  async put(key: string, body: Uint8Array, _mime?: string): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${process.pid}.partial`;
    await writeFile(partial, body);
    await rename(partial, path); // readers never see half a file
  }

  async read(key: string): Promise<Readable> {
    const path = this.#path(key);
    const stream = createReadStream(path);
    await new Promise<void>((done, fail) => {
      stream.once('open', () => done());
      stream.once('error', (e: NodeJS.ErrnoException) =>
        fail(
          e.code === 'ENOENT'
            ? new StorageError('missing', `No object '${key}'.`)
            : new StorageError('unavailable', e.message),
        ),
      );
    });
    return stream;
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}

export interface S3Options extends Partial<Pick<Credentials, 'region'>> {
  /** `https://s3.eu-west-1.amazonaws.com`, `http://localhost:8333` (SeaweedFS), ... */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetch?: typeof fetch;
}

/** S3-compatible object storage, path-style (`endpoint/bucket/key`), signed with SigV4. */
export class S3Storage implements Storage {
  readonly name = 's3';
  readonly #endpoint: string;
  readonly #bucket: string;
  readonly #credentials: Credentials;
  readonly #fetch: typeof fetch;

  constructor(options: S3Options) {
    this.#endpoint = options.endpoint.replace(/\/$/, '');
    this.#bucket = options.bucket;
    this.#credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region ?? 'us-east-1',
    };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #send(
    method: string,
    path: string,
    body?: Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const url = new URL(`${this.#endpoint}/${path}`);
    const signed = signRequest(
      {
        method,
        url,
        headers,
        payloadHash: body === undefined ? EMPTY_SHA256 : sha256Hex(body),
        date: new Date(),
      },
      this.#credentials,
    );
    try {
      return await this.#fetch(url, {
        method,
        headers: signed,
        ...(body === undefined
          ? {}
          : { body: body as unknown as NonNullable<RequestInit['body']> }),
      });
    } catch (error) {
      throw new StorageError(
        'unavailable',
        `S3 ${method} ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #fail(response: Response, what: string): Promise<never> {
    const text = (await response.text().catch(() => '')).slice(0, 300);
    throw new StorageError('unavailable', `S3 ${what}: HTTP ${response.status} ${text}`);
  }

  /** Creates the bucket when it does not exist (setup, tests). */
  async ensureBucket(): Promise<void> {
    const response = await this.#send('PUT', encodeURIComponent(this.#bucket));
    // 409: it exists already (BucketAlreadyOwnedByYou).
    if (!response.ok && response.status !== 409) await this.#fail(response, 'create bucket');
    else await response.body?.cancel();
  }

  #key(key: string): string {
    return `${encodeURIComponent(this.#bucket)}/${checkKey(key)}`;
  }

  async put(key: string, body: Uint8Array, mime: string): Promise<void> {
    const response = await this.#send('PUT', this.#key(key), body, { 'content-type': mime });
    if (!response.ok) await this.#fail(response, `put ${key}`);
    await response.body?.cancel();
  }

  async read(key: string): Promise<Readable> {
    const response = await this.#send('GET', this.#key(key));
    if (response.status === 404) {
      await response.body?.cancel();
      throw new StorageError('missing', `No object '${key}'.`);
    }
    if (!response.ok || response.body === null) return this.#fail(response, `get ${key}`);
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }

  async delete(key: string): Promise<void> {
    const response = await this.#send('DELETE', this.#key(key));
    if (!response.ok && response.status !== 404) await this.#fail(response, `delete ${key}`);
    await response.body?.cancel();
  }
}

/**
 * The storage configured by the environment: `KOSH_STORAGE_DIR` (a directory), or `S3_ENDPOINT`, `S3_BUCKET`,
 * `S3_ACCESS_KEY`, `S3_SECRET_KEY` (and `S3_REGION`). `null` when neither is set: uploads then answer 503.
 */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage | null {
  const dir = env['KOSH_STORAGE_DIR'];
  if (dir !== undefined && dir !== '') return new FileStorage(dir);
  const endpoint = env['S3_ENDPOINT'];
  const bucket = env['S3_BUCKET'];
  const accessKeyId = env['S3_ACCESS_KEY'];
  const secretAccessKey = env['S3_SECRET_KEY'];
  if (
    endpoint === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  )
    return null;
  return new S3Storage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(env['S3_REGION'] === undefined ? {} : { region: env['S3_REGION'] }),
  });
}
