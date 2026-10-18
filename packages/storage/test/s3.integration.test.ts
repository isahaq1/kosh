/** S3Storage against a real S3 API (SeaweedFS, as in docker-compose) with SigV4 authentication. */
import { text } from 'node:stream/consumers';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { S3Storage } from '../src/backends.js';

const CONFIG = JSON.stringify({
  identities: [
    {
      name: 'kosh',
      credentials: [{ accessKey: 'kosh', secretKey: 'kosh-secret' }],
      actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
    },
  ],
});

let container: StartedTestContainer;
let endpoint: string;

beforeAll(async () => {
  container = await new GenericContainer('chrislusf/seaweedfs:latest')
    .withCommand([
      'server',
      '-dir=/data',
      '-s3',
      '-s3.port=8333',
      '-s3.config=/etc/seaweedfs/s3.json',
    ])
    .withCopyContentToContainer([{ content: CONFIG, target: '/etc/seaweedfs/s3.json' }])
    .withExposedPorts(8333)
    .withWaitStrategy(
      Wait.forHttp('/', 8333).forStatusCodeMatching((code) => code === 200 || code === 403),
    )
    .withStartupTimeout(120_000)
    .start();
  endpoint = `http://${container.getHost()}:${container.getMappedPort(8333)}`;
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

test('put, read, delete with signed requests; wrong credentials are refused', async () => {
  const storage = new S3Storage({
    endpoint,
    bucket: 'kosh-test',
    accessKeyId: 'kosh',
    secretAccessKey: 'kosh-secret',
  });
  await storage.ensureBucket();
  await storage.ensureBucket(); // idempotent
  const body = new TextEncoder().encode('ব্যবসা — business\n'.repeat(1000));
  await storage.put('att/2026/10/x-1.txt', body, 'text/plain; charset=utf-8');
  expect(await text(await storage.read('att/2026/10/x-1.txt'))).toBe(
    'ব্যবসা — business\n'.repeat(1000),
  );
  await storage.delete('att/2026/10/x-1.txt');
  await expect(storage.read('att/2026/10/x-1.txt')).rejects.toMatchObject({ code: 'missing' });

  const intruder = new S3Storage({
    endpoint,
    bucket: 'kosh-test',
    accessKeyId: 'kosh',
    secretAccessKey: 'wrong',
  });
  await expect(intruder.put('att/x.txt', body, 'text/plain')).rejects.toMatchObject({
    code: 'unavailable',
  });
}, 120_000);
