/**
 * Attachments (RFC 0006 §5.1): metadata in PostgreSQL, bytes in the object store. The model is private: it is
 * reached only through the attachment routes, which check the attached record as the caller first, so an
 * attachment is exactly as visible as its record.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const { defineGroup, defineModel, defineModule, f } = orm;

const Attachment = defineModel('storage.attachment', {
  access: { 'storage.user': ['read', 'create', 'unlink'] },
  rules: {
    // Only the uploader removes an attachment (administrators bypass).
    own: { groups: ['storage.user'], perms: ['unlink'], domain: { createdBy: { $env: 'uid' } } },
  },
  indexes: [{ fields: ['resModel', 'resId'] }],
  order: ['id desc'],
  fields: {
    name: f.char({ required: true }),
    mime: f.char({ required: true }),
    size: f.integer({ required: true }),
    sha256: f.char({ required: true }),
    /** The object key in the store (`att/2026/10/<uuid>`). */
    key: f.char({ required: true, index: 'unique' }),
    resModel: f.char({ required: true, label: 'Model' }),
    resId: f.integer({ required: true, label: 'Record' }),
    /** A smaller rendering of another attachment (RFC 0022 §3.3: an image's thumbnail), `width` pixels wide. */
    variantOf: f.many2one('storage.attachment', { ondelete: 'cascade', label: 'Variant of' }),
    width: f.integer({ label: 'Width (px)' }),
  },
});

export const storageShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'storage',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [defineGroup({ code: 'storage.user', label: 'Attachments', implies: ['base.user'] })],
  models: [Attachment],
});
