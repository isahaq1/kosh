import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, describe, expect, test } from 'vitest';
import { FileStorage, StorageError, storageFromEnv } from '../src/backends.js';
import { EMPTY_SHA256, signRequest } from '../src/sigv4.js';

describe('SigV4', () => {
  test('the GET Object example of the AWS documentation', () => {
    const headers = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: { range: 'bytes=0-9' },
        payloadHash: EMPTY_SHA256,
        date: new Date('2013-05-24T00:00:00Z'),
      },
      {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
      },
    );
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers).not.toHaveProperty('host'); // fetch sets it
  });
});

describe('FileStorage', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test('put, read, delete; missing objects; keys cannot leave the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kosh-storage-'));
    dirs.push(dir);
    const storage = new FileStorage(dir);
    await storage.put('att/2026/10/a.txt', new TextEncoder().encode('hello'), 'text/plain');
    expect(await text(await storage.read('att/2026/10/a.txt'))).toBe('hello');
    await storage.delete('att/2026/10/a.txt');
    await storage.delete('att/2026/10/a.txt'); // idempotent
    await expect(storage.read('att/2026/10/a.txt')).rejects.toMatchObject({ code: 'missing' });
    for (const key of ['../x', 'att/../../x', '/etc/passwd', 'A.txt', 'a//b'])
      await expect(storage.put(key, new Uint8Array(), 'x/y')).rejects.toBeInstanceOf(StorageError);
  });

  test('configuration from the environment', () => {
    expect(storageFromEnv({})).toBeNull();
    expect(storageFromEnv({ KOSH_STORAGE_DIR: '/var/kosh' })?.name).toBe('file');
    expect(
      storageFromEnv({
        S3_ENDPOINT: 'http://localhost:8333',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY: 'k',
        S3_SECRET_KEY: 's',
      })?.name,
    ).toBe('s3');
  });
});
