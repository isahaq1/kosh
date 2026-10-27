/**
 * The signed-in frame: the company's name, the document types the user has, the profile and signing out. Anyone
 * not signed in as a portal user goes to the sign-in page.
 */
import { Button, Spinner } from '@kosh/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { LogOut, UserRound } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { type DocumentType, type Me, usePortal } from '../portal.js';

export function Layout(): ReactElement {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['portal', 'me'],
    queryFn: () => api.call<Me>('GET', '/api/portal/v1/me'),
    retry: false,
  });
  const types = useQuery({
    queryKey: ['portal', 'documents'],
    queryFn: () => api.call<{ documents: DocumentType[] }>('GET', '/api/portal/v1/documents'),
    enabled: me.data !== undefined,
  });
  useEffect(() => {
    if (me.isError) void navigate({ to: '/login' });
  }, [me.isError, navigate]);
  if (me.data === undefined)
    return (
      <div className="grid min-h-svh place-items-center">
        <Spinner label={t('home')} />
      </div>
    );
  const link =
    'rounded-md px-3 py-1.5 text-sm hover:bg-muted [&.active]:bg-accent [&.active]:font-medium';
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-3">
          <span className="me-auto font-semibold">{me.data.company.name}</span>
          <Link to="/profile" className="inline-flex items-center gap-1 text-sm">
            <UserRound className="size-4" aria-hidden />
            {me.data.name}
          </Link>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('signOut')}
            onClick={async () => {
              await api.logout();
              queryClient.clear();
              await navigate({ to: '/login' });
            }}
          >
            <LogOut aria-hidden />
          </Button>
        </div>
        <nav
          aria-label={t('home')}
          className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 pb-2"
        >
          <Link to="/" className={link} activeOptions={{ exact: true }}>
            {t('home')}
          </Link>
          {(types.data?.documents ?? []).map((d) => (
            <Link key={d.key} to="/d/$key" params={{ key: d.key }} className={link}>
              {d.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto grid max-w-5xl gap-4 px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
