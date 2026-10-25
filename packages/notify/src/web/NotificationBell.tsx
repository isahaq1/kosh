/**
 * The bell in the header (RFC 0006 §5.4, in-app channel): the unread count, live through the realtime gateway, and
 * a panel of the latest notifications. Opening one marks it read and goes to its record (where the user may open
 * it, `GET /api/v1/routes`). Everything shown is the user's own: the server serves nothing else.
 */
import { type HeaderItemProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Bell, CheckCheck } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Item {
  readonly id: number;
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly model: string;
  readonly resId: number;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export function NotificationBell({ api }: HeaderItemProps): ReactElement {
  const { t } = useTranslation('notify');
  const { realtime, format } = useKosh();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const count = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: () => api.call<{ unread: number }>('GET', '/api/v1/notifications/count'),
    refetchInterval: realtime === undefined ? 60_000 : false, // the gateway tells us; else poll gently
  });
  const list = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => api.call<{ items: Item[] }>('GET', '/api/v1/notifications?limit=30'),
    enabled: open,
  });
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api.routes(), enabled: open });
  useEffect(
    () =>
      realtime?.subscribe('model:notify.notification', () => {
        void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      }),
    [realtime, queryClient],
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const readOne = useMutation({
    mutationFn: (id: number) => api.call('POST', `/api/v1/notifications/${id}/read`, {}),
    onSuccess: refresh,
  });
  const readAll = useMutation({
    mutationFn: () => api.call('POST', '/api/v1/notifications/read-all', {}),
    onSuccess: refresh,
  });
  const unread = count.data?.unread ?? 0;
  const text = (n: Item) => {
    const params = { ...n.params };
    if (typeof params['state'] === 'string')
      params['state'] = t(`states.${params['state']}`, { defaultValue: params['state'] });
    if (typeof params['deadline'] === 'string' && params['deadline'] !== '')
      params['deadline'] = format.date(params['deadline']);
    return t(`kinds.${n.kind}`, { ...params, defaultValue: n.kind });
  };
  const openOne = (n: Item) => {
    if (n.readAt === null) readOne.mutate(n.id);
    setOpen(false);
    const route = routes.data?.[n.model];
    if (route?.app === undefined) return;
    void navigate({
      to: '/$app/a/$action/$id',
      params: { app: route.app, action: route.action, id: String(n.resId) },
    });
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex size-9 items-center justify-center rounded-md hover:bg-muted"
          aria-label={unread === 0 ? t('title') : t('unread', { count: unread })}
        >
          <Bell className="size-4" aria-hidden />
          {unread === 0 ? null : (
            <span
              aria-hidden
              className="absolute -end-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-danger-foreground"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-40 w-[min(24rem,calc(100vw-1rem))] rounded-lg border bg-surface text-surface-foreground shadow-xl"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h2 className="text-sm font-semibold">{t('title')}</h2>
            {unread === 0 ? null : (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-muted"
                onClick={() => readAll.mutate()}
              >
                <CheckCheck className="size-3.5" aria-hidden />
                {t('markAllRead')}
              </button>
            )}
          </div>
          <ul aria-label={t('title')} className="max-h-[60vh] overflow-y-auto py-1">
            {(list.data?.items ?? []).length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t('empty')}</li>
            ) : (
              (list.data?.items ?? []).map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 px-3 py-2 text-start text-sm hover:bg-muted"
                    onClick={() => openOne(n)}
                  >
                    <span
                      aria-hidden
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt === null ? 'bg-primary' : 'bg-transparent'}`}
                    />
                    <span className="grid gap-0.5">
                      <span className={n.readAt === null ? 'font-medium' : ''}>{text(n)}</span>
                      <span className="text-xs text-muted-foreground">
                        {format.datetime(n.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
