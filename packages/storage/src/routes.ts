/**
 * Attachment routes (RFC 0006 §5.1). Every route checks the attached record as the caller first.
 *
 * - `POST   /api/v1/attachments/:model/:id`   the raw file as the body (`Content-Type`, `X-Filename` URI-encoded)
 * - `GET    /api/v1/attachments/:model/:id`   the record's attachments
 * - `GET    /api/v1/attachments/:id/download` the bytes (`?inline=true` shows images and PDFs in the browser)
 * - `DELETE /api/v1/attachments/:id`          by the uploader
 */
import { HttpProblem, type ModuleContext, publicApiModels } from '@kosh/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  attachmentsOf,
  cleanName,
  disposition,
  INLINE_TYPES,
  openAttachment,
  removeAttachments,
  saveAttachment,
} from './attachments.js';
import { type Storage, StorageError, storageFromEnv } from './backends.js';

/** Upload limit (`KOSH_ATTACHMENT_MAX_BYTES`, default 25 MB). */
export function maxAttachmentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env['KOSH_ATTACHMENT_MAX_BYTES'] ?? 25 * 1024 * 1024);
  return Number.isSafeInteger(value) && value > 0 ? value : 25 * 1024 * 1024;
}

const stores = new WeakMap<object, Storage>();

/** Sets the store of a server (instead of the environment's configuration). */
export function useStorage(app: object, storage: Storage): void {
  stores.set(app, storage);
}

/** The store of a server: the one set by {@link useStorage}, else the environment's. @throws 503 when none */
export function storageOf(app: object): Storage {
  let storage = stores.get(app);
  if (storage === undefined) {
    const configured = storageFromEnv();
    if (configured === null)
      throw new HttpProblem(
        503,
        'storage-unavailable',
        'File storage is not configured',
        'No object store is configured for attachments.',
        'Set SHUTRO_ERP_STORAGE_DIR, or S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY.',
      );
    storage = configured;
    stores.set(app, storage);
  }
  return storage;
}

export function positive(value: unknown, what: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', `${what} must be a positive integer.`);
  return id;
}

/** Storage failures as problems (the store's message stays in the logs). */
export function storageProblem(error: unknown, request: FastifyRequest): never {
  if (error instanceof StorageError) {
    request.log.error({ err: error }, 'attachment storage');
    if (error.code === 'missing')
      throw new HttpProblem(404, 'missing-file', 'File missing', 'The file is no longer stored.');
    throw new HttpProblem(
      503,
      'storage-unavailable',
      'File storage unavailable',
      'The file store did not answer; try again.',
    );
  }
  throw error;
}

/** Registers the attachment routes. */
export function registerAttachmentRoutes(context: ModuleContext): void {
  const { app } = context;
  const models = new Set([
    ...publicApiModels(context.registry).keys(),
    ...context.registry.loaded.modules.flatMap((m) => m.attachable ?? []),
  ]);
  const limit = maxAttachmentBytes();

  // Uploads: the body is the file, whatever its type. Own parsers in an encapsulated context, so a JSON file stays
  // bytes; the caller is checked before the body is read.
  app.register(async (uploads: FastifyInstance) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: limit }, (_req, body, done) =>
      done(null, body),
    );
    uploads.addHook('onRequest', async (request) => {
      if (request.identity === null)
        throw new HttpProblem(401, 'unauthenticated', 'Sign in required', 'Sign in first.');
    });
    uploads.post('/api/v1/attachments/:model/:id', async (request, reply) => {
      const { model, id } = request.params as { model: string; id: string };
      const recordId = positive(id, 'id');
      const body = request.body;
      if (!(body instanceof Uint8Array) || body.byteLength === 0)
        throw new HttpProblem(400, 'invalid-body', 'Empty file', 'The request body is the file.');
      const header = request.headers['x-filename'];
      let name = 'file';
      try {
        name = cleanName(decodeURIComponent(typeof header === 'string' ? header : 'file'));
      } catch {
        throw new HttpProblem(
          400,
          'invalid-name',
          'Invalid file name',
          'X-Filename is URI-encoded.',
        );
      }
      const storage = storageOf(app);
      const created = await request
        .env(
          (env) =>
            saveAttachment(env, storage, models, {
              model,
              id: recordId,
              name,
              mime: request.headers['content-type'],
              data: body,
            }),
          { write: true },
        )
        .catch((e: unknown) => storageProblem(e, request));
      return reply.code(201).send(created);
    });
  });

  app.get('/api/v1/attachments/:model/:id', async (request) => {
    const { model, id } = request.params as { model: string; id: string };
    const recordId = positive(id, 'id');
    return request.env(async (env) => ({
      attachments: await attachmentsOf(env, models, model, recordId),
    }));
  });

  app.get('/api/v1/attachments/:id/download', async (request, reply) => {
    const id = positive((request.params as { id?: unknown }).id, 'id');
    const inline = (request.query as { inline?: unknown }).inline === 'true';
    const storage = storageOf(app);
    const opened = await request
      .env((env) => openAttachment(env, storage, models, id))
      .catch((e: unknown) => storageProblem(e, request));
    const shown = inline && INLINE_TYPES.has(opened.info.mime);
    return reply
      .header('content-type', shown ? opened.info.mime : 'application/octet-stream')
      .header('content-length', String(opened.info.size))
      .header('content-disposition', disposition(shown ? 'inline' : 'attachment', opened.info.name))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; img-src 'self'; sandbox")
      .header('cache-control', 'private, max-age=0, must-revalidate')
      .send(opened.body);
  });

  app.delete('/api/v1/attachments/:id', async (request, reply) => {
    const id = positive((request.params as { id?: unknown }).id, 'id');
    const keys = await request.env((env) => removeAttachments(env, models, [id]));
    await deleteObjects(app, keys, request);
    return reply.code(204).send();
  });
}

/** Deletes objects after their rows are gone (committed); failures leave orphans, logged, never errors. */
export async function deleteObjects(
  app: object,
  keys: readonly string[],
  request: FastifyRequest,
): Promise<void> {
  if (keys.length === 0) return;
  const storage = storageOf(app);
  for (const key of keys)
    await storage.delete(key).catch((err: unknown) => {
      request.log.warn({ err, key }, 'attachment object left behind');
    });
}
