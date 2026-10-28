/**
 * The framework's `base` module (CLAUDE.md, Phase 1: users and companies): currencies, companies, users, and the
 * private authentication models (credentials, sessions, per-company group assignments). Every Kosh application
 * depends on it. Administrators (`base.admin`) need no grants (RFC 0003 §5.2).
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import type { Env } from '../orm.js';
import { orm } from '../orm.js';
import { LAST_ADMINISTRATOR, lastAdministratorRemoved } from './admins.js';

const { defineGroup, defineModel, defineModule, f } = orm;

const ResCurrency = defineModel('res.currency', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true, size: 3, index: 'unique' }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
    decimalPlaces: f.integer({ default: 2 }),
  },
});

const ResCompany = defineModel('res.company', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
    /** How numbers are grouped on screen and in documents (RFC 0016): 1,234,567 or 12,34,567 (lakh and crore). */
    numberGrouping: f.selection(
      { international: 'International (1,234,567)', lakh: 'Lakh and crore (12,34,567)' },
      { required: true, default: 'international', label: 'Number grouping' },
    ),
  },
});

type Row = Record<string, unknown>;
const readRows = async (
  env: Env,
  model: string,
  ids: readonly number[],
  keys: string[],
): Promise<Row[]> =>
  env.asSuperuser({ reason: 'check administrators' }, async (su) => {
    const set = (
      su.model(model as never) as unknown as {
        browse(ids: readonly number[]): {
          load(k: string[]): Promise<{ read(k: string[]): Row[] }>;
        };
      }
    ).browse(ids);
    return (await set.load(keys)).read(keys);
  });

const ResUsers = defineModel('res.users', {
  archivable: true, // `active`: deactivated users cannot sign in
  access: { 'base.user': ['read'] },
  constraints: {
    // Archiving the last administrator is refused (users are archived, not deleted: see auth.user_group.user).
    keepAdministrator: {
      depends: ['active'],
      check: (records: never) =>
        lastAdministratorRemoved(
          records as { env: Env; ids: readonly number[] },
          async (env, ids) =>
            (await readRows(env, 'res.users', ids, ['active'])).map((r) => ({
              id: r['id'] as number,
              user: r['id'] as number,
              removed: r['active'] === false,
            })),
        ),
      message: LAST_ADMINISTRATOR,
    },
  },
  fields: {
    login: f.char({ required: true, index: 'unique' }),
    name: f.char({ required: true }),
    email: f.char(),
    /** E.164 (`+8801711000001`): the SMS and WhatsApp channels of the notifications. */
    phone: f.char(),
    company: f.many2one('res.company'),
    companies: f.many2many('res.company'),
    lang: f.char({ default: 'en_US' }),
    tz: f.char({ default: 'UTC' }),
    /** A service account (RFC 0017 §5.1): no password, no sign-in; acts only through API keys, with its roles. */
    isService: f.boolean({ default: false, label: 'Service account' }),
  },
});

/** Password hash and TOTP state of a user. Private: never served by the generated API. */
const AuthCredential = defineModel('auth.credential', {
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade', index: 'unique' }),
    passwordHash: f.char(),
    totpSecret: f.char(), // pending or active secret
    totpEnabled: f.boolean({ default: false }),
    recoveryCodes: f.json(), // SHA-256 digests of unused codes
  },
});

/** A signed-in session; the token is stored only as a SHA-256 digest. Private. */
const AuthSession = defineModel('auth.session', {
  fields: {
    tokenHash: f.char({ required: true, index: 'unique' }),
    csrfHash: f.char({ required: true }),
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    twoFactorVerified: f.boolean({ default: false }),
    /** A second factor was entered in this session (sign-in or enrolment): administrator groups need it. */
    secondFactor: f.boolean({ default: false }),
    expiresAt: f.datetime({ required: true }),
    lastSeenAt: f.datetime({ required: true }),
    revoked: f.boolean({ default: false }),
    ip: f.char(),
    userAgent: f.char(),
  },
});

/**
 * An API key (RFC 0017 §5.1): acts as its user (a person or a service account) within its scopes, until it expires
 * or is revoked. The secret is shown once and stored only as a SHA-256 digest; the prefix identifies it. Private.
 */
