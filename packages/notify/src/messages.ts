/**
 * What a notification says, per kind and language (the client's bell and the server's emails share it). Texts
 * take `{{params}}`; `interpolate` fills them. English is the fallback for a language without a text.
 */
import type { Kind } from './models.js';

interface Texts {
  readonly kinds: Readonly<Record<Kind, string>>;
  readonly states: Readonly<Record<string, string>>;
  readonly email: {
    readonly open: string;
    readonly why: string;
    /** The daily digest (RFC 0006 §8.3). */
    readonly digestSubject: string;
    readonly digestIntro: string;
  };
}

export const TEXTS: Readonly<Record<string, Texts>> = {
  en: {
    kinds: {
      mention: '{{actor}} mentioned you on {{record}}',
      'approval.requested': '{{actor}} asks for your approval on {{record}}',
      'approval.decided': '{{actor}} {{state}} {{record}}',
      'activity.assigned': '{{actor}} assigned you an activity on {{record}} (due {{deadline}})',
      'chat.direct': '{{actor}}: {{preview}}',
      'email.bounced': 'The email to {{recipient}} ({{address}}) about {{record}} bounced',
      automation: '{{text}}',
    },
    states: { approved: 'approved', rejected: 'rejected' },
    email: {
      open: 'Open in Kosh',
      why: 'You receive this email because of your notification settings in Kosh.',
      digestSubject: 'Your Kosh summary: {{count}} notifications',
      digestIntro: 'What happened since your last summary, by record.',
    },
  },
  bn: {
    kinds: {
      mention: '{{actor}} আপনাকে {{record}}-এ উল্লেখ করেছেন',
      'approval.requested': '{{actor}} {{record}}-এর জন্য আপনার অনুমোদন চেয়েছেন',
      'approval.decided': '{{actor}} {{record}} {{state}}',
      'activity.assigned': '{{actor}} আপনাকে {{record}}-এ একটি কাজ দিয়েছেন (শেষ তারিখ {{deadline}})',
      'chat.direct': '{{actor}}: {{preview}}',
      'email.bounced': '{{record}} সম্পর্কে {{recipient}} ({{address}})-কে পাঠানো ইমেইল ফেরত এসেছে',
      automation: '{{text}}',
    },
    states: { approved: 'অনুমোদন করেছেন', rejected: 'প্রত্যাখ্যান করেছেন' },
    email: {
      open: 'কোষে খুলুন',
      why: 'কোষে আপনার বিজ্ঞপ্তি সেটিংসের কারণে আপনি এই ইমেইল পেয়েছেন।',
      digestSubject: 'আপনার কোষ সারাংশ: {{count}}টি বিজ্ঞপ্তি',
      digestIntro: 'আপনার শেষ সারাংশের পর থেকে যা ঘটেছে, রেকর্ড অনুযায়ী।',
    },
  },
};

/** `bn_BD` → `bn`; unknown languages fall back to English. */
export function textsFor(lang: string | null | undefined): Texts {
  const code = (lang ?? 'en').split(/[_-]/)[0] ?? 'en';
  return TEXTS[code] ?? (TEXTS['en'] as Texts);
}

/** Fills `{{name}}` placeholders; missing ones become empty. */
export function interpolate(template: string, params: Readonly<Record<string, unknown>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = params[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** The sentence of a notification in `lang` (states translated). */
export function sentence(
  lang: string | null | undefined,
  kind: string,
  params: Readonly<Record<string, unknown>>,
): string {
  const texts = textsFor(lang);
  const template = texts.kinds[kind as Kind] ?? kind;
  const state = params['state'];
  const filled = {
    ...params,
    ...(typeof state === 'string' ? { state: texts.states[state] ?? state } : {}),
  };
  return interpolate(template, filled);
}
