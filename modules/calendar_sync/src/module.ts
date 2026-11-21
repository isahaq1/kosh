/**
 * The data layer of two-way calendar sync (RFC 0034 §2.4): a person's **connected calendars** (Google, Microsoft
 * 365) with their tokens sealed, what was the same on both sides at the last sync (the **links**), and the
 * consent that is under way. A connected calendar is its person's alone: nobody else, managers included, sees it.
 */
import { calendarShutro } from '@kosh/calendar';
import { orm } from '@kosh/server/orm';
import { defineModel, defineModule, type Env, f } from './.kosh/bindings.js';

/**
 * Fields the server maintains: written by its own code (as the system) and by Administrators only. An empty list
 * would mean *everyone* — Shutro reads no groups as no restriction.
 */
const SYSTEM = ['base.admin'] as const;
const me = { $env: 'uid' } as const;

export const SyncAccount = defineModel('calendar.sync.account', {
  label: 'Connected calendar',
  recName: 'email',
  order: ['id asc'],
  access: { 'calendar_sync.user': ['read', 'unlink'] },
  rules: {
    own: { groups: ['calendar_sync.user'], perms: ['read', 'unlink'], domain: { user: me } },
  },
  fields: {
    user: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.userId,
      ondelete: 'cascade',
      label: 'Person',
      groups: { write: [...SYSTEM] },
    }),
    provider: f.char({
      size: 20,
      required: true,
      label: 'Calendar',
      groups: { write: [...SYSTEM] },
    }),
    email: f.char({
      size: 200,
      label: 'Account',
      groups: { write: [...SYSTEM] },
      help: 'The address of the calendar’s owner, as the provider says it.',
    }),
    /** The tokens, sealed under the server's key: never served, never readable in a record. */
    accessSealed: f.text({ groups: { read: [...SYSTEM], write: [...SYSTEM] } }),
    refreshSealed: f.text({ groups: { read: [...SYSTEM], write: [...SYSTEM] } }),
    expiresAt: f.datetime({ groups: { read: [...SYSTEM], write: [...SYSTEM] } }),
    lastSyncAt: f.datetime({ label: 'Last synced', groups: { write: [...SYSTEM] } }),
    lastResult: f.char({
      size: 200,
      label: 'What the last sync did',
      groups: { write: [...SYSTEM] },
    }),
    lastError: f.char({
      size: 300,
      label: 'Problem',
      groups: { write: [...SYSTEM] },
      help: 'Why the last sync did not finish. It is tried again by itself; connect again if the calendar asks for it.',
    }),
  },
  sqlConstraints: {
    once: {
      unique: ['user', 'provider', 'email'],
      message: 'This calendar is connected already.',
    },
  },
});

/** What was the same on both sides at the last sync. The server's alone. */
export const SyncLink = defineModel('calendar.sync.link', {
  label: 'Synced event',
  order: ['id asc'],
  access: {},
  fields: {
    account: f.many2one('calendar.sync.account', { required: true, ondelete: 'cascade' }),
    /** The event here; empty once it was deleted here (the next sync deletes it there). */
    event: f.many2one('calendar.event', { ondelete: 'set null' }),
    remoteId: f.char({ size: 1100, required: true }),
    etag: f.char({ size: 300, required: true }),
    stamp: f.text({ required: true }),
  },
  sqlConstraints: {
    once: {
      unique: ['account', 'remoteId'],
      message: 'An event of the other calendar is linked once.',
    },
  },
});

/** A consent under way: who asked, for which provider, and the PKCE verifier — until the provider answers. */
export const SyncState = defineModel('calendar.sync.state', {
  label: 'Calendar connection under way',
  order: ['id asc'],
  access: {},
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    provider: f.char({ size: 20, required: true }),
    /** SHA-256 of the `state` the provider gives back. */
    stateHash: f.char({ size: 64, required: true, index: 'unique' }),
    verifierSealed: f.text({ required: true }),
    expiresAt: f.datetime({ required: true }),
  },
});

export const calendarSyncShutro = defineModule({
  name: 'calendar_sync',
  version: '0.1.0',
  depends: [calendarShutro],
  groups: [
    orm.defineGroup({
      code: 'calendar_sync.user',
      label: 'Calendar sync',
      implies: ['calendar.user'],
    }),
  ],
  models: [SyncAccount, SyncLink, SyncState],
});
