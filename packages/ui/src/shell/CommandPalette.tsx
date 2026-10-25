/**
 * The command palette (RFC 0010 §3.1): Ctrl+K / ⌘K anywhere. One box to reach everything the user may use:
 * recently opened records, every menu of every app (with its path), records found by name across the apps
 * (`/api/v1/find`, checked by the server), and commands (new record here, theme, shortcuts, home). Keyboard first:
 * ↑ ↓ to move, Enter to open, Esc to close; screen readers get a combobox with an active option.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  FileText,
  History,
  Home,
  Keyboard,
  Monitor,
  Moon,
  Plus,
  Search,
  Sun,
} from 'lucide-react';
import { Dialog as RDialog } from 'radix-ui';
import {
  type Context,
  createContext,
  type ReactElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { AppEntry, KoshApi, MenuNode } from '../api.js';
import { AppIcon } from '../components/AppIcon.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';
import { recentRecords } from './recent.js';

/** Opens the palette from anywhere in the shell (the home page's search box). */
export const PaletteContext: Context<() => void> = createContext<() => void>(() => {});
export function usePalette(): () => void {
  return useContext(PaletteContext);
}

interface Item {
  readonly id: string;
  readonly group: 'recent' | 'goto' | 'records' | 'commands';
  readonly label: string;
  readonly hint?: string;
  readonly icon: ReactElement;
  readonly run: () => void;
}

/** Menu entries with an action, with their path (`Sales › Orders › Quotations`). */
function leaves(
  menus: readonly MenuNode[],
  apps: readonly AppEntry[],
): { app: string; action: string; path: string; label: string }[] {
  const out: { app: string; action: string; path: string; label: string }[] = [];
  const walk = (nodes: readonly MenuNode[], trail: readonly string[], app: string | undefined) => {
    for (const n of nodes) {
      const here = n.app ?? app;
      if (n.action !== undefined && here !== undefined)
        out.push({
          app: here,
          action: n.action,
          path: [...trail, n.label].join(' › '),
          label: n.label,
        });
      walk(n.children, [...trail, n.label], here);
    }
  };
  for (const root of menus) {
    const appLabel = apps.find((a) => a.code === root.app)?.label;
    walk([root], appLabel === undefined || appLabel === root.label ? [] : [appLabel], root.app);
  }
  return out;
}

/** Higher is better; 0 hides the item. */
function score(text: string, query: string): number {
  if (query === '') return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (t.startsWith(q)) return 3;
  // Every typed word starts a word of the text, in any order: "purchase ord" finds "Purchase › Orders".
  const words = t.split(/[\s›/.,()-]+/).filter((w) => w !== '');
  const typed = q.split(/\s+/).filter((w) => w !== '');
  if (typed.every((w) => words.some((x) => x.startsWith(w)))) return 2;
  return t.includes(q) ? 1 : 0;
}