const AuthApiKey = defineModel('auth.api_key', {
  fields: {
    name: f.char({ required: true }),
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    tokenHash: f.char({ required: true, index: 'unique' }),
    /** The secret's start (`sk_ab12cd34`), to tell keys apart. */
    prefix: f.char({ required: true }),
    /** Space-separated: `*`, `read:<app>`, `write:<app>`. */
    scopes: f.text({ required: true }),
    expiresAt: f.datetime({ required: true }),
    lastUsedAt: f.datetime(),
    lastUsedIp: f.char(),
    revoked: f.boolean({ default: false }),
    issuedBy: f.many2one('res.users', { ondelete: 'set null' }),
  },
});

/**
 * A group or role a user holds in one company (or every company when `company` is empty). Private. Users holding
 * any cannot be deleted (`restrict`): they are archived, which the "keep one administrator" guard checks.
 */
const AuthUserGroup = defineModel('auth.user_group', {
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'restrict' }),
    company: f.many2one('res.company', { ondelete: 'cascade' }),
    group: f.char({ required: true }),
  },
});

/**
 * A special permission of one user (Shutro `grants`: a feature permission such as `account.backdate`, or
 * `model:perm`), in one company or all, optionally until a date. Private: managed by the admin API.
 */
const AuthUserGrant = defineModel('auth.user_grant', {
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    company: f.many2one('res.company', { ondelete: 'cascade' }),
    grant: f.char({ required: true }),
    expiresAt: f.datetime(),
    reason: f.char({ required: true }),
  },
});

/**
 * The security audit log (CLAUDE.md: logins, permission changes, exports, sensitive actions). Append-only: no one
 * may change or delete events (administrators included: the REST API never serves it, and the admin API only reads).
 */
const AuditEvent = defineModel('audit.event', {
  access: { 'base.user': ['create'] },
  order: ['id desc'],
  fields: {
    kind: f.char({ required: true, index: true }),
    actor: f.many2one('res.users', { ondelete: 'set null' }),
    company: f.many2one('res.company', { ondelete: 'set null' }),
    targetModel: f.char(),
    targetId: f.integer(),
    summary: f.char({ required: true }),
    details: f.json(),
    ip: f.char(),
  },
});

/**
 * Saved searches and favorites (RFC 0004 §5): a search state for a model and view type, private to its owner or
 * shared with every user who can read the model. Governed by record rules, served by the generated API.
 */
const SavedView = defineModel('kosh.saved_view', {
  access: { 'base.user': ['read', 'write', 'create', 'unlink'] },
  rules: {
    visible: {
      groups: ['base.user'],
      perms: ['read'],
      domain: { or: [{ createdBy: { $env: 'uid' } }, { shared: true }] },
    },
    own: {
      groups: ['base.user'],
      perms: ['write', 'unlink'],
      domain: { createdBy: { $env: 'uid' } },
    },
  },
  order: ['name asc'],
  fields: {
    name: f.char({ required: true }),
    targetModel: f.char({ required: true, index: true }),
    viewType: f.char({ required: true, default: 'list' }),
    /** The `@kosh/search` state (facets, filters, group-by, order). */
    state: f.json({ required: true }),
    shared: f.boolean({ default: false }),
    isDefault: f.boolean({ default: false }),
  },
});

/** The Shutro module behind {@link base}. */
export const baseShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'base',
  version: '0.1.0',
  groups: [
    defineGroup({ code: 'base.user', label: 'Internal user' }),
    defineGroup({
      code: 'base.admin',
      label: 'Administrator',
      implies: ['base.user'],
      administrator: true,
    }),
  ],
  models: [
    ResCurrency,
    ResCompany,
    ResUsers,
    AuthCredential,
    AuthSession,
    AuthApiKey,
    AuthUserGroup,
    AuthUserGrant,
    AuditEvent,
    SavedView,
  ],
});

/** The framework's base module: depend on it from every application module. */
export const base: ReturnType<typeof defineKoshModule> = defineKoshModule({
  shutro: baseShutro,
  kosh: '^0.1.0',
  accessLevels: {
    user: { label: 'Internal user', groups: ['base.user'] },
    admin: { label: 'Administrator', groups: ['base.admin'], implies: ['user'] },
  },
  privateModels: [
    'auth.credential',
    'auth.session',
    'auth.api_key',
    'auth.user_group',
    'auth.user_grant',
    'audit.event',
  ],
});
