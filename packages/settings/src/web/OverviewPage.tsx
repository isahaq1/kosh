/**
 * Settings' home (RFC 0019 §3.1): every section the user may open, in its group (Workspace, People, Security, Apps —
 * the server's menus decide which), each with what it is for; and a search over their names, descriptions and
 * keywords ("lakh" finds Company, "two-factor" your profile). Sections of other modules join their group with their
 * menu; their description and keywords come from `settings:overview.<action>` messages when the module adds them.
 */
import { AppIcon, type MenuNode, type PageProps } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search, UserRound } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Entry {
  readonly label: string;
  readonly action: string;
  readonly description: string;
  readonly keywords: string;
}

const normalise = (s: string) => s.toLocaleLowerCase().normalize('NFKD');

/** Each section's icon (AppIcon names); a module's own section shows the Settings gear. */
const SECTION_ICONS: Readonly<Record<string, string>> = {
  'settings.action_company': 'company',
  'settings.action_companies': 'companies',
  'settings.action_people': 'users',
  'settings.action_roles': 'shield',
  'settings.action_security': 'security',
  'settings.action_audit': 'audit',
  'settings.action_apps': 'apps',
  'assistant.action_settings': 'assistant',
};

export function OverviewPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const [query, setQuery] = useState('');
  const menus = useQuery({ queryKey: ['menus', 'settings'], queryFn: () => api.menus('settings') });
  const about = (action: string) => ({
    description: t(`overview.about.${action}.description`, { defaultValue: '' }),
    keywords: t(`overview.about.${action}.keywords`, { defaultValue: '' }),
  });
  const entry = (n: MenuNode): Entry | null =>
    n.action === undefined || n.action === 'settings.action_overview'
      ? null
      : { label: n.label, action: n.action, ...about(n.action) };
  // The groups (a menu with children), and loose sections under "Other".
  const roots = (menus.data ?? []).flatMap((root) => root.children);
  const groups: { id: string; label: string; entries: Entry[] }[] = [];
  const loose: Entry[] = [];
  for (const node of roots) {
    if (node.children.length > 0)
      groups.push({
        id: node.id,
        label: node.label,
        entries: node.children.map(entry).filter((e): e is Entry => e !== null),
      });
    else {
      const e = entry(node);
      if (e !== null) loose.push(e);
    }
  }
  if (loose.length > 0) groups.push({ id: 'other', label: t('overview.other'), entries: loose });
  // Your profile is everyone's, outside the app's menus.
  const profile: Entry = {
    label: t('profile.title'),
    action: '',
    description: t('overview.profile'),
    keywords: t('overview.profileKeywords'),
  };
  const q = normalise(query.trim());
  const matches = (e: Entry) =>
    q === '' ||
    q
      .split(/\s+/)
      .every((word) => normalise(`${e.label} ${e.description} ${e.keywords}`).includes(word));
  const shown = groups
    .map((g) => ({ ...g, entries: g.entries.filter(matches) }))
    .filter((g) => g.entries.length > 0);
  const card = (e: Entry, to: ReactElement) => <li key={e.action || 'profile'}>{to}</li>;
  const showProfile = matches(profile);
  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <header className="grid gap-3">
        <h1 className="text-2xl font-semibold">{t('overview.title')}</h1>
        <div className="relative">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <label htmlFor={`${id}-q`} className="sr-only">
            {t('overview.search')}
          </label>
          <input
            id={`${id}-q`}
            type="search"
            // biome-ignore lint/a11y/noAutofocus: the page is a search first; it opens on purpose
            autoFocus
            value={query}
            placeholder={t('overview.search')}
            onChange={(e) => setQuery(e.target.value)}
            className="h-11 w-full rounded-lg border border-input bg-surface ps-10 pe-3 text-base shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </header>
      {shown.length === 0 && !showProfile ? (
        <p className="text-sm text-muted-foreground">{t('overview.nothing', { query })}</p>
      ) : null}
      {shown.map((g) => (
        <section key={g.id} aria-labelledby={`${id}-${g.id}`} className="grid gap-2">
          <h2
            id={`${id}-${g.id}`}
            className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            {g.label}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {g.entries.map((e) =>
              card(
                e,
                <Link
                  to="/$app/a/$action"
                  params={{ app: 'settings', action: e.action }}
                  className="flex h-full items-start gap-3 rounded-lg border bg-surface p-4 hover:border-primary/40 hover:bg-accent/40"
                >
                  <AppIcon name={SECTION_ICONS[e.action] ?? 'settings'} className="size-9" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{e.label}</span>
                    {e.description === '' ? null : (
                      <span className="text-sm text-muted-foreground">{e.description}</span>
                    )}
                  </span>
                </Link>,
              ),
            )}
          </ul>
        </section>
      ))}
      {showProfile ? (
        <section aria-labelledby={`${id}-you`} className="grid gap-2">
          <h2
            id={`${id}-you`}
            className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            {t('overview.you')}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {card(
              profile,
              <Link
                to="/me/$page"
                params={{ page: 'settings.Profile' }}
                className="flex h-full items-start gap-3 rounded-lg border bg-surface p-4 hover:border-primary/40 hover:bg-accent/40"
              >
                <span
                  aria-hidden
                  className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"
                >
                  <UserRound className="size-4" />
                </span>
                <span className="grid gap-0.5">
                  <span className="font-medium">{profile.label}</span>
                  <span className="text-sm text-muted-foreground">{profile.description}</span>
                </span>
              </Link>,
            )}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