export function CommandPalette({
  open,
  onOpenChange,
  api,
  onShortcuts,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly api: KoshApi;
  readonly onShortcuts: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { uid, setTheme } = useKosh();
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(timer);
  }, [query]);

  const apps = useQuery({
    queryKey: ['palette', 'apps'],
    queryFn: () => api.apps(),
    enabled: open,
  });
  const menus = useQuery({
    queryKey: ['palette', 'menus'],
    queryFn: () => api.menus(),
    enabled: open,
  });
  const found = useQuery({
    queryKey: ['palette', 'find', debounced],
    queryFn: () => api.find(debounced, 5),
    enabled: open && debounced.length >= 2,
    staleTime: 10_000,
  });

  const close = () => onOpenChange(false);
  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const appList = apps.data ?? [];
    const out: { item: Item; rank: number }[] = [];
    for (const r of recentRecords(uid)) {
      const rank = score(r.title, q);
      if (rank > 0 && (q !== '' || out.length < 5))
        out.push({
          rank: rank + 0.5,
          item: {
            id: `recent:${r.model}:${r.id}`,
            group: 'recent',
            label: r.title,
            hint: appList.find((a) => a.code === r.app)?.label ?? r.app,
            icon: <History className="size-4" aria-hidden />,
            run: () =>
              void navigate({
                to: '/$app/a/$action/$id',
                params: { app: r.app, action: r.action, id: String(r.id) },
              }),
          },
        });
    }
    for (const leaf of leaves(menus.data ?? [], appList)) {
      const rank = Math.max(score(leaf.label, q), score(leaf.path, q) - 0.5);
      if (rank > 0 && q !== '')
        out.push({
          rank,
          item: {
            id: `goto:${leaf.action}`,
            group: 'goto',
            label: leaf.path,
            icon: (
              <AppIcon
                name={appList.find((a) => a.code === leaf.app)?.icon ?? leaf.app}
                className="size-6 rounded-md [&_svg]:size-3.5"
              />
            ),
            run: () =>
              void navigate({
                to: '/$app/a/$action',
                params: { app: leaf.app, action: leaf.action },
              }),
          },
        });
    }
    if (q === '')
      for (const a of appList)
        out.push({
          rank: 1,
          item: {
            id: `app:${a.code}`,
            group: 'goto',
            label: a.label,
            icon: (
              <AppIcon name={a.icon ?? a.code} className="size-6 rounded-md [&_svg]:size-3.5" />
            ),
            run: () => void navigate({ to: '/$app', params: { app: a.code } }),
          },
        });
    for (const r of debounced === q ? (found.data ?? []) : [])
      if (r.app !== undefined) {
        const app = r.app;
        out.push({
          rank: 2,
          item: {
            id: `record:${r.model}:${r.id}`,
            group: 'records',
            label: r.displayName,
            hint: r.modelLabel,
            icon: <FileText className="size-4" aria-hidden />,
            run: () =>
              void navigate({
                to: '/$app/a/$action/$id',
                params: { app, action: r.action, id: String(r.id) },
              }),
          },
        });
      }
    const newButton =
      typeof document === 'undefined' ? null : document.querySelector('[data-kosh-new]');
    const commands: Omit<Item, 'group'>[] = [
      ...(newButton === null
        ? []
        : [
            {
              id: 'cmd:new',
              label: t('palette.newHere'),
              hint: 'N',
              icon: <Plus className="size-4" aria-hidden />,
              run: () => (newButton as HTMLElement).click(),
            },
          ]),
      {
        id: 'cmd:home',
        label: t('palette.home'),
        icon: <Home className="size-4" aria-hidden />,
        run: () => void navigate({ to: '/' }),
      },
      {
        id: 'cmd:light',
        label: t('palette.themeLight'),
        icon: <Sun className="size-4" aria-hidden />,
        run: () => setTheme('light'),
      },
      {
        id: 'cmd:dark',
        label: t('palette.themeDark'),
        icon: <Moon className="size-4" aria-hidden />,
        run: () => setTheme('dark'),
      },
      {
        id: 'cmd:system',
        label: t('palette.themeSystem'),
        icon: <Monitor className="size-4" aria-hidden />,
        run: () => setTheme('system'),
      },
      {
        id: 'cmd:shortcuts',
        label: t('palette.shortcuts'),
        hint: '?',
        icon: <Keyboard className="size-4" aria-hidden />,
        run: onShortcuts,
      },
    ];
    for (const c of commands) {
      const rank = score(c.label, q);
      if (rank > 0) out.push({ rank: q === '' ? 0 : rank, item: { ...c, group: 'commands' } });
    }
    const order = { recent: 0, records: 1, goto: 2, commands: 3 } as const;
    return out
      .sort(
        (a, b) =>
          (q === '' ? order[a.item.group] - order[b.item.group] : 0) ||
          b.rank - a.rank ||
          order[a.item.group] - order[b.item.group],
      )
      .slice(0, 30)
      .map((o) => o.item);
  }, [
    query,
    debounced,
    apps.data,
    menus.data,
    found.data,
    uid,
    navigate,
    setTheme,
    t,
    onShortcuts,
  ]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  const choose = (item: Item | undefined) => {
    if (item === undefined) return;
    close();
    item.run();
  };
  const groups = ['recent', 'records', 'goto', 'commands'] as const;
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RDialog.Content
          className="fixed start-1/2 top-[12vh] z-50 w-[min(40rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-surface text-surface-foreground shadow-2xl ltr:-translate-x-1/2 rtl:translate-x-1/2"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
        >
          <RDialog.Title className="sr-only">{t('palette.title')}</RDialog.Title>
          <RDialog.Description className="sr-only">{t('palette.description')}</RDialog.Description>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={items.length === 0 ? undefined : optionId(active)}
              aria-label={t('palette.title')}
              placeholder={t('palette.placeholder')}
              className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((i) => Math.min(items.length - 1, i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((i) => Math.max(0, i - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  choose(items[active]);
                }
              }}
            />
            <kbd className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">Esc</kbd>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={t('palette.results')}
            className="max-h-[55vh] overflow-y-auto p-2"
          >
            {items.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {found.isFetching ? t('palette.searching') : t('palette.empty')}
              </p>
            ) : (
              groups.map((group) => {
                const inGroup = items
                  .map((item, index) => ({ item, index }))
                  .filter((x) => x.item.group === group);
                if (inGroup.length === 0) return null;
                return (
                  <div key={group} role="presentation">
                    <p
                      role="presentation"
                      className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {t(`palette.group.${group}`)}
                    </p>
                    {inGroup.map(({ item, index }) => (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input handles the keyboard
                      <div
                        key={item.id}
                        id={optionId(index)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={index === active}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm',
                          index === active && 'bg-accent text-accent-foreground',
                        )}
                        onMouseMove={() => setActive(index)}
                        onClick={() => choose(item)}
                      >
                        <span className="flex size-6 items-center justify-center text-muted-foreground">
                          {item.icon}
                        </span>
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.hint === undefined ? null : (
                          <span className="text-xs text-muted-foreground">{item.hint}</span>
                        )}
                        {index === active ? (
                          <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
                        ) : null}
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
