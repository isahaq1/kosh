/**
 * The data layer of Documents (RFC 0024 §2.8): folders of a company — open to everyone with Documents, or kept to their
 * members —, documents in them with tags and versions (each version a stored file, the latest the current one),
 * share links with an expiry and an optional password (only hashes are kept), and requests: a person is asked for a
 * file by email, with a link that uploads it into the right folder, and reminded once when it is late.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  records,
} from './.kosh/bindings.js';
import { announceRequests } from './documents.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;

export const DocumentsFolder = defineModel('documents.folder', {
  label: 'Folder',
  recName: 'fullName',
  order: ['fullName asc'],
  archivable: true,
  companyScoped: { required: true },
  hierarchy: { parent: 'parent', path: 'parentPath' },
  tracking: ['restricted', 'members'],
  access: { 'documents.user': ['read'], 'documents.manager': [...ALL, 'export'] },
  rules: {
    // A restricted folder is its members' (and its owner's); the others are everyone's with Documents.
    see: {
      groups: ['documents.user'],
      perms: ['read'],
      domain: { or: [{ restricted: false }, { owner: me }, { members: { any: { id: me } } }] },
    },
    all: { groups: ['documents.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, translate: true }),
    parent: f.many2one('documents.folder', { ondelete: 'restrict', label: 'Inside' }),
    parentPath: f.char({ readonly: true, index: true }),
    children: f.one2many('documents.folder', 'parent'),
    fullName: f.char({
      store: true,
      label: 'Folder',
      ...compute(
        'documents.folder',
        'fullName',
        ['name', 'parent.name', 'parent.parent.name'],
        (folders) => {
          for (const x of folders)
            x.fullName = [x.parent?.parent?.name, x.parent?.name, x.name]
              .filter((n) => n !== null && n !== undefined)
              .join(' / ');
        },
      ),
    }),
    owner: f.many2one('res.users', { default: (env: Env) => env.userId, label: 'Owner' }),
    /** Kept to its members (and its owner); otherwise everyone with Documents sees it. */
    restricted: f.boolean({ default: false, label: 'Members only' }),
    members: f.many2many('res.users', {
      relation: 'documents_folder_member_rel',
      label: 'Members',
    }),
    documents: f.one2many('documents.document', 'folder'),
    description: f.text(),
  },
});

export const DocumentsTag = defineModel('documents.tag', {
  label: 'Document tag',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'documents.user': ['read', 'create'], 'documents.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    color: f.char({ label: 'Colour' }),
  },
  sqlConstraints: { oneName: { unique: ['name'], message: 'Another tag has this name.' } },
});

