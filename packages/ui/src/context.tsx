/**
 * What every renderer needs: the API, the registry, the signed-in user and company (for `$env` in conditions), the
 * formatter for the user's language and time zone, and the theme.
 */
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { KoshApi } from './api.js';
import { createFormatter, type Formatter } from './lib/format.js';
import type { OfflineQueue } from './offline/queue.js';
import type { RealtimeClient } from './realtime.js';
import type { Registry } from './registry.js';

export type ThemeChoice = 'light' | 'dark' | 'system';

export interface KoshContextValue {
  readonly api: KoshApi;
  readonly registry: Registry;
  readonly uid: number;
  readonly companyId: number;
  readonly format: Formatter;
  readonly theme: ThemeChoice;
  setTheme(theme: ThemeChoice): void;
  /** The realtime gateway's client, when the app has one: live lists, records and presence. */
  readonly realtime?: RealtimeClient;
  /** Changes saved offline, when the app keeps them: a form that cannot reach the server saves here. */
  readonly offline?: OfflineQueue;
}

const Context = createContext<KoshContextValue | null>(null);

/** The renderer context. @throws outside {@link KoshProvider} */
export function useKosh(): KoshContextValue {
  const value = useContext(Context);
  if (value === null) throw new Error('useKosh() needs a <KoshProvider>.');
  return value;
}

const THEME_KEY = 'kosh.theme';

function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Applies the theme to `<html>` (the `dark` class) and follows the system when asked to. */
function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage unavailable (private mode): the choice lasts for this page only
    }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

export function KoshProvider({
  api,
  registry,
  uid,
  companyId,
  lang,
  tz,
  realtime,
  offline,
  children,
}: {
  readonly api: KoshApi;
  readonly registry: Registry;
  readonly uid: number;
  readonly companyId: number;
  readonly lang: string;
  readonly tz: string;
  readonly realtime?: RealtimeClient;
  readonly offline?: OfflineQueue;
  readonly children: ReactNode;
}): ReactElement {
  const [theme, setTheme] = useTheme();
  const format = useMemo(() => createFormatter(lang, tz), [lang, tz]);
  const value = useMemo(
    () => ({
      api,
      registry,
      uid,
      companyId,
      format,
      theme,
      setTheme,
      ...(realtime === undefined ? {} : { realtime }),
      ...(offline === undefined ? {} : { offline }),
    }),
    [api, registry, uid, companyId, format, theme, setTheme, realtime, offline],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Theme switching without a signed-in user (the sign-in page). */
export { useTheme };
