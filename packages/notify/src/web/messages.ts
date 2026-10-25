/** Messages of the notifications bell (namespace `notify`): the shared sentences plus the panel's own words. */
import { TEXTS } from '../messages.js';

export const messages: Readonly<Record<string, object>> = {
  en: {
    title: 'Notifications',
    unread_one: '{{count}} unread notification',
    unread_other: '{{count}} unread notifications',
    markAllRead: 'Mark all as read',
    empty: 'You are all caught up.',
    cannotOpen: 'You cannot open this record.',
    kinds: TEXTS['en']?.kinds,
    states: TEXTS['en']?.states,
  },
  bn: {
    title: 'বিজ্ঞপ্তি',
    unread_one: '{{count}}টি অপঠিত বিজ্ঞপ্তি',
    unread_other: '{{count}}টি অপঠিত বিজ্ঞপ্তি',
    markAllRead: 'সব পঠিত হিসেবে চিহ্নিত করুন',
    empty: 'নতুন কিছু নেই।',
    cannotOpen: 'আপনি এই রেকর্ডটি খুলতে পারবেন না।',
    kinds: TEXTS['bn']?.kinds,
    states: TEXTS['bn']?.states,
  },
};
