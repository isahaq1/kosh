/**
 * The Workspace sidebar (RFC 0018 §4.1): the company at the top, search, Home, then the user's apps — each a button
 * that opens its sections (the current app opens itself; one at a time) — and the user at the bottom. It collapses
 * to an icon rail (`Ctrl+B`, remembered per browser) and becomes a drawer on small screens. The server decides which
 * apps and menus the user sees; the sidebar shows them.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, House, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppEntry, KoshApi, MenuNode } from '../api.js';
import { AppIcon } from '../components/AppIcon.js';
import { Button } from '../components/primitives.js';
import { cn } from '../lib/cn.js';

const SIDEBAR_KEY = 'kosh.sidebar';

/** Whether the sidebar is collapsed to its rail, remembered per browser. */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setCollapsed(next);
    try {
      if (next) localStorage.setItem(SIDEBAR_KEY, 'collapsed');
      else localStorage.removeItem(SIDEBAR_KEY);
    } catch {
      // storage unavailable: the choice lasts for this page
    }
  };
  return [collapsed, set];
}

/** An app's entries as the sidebar lists them: its top level, with groups (Reporting, Configuration) kept. */
function entriesOf(menus: readonly MenuNode[]): MenuNode[] {
  return menus.flatMap((root) => (root.action === undefined ? [...root.children] : [root]));
}

function SectionLink({
  app,
  node,
  onNavigate,
}: {
  readonly app: string;
  readonly node: MenuNode;
  readonly onNavigate?: (() => void) | undefined;
}): ReactElement | null {
  if (node.action === undefined) return null;
  return (
    <Link
      to="/$app/a/$action"
      params={{ app, action: node.action }}
      onClick={onNavigate}
      className="block truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      activeProps={{
        'aria-current': 'page',
        className: 'bg-accent font-medium text-accent-foreground hover:bg-accent',
      }}
    >
      {node.label}
    </Link>
  );
}

function AppSections({
  api,
  app,
  company,
  onNavigate,
}: {
  readonly api: KoshApi;
  readonly app: string;
  readonly company: number;
  readonly onNavigate?: (() => void) | undefined;
}): ReactElement {
  const menus = useQuery({
    queryKey: ['menus', app, company],
    queryFn: () => api.menus(app),
  });
  return (
    <ul className="ms-4 grid gap-0.5 border-s ps-2 pt-1 pb-2">
      {entriesOf(menus.data ?? []).map((node) =>
        node.children.length > 0 ? (
          <li key={node.id} className="pt-1">
            <p className="px-2 pb-0.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {node.label}
            </p>
            <ul className="grid gap-0.5">
              {node.children.map((child) => (
                <li key={child.id}>
                  <SectionLink app={app} node={child} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </li>
        ) : (
          <li key={node.id}>
            <SectionLink app={app} node={node} onNavigate={onNavigate} />
          </li>
        ),
      )}
    </ul>
  );
}

export function Sidebar({
  api,
  apps,
  current,
  company,
  collapsed,
  onCollapse,
  onSearch,
  top,
  bottom,
  onNavigate,
}: {
  readonly api: KoshApi;
  readonly apps: readonly AppEntry[];
  /** The open app (from the URL). */
  readonly current: string | undefined;
  readonly company: number;
  readonly collapsed: boolean;
  /** Absent in the drawer (it closes instead). */
  readonly onCollapse?: ((collapsed: boolean) => void) | undefined;
  readonly onSearch: () => void;
  /** The company block. */
  readonly top: ReactNode;
  /** The user menu. */
  readonly bottom: ReactNode;
  /** After following a link (the drawer closes). */
  readonly onNavigate?: (() => void) | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | undefined>(current);
  useEffect(() => setOpen(current), [current]);
  const item =
    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted focus-visible:outline-2';
  return (
    <div className="flex h-full flex-col gap-1 p-2">
      <div className={cn('pb-1', collapsed && 'flex justify-center')}>{top}</div>
      <button
        type="button"
        className={cn(item, 'text-muted-foreground', collapsed && 'justify-center')}
        onClick={onSearch}
        aria-keyshortcuts="Control+K Meta+K"
        aria-label={collapsed ? t('palette.button') : undefined}
        title={collapsed ? t('palette.button') : undefined}
      >
        <Search className="size-4 shrink-0" aria-hidden />
        {collapsed ? null : (
          <>
            <span className="flex-1 text-start">{t('palette.button')}</span>
            <kbd className="rounded border bg-surface px-1 text-[0.65rem]">Ctrl K</kbd>
          </>
        )}
      </button>
      <Link
        to="/"
        onClick={onNavigate}
        className={cn(item, collapsed && 'justify-center')}
        activeOptions={{ exact: true }}
        activeProps={{ 'aria-current': 'page', className: 'bg-muted font-medium' }}
        aria-label={collapsed ? t('shell.home') : undefined}
        title={collapsed ? t('shell.home') : undefined}
      >
        <House className="size-4 shrink-0" aria-hidden />
        {collapsed ? null : t('shell.home')}
      </Link>
      <nav
        aria-label={t('shell.menu')}
        className="-mx-2 mt-2 flex-1 overflow-y-auto border-t px-2 pt-2"
      >
        <ul className="grid gap-0.5">
          {apps.map((a) => {
            const expanded = !collapsed && open === a.code;
            return (
              <li key={a.code}>
                <button
                  type="button"
                  aria-expanded={collapsed ? undefined : expanded}
                  // "Sales app": distinct from the screens' own buttons named like an app (Chat, Studio).
                  aria-label={t('shell.appNamed', { app: a.label })}
                  title={collapsed ? a.label : undefined}
                  className={cn(
                    item,
                    current === a.code && 'font-medium',
                    collapsed && 'justify-center',
                  )}
                  onClick={() => {
                    if (collapsed || a.code !== current) {
                      setOpen(a.code);
                      void navigate({ to: '/$app', params: { app: a.code } });
                      onNavigate?.();
                    } else setOpen(expanded ? undefined : a.code);
                  }}
                >
                  <AppIcon name={a.icon ?? a.code} className="size-6 rounded-md [&_svg]:size-3.5" />
                  {collapsed ? null : (
                    <>
                      <span className="flex-1 truncate text-start">{a.label}</span>
                      <ChevronDown
                        className={cn(
                          'size-3.5 text-muted-foreground transition-transform',
                          !expanded && '-rotate-90 rtl:rotate-90',
                        )}
                        aria-hidden
                      />
                    </>
                  )}
                </button>
                {expanded ? (
                  <AppSections api={api} app={a.code} company={company} onNavigate={onNavigate} />
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className={cn('flex items-center gap-1 border-t pt-2', collapsed && 'flex-col')}>
        <div className="min-w-0 flex-1">{bottom}</div>
        {onCollapse === undefined ? null : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
            title={`${collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')} (Ctrl B)`}
            aria-keyshortcuts="Control+B Meta+B"
            onClick={() => onCollapse(!collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen className="rtl:rotate-180" aria-hidden />
            ) : (
              <PanelLeftClose className="rtl:rotate-180" aria-hidden />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The sidebar as a drawer on small screens. */
export function SidebarDrawer({
  open,
  onOpenChange,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 start-0 z-50 w-72 max-w-[85vw] border-e bg-surface shadow-xl outline-none">
          <Dialog.Title className="sr-only">{t('shell.menu')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('shell.menuHint')}</Dialog.Description>
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute end-2 top-2 z-10"
              aria-label={t('shell.closeMenu')}
            >
              <X aria-hidden />
            </Button>
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
