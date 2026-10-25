/**
 * The cloud in the header (RFC 0010 Phase B): shown while offline, and while changes saved on this device wait
 * to be sent or need the user's decision. Each change can be opened, sent again (overwriting on a conflict, which
 * is the user's explicit choice), or discarded.
 */
import { useNavigate } from '@tanstack/react-router';
import { CloudAlert, CloudOff, CloudUpload } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/primitives.js';
import { useKosh } from '../context.js';
import { useOnline } from '../offline/persist.js';
import type { OfflineQueue, QueuedChange } from '../offline/queue.js';

export function useQueuedChanges(queue: OfflineQueue | undefined): readonly QueuedChange[] {
  return useSyncExternalStore(
    (notify) => queue?.subscribe(notify) ?? (() => {}),
    () => queue?.snapshot() ?? EMPTY,
    () => EMPTY,
  );
}
const EMPTY: readonly QueuedChange[] = [];

export function OfflineMenu(): ReactElement | null {
  const { offline: queue, format } = useKosh();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const online = useOnline();
  const items = useQueuedChanges(queue);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (online && items.length === 0) return null;
  const attention = items.filter((i) => i.status !== 'pending').length;
  const Icon = !online ? CloudOff : attention > 0 ? CloudAlert : CloudUpload;
  const label = !online
    ? t('offline.offline', { count: items.length })
    : attention > 0
      ? t('offline.attention', { count: attention })
      : t('offline.pending', { count: items.length });
  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await run();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex size-9 items-center justify-center rounded-md hover:bg-muted"
          aria-label={label}
          data-kosh-offline={!online ? 'offline' : attention > 0 ? 'attention' : 'pending'}
        >
          <Icon
            className={`size-4 ${!online ? 'text-muted-foreground' : attention > 0 ? 'text-warning-text' : 'text-primary'}`}
            aria-hidden
          />
          {items.length === 0 ? null : (
            <span
              aria-hidden
              className={`absolute -end-0.5 -top-0.5 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 ${attention > 0 ? 'bg-warning text-warning-foreground' : 'bg-primary text-primary-foreground'}`}
            >
              {items.length}
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
          <div className="border-b px-3 py-2">
            <h2 className="text-sm font-semibold">
              {online ? t('offline.changes') : t('offline.youAreOffline')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {online ? t('offline.changesHint') : t('offline.offlineHint')}
            </p>
          </div>
          <ul aria-label={t('offline.changes')} className="max-h-[60vh] overflow-y-auto py-1">
            {items.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                {t('offline.none')}
              </li>
            ) : (
              items.map((item) => (
                <li key={item.id} className="grid gap-1 px-3 py-2 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">
                      {item.kind === 'create'
                        ? t('offline.newIn', { list: item.modelLabel })
                        : item.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {format.datetime(new Date(item.at).toISOString())}
                    </span>
                  </div>
                  <span
                    className={`text-xs ${item.status === 'pending' ? 'text-muted-foreground' : 'text-warning-text'}`}
                  >
                    {item.status === 'pending'
                      ? t('offline.statusPending')
                      : item.status === 'conflict'
                        ? t('offline.statusConflict')
                        : t('offline.statusRefused', { reason: item.error ?? '' })}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {item.kind === 'update' &&
                    item.app !== undefined &&
                    item.action !== undefined ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setOpen(false);
                          void navigate({
                            to: '/$app/a/$action/$id',
                            params: {
                              app: item.app as string,
                              action: item.action as string,
                              id: String(item.recordId),
                            },
                          });
                        }}
                      >
                        {t('offline.open')}
                      </Button>
                    ) : null}
                    {item.status === 'conflict' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        busy={busy === item.id}
                        onClick={() =>
                          act(item.id, () => queue?.retry(item.id, true) ?? Promise.resolve())
                        }
                      >
                        {t('offline.overwrite')}
                      </Button>
                    ) : item.status === 'refused' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        busy={busy === item.id}
                        onClick={() =>
                          act(item.id, () => queue?.retry(item.id) ?? Promise.resolve())
                        }
                      >
                        {t('offline.retry')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      busy={busy === item.id}
                      onClick={() =>
                        act(item.id, () => queue?.discard(item.id) ?? Promise.resolve())
                      }
                    >
                      {t('offline.discard')}
                    </Button>
                  </div>
                </li>
              ))
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
