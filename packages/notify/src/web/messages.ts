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
    push: {
      off: 'Push notifications on this device are off',
      on: 'Push notifications on this device are on',
      denied: 'This browser blocks notifications from Kosh',
      busy: 'One moment…',
      turnOn: 'Turn on',
      turnOff: 'Turn off',
    },
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
    push: {
      off: 'এই ডিভাইসে পুশ বিজ্ঞপ্তি বন্ধ',
      on: 'এই ডিভাইসে পুশ বিজ্ঞপ্তি চালু',
      denied: 'এই ব্রাউজার কোষের বিজ্ঞপ্তি আটকে রেখেছে',
      busy: 'এক মুহূর্ত…',
      turnOn: 'চালু করুন',
      turnOff: 'বন্ধ করুন',
    },
    kinds: TEXTS['bn']?.kinds,
    states: TEXTS['bn']?.states,
  },
};
