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
import { accentVariables } from './lib/accent.js';
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
  /** Comfortable or compact (RFC 0018): lists, forms and controls. */
  readonly density: Density;
  setDensity(density: Density): void;
  /** The realtime gateway's client, when the app has one: live lists, records and presence. */
  readonly realtime?: RealtimeClient;
  /** Changes saved offline, when the app keeps them: a form that cannot reach the server saves here. */
  readonly offline?: OfflineQueue;
  /** Switches to another of the user's companies, when the shell offers it (Settings › Companies). */
  readonly switchCompany?: (company: number) => void;
}

const Context = createContext<KoshContextValue | null>(null);

/** The renderer context. @throws outside {@link KoshProvider} */
export function useKosh(): KoshContextValue {
  const value = useContext(Context);
  if (value === null) throw new Error('useKosh() needs a <KoshProvider>.');
  return value;
}

const THEME_KEY = 'kosh.theme';
const DENSITY_KEY = 'kosh.density';

export type Density = 'comfortable' | 'compact';

function readDensity(): Density {
  try {
    return JSON.parse(localStorage.getItem(DENSITY_KEY) ?? 'null') === 'compact'
      ? 'compact'
      : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** Applies the density to `<html>` (`data-density`), remembered per browser. */
function useDensity(): [Density, (d: Density) => void] {
  const [density, setDensity] = useState<Density>(readDensity);
  useEffect(() => {
    document.documentElement.dataset['density'] = density;
    try {
      localStorage.setItem(DENSITY_KEY, JSON.stringify(density));
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  }, [density]);
  return [density, setDensity];
}

/** Sets the company's brand colour as the accent (RFC 0018), or the default when it has none. */
function useAccent(accent: string | null | undefined): void {
  useEffect(() => {
    const root = document.documentElement.style;
    const variables = accentVariables(accent);
    for (const key of ['--accent-h', '--accent-c']) {
      const value = variables[key];
      if (value === undefined) root.removeProperty(key);
      else root.setProperty(key, value);
    }
  }, [accent]);
}

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
  grouping,
  accent,
  realtime,
  offline,
  switchCompany,
  children,
}: {
  readonly api: KoshApi;
  readonly registry: Registry;
  readonly uid: number;
  readonly companyId: number;
  readonly lang: string;
  readonly tz: string;
  /** The company's number grouping (RFC 0016). */
  readonly grouping?: 'international' | 'lakh';
  /** The company's brand colour (`#rrggbb`, RFC 0018). */
  readonly accent?: string | null;
  readonly realtime?: RealtimeClient;
  readonly offline?: OfflineQueue;
  readonly switchCompany?: (company: number) => void;
  readonly children: ReactNode;
}): ReactElement {
  const [theme, setTheme] = useTheme();
  const [density, setDensity] = useDensity();
  useAccent(accent);
  const format = useMemo(
    () => createFormatter(lang, tz, grouping === undefined ? {} : { grouping }),
    [lang, tz, grouping],
  );
  const value = useMemo(
    () => ({
      api,
      registry,
      uid,
      companyId,
      format,
      theme,
      setTheme,
      density,
      setDensity,
      ...(realtime === undefined ? {} : { realtime }),
      ...(offline === undefined ? {} : { offline }),
      ...(switchCompany === undefined ? {} : { switchCompany }),
    }),
    [
      api,
      registry,
      uid,
      companyId,
      format,
      theme,
      setTheme,
      density,
      setDensity,
      realtime,
      offline,
      switchCompany,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Theme switching without a signed-in user (the sign-in page). */
export { useTheme };
