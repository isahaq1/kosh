/**
 * i18next setup (RFC 0007): one instance per app, the `kosh` namespace for the UI, module namespaces added with
 * {@link addMessages}. Languages use Kosh codes (`bn_BD`); i18next sees BCP 47 (`bn-BD`) and falls back to `bn`,
 * then English. The document's `lang` and `dir` follow the language (Arabic is right-to-left).
 */
import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bcp47 } from '../lib/format.js';
import { ar, bn, en } from './messages.js';

export const NAMESPACE = 'kosh';

/** Creates and initializes an i18next instance for `lang`. */
export async function createI18n(lang: string): Promise<i18n> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: bcp47(lang),
    fallbackLng: { 'bn-BD': ['bn', 'en'], default: ['en'] },
    ns: [NAMESPACE],
    defaultNS: NAMESPACE,
    resources: { en: { [NAMESPACE]: en }, bn: { [NAMESPACE]: bn }, ar: { [NAMESPACE]: ar } },
    interpolation: { escapeValue: false }, // React escapes
    returnNull: false,
  });
  applyDocumentLanguage(instance);
  instance.on('languageChanged', () => applyDocumentLanguage(instance));
  return instance;
}

/** Adds a module's messages (`addMessages(i18n, 'purchase', { en: {...}, bn: {...} })`). */
export function addMessages(
  instance: i18n,
  namespace: string,
  messages: Readonly<Record<string, object>>,
): void {
  for (const [lang, bundle] of Object.entries(messages))
    instance.addResourceBundle(lang, namespace, bundle, true, true);
}

/** Text direction of a language. */
export function directionOf(lang: string): 'ltr' | 'rtl' {
  return /^(ar|fa|he|ur|ps|dv|ckb)([-_]|$)/.test(lang) ? 'rtl' : 'ltr';
}

function applyDocumentLanguage(instance: i18n): void {
  if (typeof document === 'undefined') return;
  const lang = instance.language;
  document.documentElement.lang = lang;
  document.documentElement.dir = directionOf(lang);
}
