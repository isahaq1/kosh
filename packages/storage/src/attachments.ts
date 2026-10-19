/**
 * Attachments on records: every function takes the caller's environment and checks the attached record as the
 * caller (ACL and record rules decide; a record they cannot see is a 404), so attachments never outlive the access
 * to their record. Bytes go to the {@link Storage}; the row keeps the metadata and the object key.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { HttpProblem } from '@isahaq/kosh-server';
import type { Env } from '@isahaq/kosh-server/orm';
import type { Storage } from './backends.js';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** An attachment as the API returns it. */
export interface AttachmentInfo {
  readonly id: number;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly resModel: string;
  readonly resId: number;
  readonly createdBy: number | null;
  readonly createdAt: string;
}

const KEYS = ['name', 'mime', 'size', 'resModel', 'resId', 'createdBy', 'createdAt', 'key'];

function info(row: Row): AttachmentInfo {
  const at = row['createdAt'];
  return {
    id: row['id'] as number,
    name: String(row['name']),
    mime: String(row['mime']),
    size: Number(row['size']),
    resModel: String(row['resModel']),
    resId: Number(row['resId']),
    createdBy: (row['createdBy'] as number | null) ?? null,
    createdAt: at instanceof Date ? at.toISOString() : String(at),
  };
}

/** Types a browser may show inline (with `nosniff` and a sandboxing CSP); everything else downloads. */
export const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/** A safe file name: no paths, no control characters, at most 255 characters. */
export function cleanName(raw: string): string {
  const name = Array.from(raw.normalize('NFC'))
    .filter((c) => (c.codePointAt(0) ?? 0) >= 0x20 && c !== '\u007f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, 255);
  return name === '' || name === '.' || name === '..' ? 'file' : name;
}

/** The media type without parameters, lowercase; unknown or malformed: `application/octet-stream`. */
export function cleanMime(raw: string | undefined): string {
  const base = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base)
    ? base
    : 'application/octet-stream';
}

/** Checks that `env` may read the record (ACL and rules, as the caller). @throws 404 / 403 otherwise */
export async function checkRecord(
  env: Env,
  models: ReadonlySet<string>,
  model: string,
  id: number,
): Promise<void> {
  if (!models.has(model))
    throw new HttpProblem(404, 'unknown-model', 'Unknown model', `No model '${model}'.`);
  await ref(env, model).browse([id]).load(['id']);
}

function canAttach(env: Env): void {
  if (!env.access.can('storage.attachment' as never, 'create'))
    throw new HttpProblem(
      403,
      'forbidden',
      'Forbidden',
      'Attachments need the Attachments access level.',
    );
}

/** Stores `data` on the record (`env` must read it) and returns the attachment. */
export async function saveAttachment(
  env: Env,
  storage: Storage,
  models: ReadonlySet<string>,
  input: {
    readonly model: string;
    readonly id: number;
    readonly name: string;
    readonly mime?: string | undefined;
    readonly data: Uint8Array;
  },
): Promise<AttachmentInfo> {
  canAttach(env);
  await checkRecord(env, models, input.model, input.id);
  const now = new Date();
  const key = `att/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
  const mime = cleanMime(input.mime);
  // The object first, then the row in this transaction: a failed commit leaves an orphan object, never a row
  // without its bytes.
  await storage.put(key, input.data, mime);
  const created = await ref(env, 'storage.attachment').create([
    {
      name: cleanName(input.name),
      mime,
      size: input.data.byteLength,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      key,
      resModel: input.model,
      resId: input.id,
    },
  ]);
  const [row] = (await created.load(KEYS)).read(['id', ...KEYS]);
  return info(row as Row);
}

/** The attachments of a record `env` may read, newest first. */
export async function attachmentsOf(
  env: Env,
  models: ReadonlySet<string>,
  model: string,
  id: number,
): Promise<AttachmentInfo[]> {
  await checkRecord(env, models, model, id);
  const found = await ref(env, 'storage.attachment').search({
    where: { resModel: model, resId: id },
    order: ['id desc'],
  });
  return found.length === 0 ? [] : (await found.load(KEYS)).read(['id', ...KEYS]).map(info);
}

/** Attachments by id, each checked through its record. @throws 404 for any `env` may not see */
export async function attachmentsById(
  env: Env,
  models: ReadonlySet<string>,
  ids: readonly number[],
): Promise<(AttachmentInfo & { readonly key: string })[]> {
  if (ids.length === 0) return [];
  const found = await ref(env, 'storage.attachment').search({ where: { id: { in: [...ids] } } });
  const rows = found.length === 0 ? [] : (await found.load(KEYS)).read(['id', ...KEYS]);
  if (rows.length !== new Set(ids).size)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such attachment.');
  const checked = new Set<string>();
  for (const row of rows) {
    const target = `${row['resModel']}#${row['resId']}`;
    if (checked.has(target)) continue;
    await checkRecord(env, models, String(row['resModel']), Number(row['resId']));
    checked.add(target);
  }
  return rows.map((row) => ({ ...info(row), key: String(row['key']) }));
}

/** An attachment's metadata and bytes, when `env` may read its record. */
export async function openAttachment(
  env: Env,
  storage: Storage,
  models: ReadonlySet<string>,
  id: number,
): Promise<{ readonly info: AttachmentInfo; readonly body: Readable }> {
  const [found] = await attachmentsById(env, models, [id]);
  if (found === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such attachment.');
  const { key, ...rest } = found;
  return { info: rest, body: await storage.read(key) };
}

/**
 * Removes attachments (their uploader, or an administrator) and returns the object keys to delete from the store
 * once the transaction committed.
 */
export async function removeAttachments(
  env: Env,
  models: ReadonlySet<string>,
  ids: readonly number[],
): Promise<string[]> {
  const found = await attachmentsById(env, models, ids);
  if (found.length === 0) return [];
  const mine = env.uid;
  if (!env.administrator && !env.su && found.some((a) => a.createdBy !== mine))
    throw new HttpProblem(
      403,
      'forbidden',
      'Forbidden',
      'Only the uploader removes an attachment.',
    );
  await ref(env, 'storage.attachment')
    .browse(found.map((a) => a.id))
    .unlink();
  return found.map((a) => a.key);
}

/** `Content-Disposition` with an ASCII fallback and the UTF-8 name (RFC 6266). */
export function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
