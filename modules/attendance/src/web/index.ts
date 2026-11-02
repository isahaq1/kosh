/**
 * @packageDocumentation
 * The web contribution of `@kosh/attendance`: the phone check-in page, the kiosk and the PIN on employee forms.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { Check } from './Check.js';
import { Kiosk } from './Kiosk.js';
import { messages } from './messages.js';
import { PinButton } from './PinButton.js';

export { Check } from './Check.js';
export { Kiosk } from './Kiosk.js';
export { PinButton } from './PinButton.js';

/** Registers the pages (and the messages in `i18n`, when given). */
export function registerAttendanceWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('attendance.Check', Check);
  registry.registerPage('attendance.Kiosk', Kiosk);
  registry.registerComponent('attendance.Pin', PinButton);
  if (i18n !== undefined) addMessages(i18n, 'attendance', messages);
  return registry;
}

export { messages as attendanceMessages };
