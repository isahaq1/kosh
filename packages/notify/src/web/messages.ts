/** Messages of the notifications bell (namespace `notify`). */
export const messages: Readonly<Record<string, object>> = {
  en: {
    title: 'Notifications',
    unread_one: '{{count}} unread notification',
    unread_other: '{{count}} unread notifications',
    markAllRead: 'Mark all as read',
    empty: 'You are all caught up.',
    kinds: {
      mention: '{{actor}} mentioned you on {{record}}',
      'approval.requested': '{{actor}} asks for your approval on {{record}}',
      'approval.decided': '{{actor}} {{state}} {{record}}',
      'activity.assigned': '{{actor}} assigned you an activity on {{record}} (due {{deadline}})',
    },
    states: { approved: 'approved', rejected: 'rejected' },
  },
  bn: {
    title: 'বিজ্ঞপ্তি',
    unread_one: '{{count}}টি অপঠিত বিজ্ঞপ্তি',
    unread_other: '{{count}}টি অপঠিত বিজ্ঞপ্তি',
    markAllRead: 'সব পঠিত হিসেবে চিহ্নিত করুন',
    empty: 'নতুন কিছু নেই।',
    kinds: {
      mention: '{{actor}} আপনাকে {{record}}-এ উল্লেখ করেছেন',
      'approval.requested': '{{actor}} {{record}}-এর জন্য আপনার অনুমোদন চেয়েছেন',
      'approval.decided': '{{actor}} {{record}} {{state}}',
      'activity.assigned': '{{actor}} আপনাকে {{record}}-এ একটি কাজ দিয়েছেন (শেষ তারিখ {{deadline}})',
    },
    states: { approved: 'অনুমোদন করেছেন', rejected: 'প্রত্যাখ্যান করেছেন' },
  },
};