export const DocumentsDocument = defineModel('documents.document', {
  label: 'Document',
  recName: 'name',
  order: ['updatedAt desc', 'id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['name', 'folder', 'attachment'],
  access: {
    'documents.user': ['read', 'write', 'create'],
    'documents.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    // Read: in a folder they see, or their own; made and changed only in a folder they see.
    see: {
      groups: ['documents.user'],
      perms: ['read'],
      domain: {
        or: [
          { 'folder.restricted': false },
          { 'folder.owner': me },
          { 'folder.members': { any: { id: me } } },
          { owner: me },
        ],
      },
    },
    edit: {
      groups: ['documents.user'],
      perms: ['write', 'create'],
      domain: {
        or: [
          { 'folder.restricted': false },
          { 'folder.owner': me },
          { 'folder.members': { any: { id: me } } },
        ],
      },
    },
    all: { groups: ['documents.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true }),
    folder: f.many2one('documents.folder', { required: true, ondelete: 'restrict' }),
    tags: f.many2many('documents.tag', { relation: 'documents_document_tag_rel' }),
    owner: f.many2one('res.users', { default: (env: Env) => env.userId, label: 'Owner' }),
    /** The current version: the latest file uploaded (`POST /api/v1/documents/:id/versions`). */
    attachment: f.many2one('storage.attachment', { ondelete: 'set null', label: 'File' }),
    mime: f.char({ label: 'Type' }),
    size: f.integer({ label: 'Size (bytes)' }),
    versions: f.integer({ required: true, default: 0, label: 'Versions' }),
    /** The record it is about (an employee, an order), when there is one. */
    resModel: f.char({ label: 'About (model)' }),
    resId: f.integer({ label: 'About (record)' }),
    description: f.text(),
    /** The request it answered, when it came from one. */
    request: f.many2one('documents.request', { ondelete: 'set null', label: 'Requested by' }),
  },
});

export const DocumentsShare = defineModel('documents.share', {
  label: 'Share link',
  order: ['id desc'],
  companyScoped: { required: true },
  access: { 'documents.user': ['read', 'create', 'write'], 'documents.manager': ALL },
  rules: {
    mine: {
      groups: ['documents.user'],
      perms: ['read', 'create', 'write'],
      domain: { createdBy: me },
    },
    all: { groups: ['documents.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    document: f.many2one('documents.document', { ondelete: 'cascade' }),
    folder: f.many2one('documents.folder', { ondelete: 'cascade' }),
    /** The hash of the link's token (the token is shown once, when the link is made). */
    tokenHash: f.char({ required: true, index: 'unique', label: 'Token (hash)' }),
    passwordHash: f.char({ label: 'Password (hash)' }),
    expiresAt: f.datetime({ required: true, label: 'Expires at' }),
    downloads: f.integer({ required: true, default: 0 }),
    revoked: f.boolean({ default: false }),
  },
  constraints: {
    oneTarget: {
      ...check('documents.share', ['document', 'folder'], async (shares) =>
        (await shares.load({ document: true, folder: true }))
          .filter((s) => (s.document === null) === (s.folder === null))
          .map((s) => s.id),
      ),
      message: 'A link shares a document or a folder.',
    },
  },
});

export const DocumentsRequest = defineModel('documents.request', {
  label: 'Document request',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'dueDate'],
  access: { 'documents.user': ['read', 'write', 'create'], 'documents.manager': ALL },
  fields: {
    /** What is asked for: "Your NID card", "The signed contract". */
    name: f.char({ required: true, label: 'What is asked for' }),
    folder: f.many2one('documents.folder', { required: true, ondelete: 'restrict', label: 'Into' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'From' }),
    email: f.char({ required: true }),
    message: f.text(),
    dueDate: f.date({ label: 'Due' }),
    /** The hash of the upload link's token (sent by email, never kept). */
    tokenHash: f.char({ index: true, label: 'Token (hash)' }),
    sentAt: f.datetime({ label: 'Sent at' }),
    remindedAt: f.datetime({ label: 'Reminded at' }),
    document: f.many2one('documents.document', { ondelete: 'set null', label: 'Received' }),
    state: f.state({
      states: { draft: 'Draft', sent: 'Sent', received: 'Received', cancel: 'Cancelled' },
      initial: 'draft',
      help: 'A sent request emails the person an upload link; it is received once they upload the file.',
      transitions: {
        /** Emails the person a link that uploads the file into the folder. */
        send: {
          from: ['draft'],
          to: 'sent',
          before: records('documents.request', async (requests): Promise<void> => {
            await announceRequests(requests.env as unknown as Env, requests.ids);
          }),
        },
        receive: { from: ['sent'], to: 'received' },
        cancel: { from: ['draft', 'sent'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
});

export const documentsShutro = defineModule({
  name: 'documents',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'documents.user',
      label: 'Documents user',
      implies: ['contacts.user'],
    }),
    orm.defineGroup({
      code: 'documents.manager',
      label: 'Documents manager',
      implies: ['documents.user'],
    }),
  ],
  models: [DocumentsFolder, DocumentsTag, DocumentsDocument, DocumentsShare, DocumentsRequest],
});
