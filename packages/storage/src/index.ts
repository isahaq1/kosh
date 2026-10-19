/**
 * @packageDocumentation
 * `@isahaq/kosh-storage` (RFC 0006 §5.1): attachments on records. Bytes in S3-compatible object storage (S3, SeaweedFS,
 * MinIO; SigV4 on `node:crypto`) or a directory; metadata in `storage.attachment`, a private model reached only
 * through routes that check the attached record as the caller.
 */
import { defineModule } from '@isahaq/kosh-modules-sdk';
import { base, type ModuleContext } from '@isahaq/kosh-server';
import { storageShutro } from './models.js';
import { registerAttachmentRoutes } from './routes.js';

export {
  type AttachmentInfo,
  attachmentsById,
  attachmentsOf,
  checkRecord,
  cleanMime,
  cleanName,
  disposition,
  INLINE_TYPES,
  openAttachment,
  removeAttachments,
  saveAttachment,
} from './attachments.js';
export {
  FileStorage,
  type S3Options,
  S3Storage,
  type Storage,
  StorageError,
  storageFromEnv,
} from './backends.js';
export {
  deleteObjects,
  maxAttachmentBytes,
  positive,
  registerAttachmentRoutes,
  storageOf,
  storageProblem,
  useStorage,
} from './routes.js';
export { type Credentials, EMPTY_SHA256, signRequest } from './sigv4.js';
export { storageShutro };

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@isahaq/kosh-storage',
  rfc: 'RFC 0006',
});

/** The Kosh module: attachments on any record of a served model. */
export const storage: ReturnType<typeof defineModule> = defineModule({
  shutro: storageShutro,
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'Attachments', groups: ['storage.user'] } },
  privateModels: ['storage.attachment'],
  routes: (context: ModuleContext) => registerAttachmentRoutes(context),
});
