/**
 * The framework's `base` module (CLAUDE.md, Phase 1: users and companies): currencies, companies, users, and the
 * private authentication models (credentials, sessions, per-company group assignments). Every Kosh application
 * depends on it. Administrators (`base.admin`) need no grants (RFC 0003 §5.2).
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { orm } from '../orm.js';

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
  },
});

const ResUsers = defineModel('res.users', {
  archivable: true, // `active`: deactivated users cannot sign in
  access: { 'base.user': ['read'] },
  fields: {
    login: f.char({ required: true, index: 'unique' }),
    name: f.char({ required: true }),
    email: f.char(),
    company: f.many2one('res.company'),
    companies: f.many2many('res.company'),
    lang: f.char({ default: 'en_US' }),
    tz: f.char({ default: 'UTC' }),
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
    expiresAt: f.datetime({ required: true }),
    lastSeenAt: f.datetime({ required: true }),
    revoked: f.boolean({ default: false }),
    ip: f.char(),
    userAgent: f.char(),
  },
});

/** A group a user holds in one company (or every company when `company` is empty). Private. */
const AuthUserGroup = defineModel('auth.user_group', {
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    company: f.many2one('res.company', { ondelete: 'cascade' }),
    group: f.char({ required: true }),
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
  models: [ResCurrency, ResCompany, ResUsers, AuthCredential, AuthSession, AuthUserGroup],
});

/** The framework's base module: depend on it from every application module. */
export const base: ReturnType<typeof defineKoshModule> = defineKoshModule({
  shutro: baseShutro,
  kosh: '^0.1.0',
  accessLevels: {
    user: { label: 'Internal user', groups: ['base.user'] },
    admin: { label: 'Administrator', groups: ['base.admin'], implies: ['user'] },
  },
  privateModels: ['auth.credential', 'auth.session', 'auth.user_group'],
});
