/**
 * Profile photos and company logos: small images (resized to 256 px in the browser) kept in the database, so they
 * work with or without file storage. PNG, JPEG or WebP only — checked by their bytes, never trusted from the name or
 * the type given; at most 300 KB. Served to signed-in users with a version in the URL, so browsers cache them.
 *
 * - `GET    /api/v1/images/:kind/:id`        `kind`: `user` or `company`; the image, or 404
 * - `PUT    /api/v1/auth/profile/avatar`     `{ image: 'data:image/…;base64,…' }`: your photo; `DELETE` removes it
 * - `PUT    /api/v1/images/company/:id`      a company's logo (Administrator or Settings / Company, one of your
 *                                            companies); `DELETE` removes it
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from './audit.js';
import type { AuthService } from './auth/service.js';
import { HttpProblem } from './errors.js';
import type { Env } from './orm.js';

const MAX_BYTES = 300 * 1024;
const KINDS = { user: 'res.users', company: 'res.company' } as const;
type Kind = keyof typeof KINDS;

type Row = Record<string, unknown>;
interface Records {
  readonly length: number;
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Records>;
  create(rows: readonly Row[]): Promise<Records>;
}
const images = (env: Env) => env.model('kosh.image' as never) as unknown as Ref;

/** The image's type from its first bytes: PNG, JPEG or WebP; anything else (SVG included) is refused. */
function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** The bytes of a `data:` URL, checked. @throws {HttpProblem} 422 */
function decode(input: unknown): { bytes: Buffer; mime: string } {
  const bad = (detail: string) => new HttpProblem(422, 'invalid-image', 'Invalid image', detail);
  const match =
    typeof input === 'string'
      ? /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(input)
      : null;
  if (match === null) throw bad('Send the image as a data URL (PNG, JPEG or WebP).');
  const bytes = Buffer.from(match[1] as string, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw bad('The image must be under 300 KB.');
  const mime = sniff(bytes);
  if (mime === null) throw bad('Only PNG, JPEG or WebP images.');
  return { bytes, mime };
}

/** The image versions of `ids` of a kind (a short digest), for URLs that change when the image does. */
export async function imageVersions(
  env: Env,
  kind: Kind,
  ids: readonly number[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const found = await images(env).search({
    where: { ownerModel: KINDS[kind], ownerId: { in: [...ids] } },
  });
  const rows =
    found.length === 0 ? [] : (await found.load(['ownerId', 'hash'])).read(['ownerId', 'hash']);
  return Object.fromEntries(rows.map((r) => [String(r['ownerId']), String(r['hash'])]));
}

async function store(
  env: Env,
  kind: Kind,
  id: number,
  input: unknown | null,
): Promise<string | null> {
  const existing = await images(env).search({ where: { ownerModel: KINDS[kind], ownerId: id } });
  if (input === null) {
    if (existing.length > 0) await existing.unlink();
    return null;
  }
  const { bytes, mime } = decode(input);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const values = { mime, data: bytes.toString('base64'), hash };
  if (existing.length > 0) await existing.write(values);
  else await images(env).create([{ ownerModel: KINDS[kind], ownerId: id, ...values }]);
  return hash;
}

export function registerImageRoutes(app: FastifyInstance, auth: AuthService): void {
  app.get('/api/v1/images/:kind/:id', async (request, reply) => {
    const { kind, id } = request.params as { kind?: string; id?: string };
    const owner = Number(id);
    if (!(kind === 'user' || kind === 'company') || !Number.isSafeInteger(owner) || owner <= 0)
      throw new HttpProblem(404, 'not-found', 'Not found', 'No such image.');
    const row = await request.env(
      (env) =>
        env.asSuperuser({ reason: 'image' }, async (su) => {
          const found = await images(su).search({
            where: { ownerModel: KINDS[kind], ownerId: owner },
          });
          return found.length === 0
            ? undefined
            : (await found.load(['mime', 'data', 'hash'])).read(['mime', 'data', 'hash'])[0];
        }),
      { write: true },
    );
    if (row === undefined) throw new HttpProblem(404, 'not-found', 'Not found', 'No image.');
    const etag = `"${String(row['hash'])}"`;
    reply
      .header('content-type', String(row['mime']))
      .header('etag', etag)
      .header('x-content-type-options', 'nosniff')
      // Versioned URLs (`?v=<hash>`) never change; plain ones are checked again after a minute.
      .header(
        'cache-control',
        (request.query as { v?: string }).v === undefined
          ? 'private, max-age=60'
          : 'private, max-age=31536000, immutable',
      );
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.send(Buffer.from(String(row['data']), 'base64'));
  });

  const own = async (request: FastifyRequest, image: unknown | null) => {
    const session = await auth.requireSession(request);
    const hash = await request.env(
      (env) =>
        env.asSuperuser({ reason: 'profile photo' }, async (su) => {
          const out = await store(su, 'user', session.user, image);
          await audit(env, {
            kind: 'auth.avatar',
            summary: image === null ? 'Profile photo removed.' : 'Profile photo changed.',
            targetModel: 'res.users',
            targetId: session.user,
          });
          await su.flush();
          return out;
        }),
      { write: true },
    );
    auth.forget(session.user);
    return { avatar: hash };
  };
  app.put('/api/v1/auth/profile/avatar', async (request) =>
    own(request, (request.body as Row | null)?.['image'] ?? ''),
  );
  app.delete('/api/v1/auth/profile/avatar', async (request) => own(request, null));

  const logo = async (request: FastifyRequest, image: unknown | null) => {
    const company = Number((request.params as { id?: string }).id);
    return request.env(
      async (env) => {
        if (!env.administrator && !env.groups.has('settings.company'))
          throw new HttpProblem(
            403,
            'access',
            'Company settings',
            'Changing the logo needs the Administrator role or the Settings / Company access.',
          );
        if (!env.administrator && !env.companyIds.includes(company))
          throw new HttpProblem(403, 'access', 'Company settings', 'Not one of your companies.');
        return env.asSuperuser({ reason: 'company logo' }, async (su) => {
          const hash = await store(su, 'company', company, image);
          await audit(env, {
            kind: 'settings.logo',
            summary: image === null ? 'Company logo removed.' : 'Company logo changed.',
            targetModel: 'res.company',
            targetId: company,
          });
          await su.flush();
          return { logo: hash };
        });
      },
      { write: true },
    );
  };
  app.put('/api/v1/images/company/:id', async (request) =>
    logo(request, (request.body as Row | null)?.['image'] ?? ''),
  );
  app.delete('/api/v1/images/company/:id', async (request) => logo(request, null));
}
