/**
 * @packageDocumentation
 * The web contribution of `@kosh/calendar_sync`: Agenda › My other calendars.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { SyncPage } from './SyncPage.js';

export { SyncPage } from './SyncPage.js';

/** Registers the page (and the messages in `i18n`, when given). */
export function registerCalendarSyncWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('agenda.Sync', SyncPage);
  if (i18n !== undefined) addMessages(i18n, 'calendarSync', messages);
  return registry;
}

export { messages as calendarSyncMessages };
