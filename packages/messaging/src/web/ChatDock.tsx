/**
 * The chat dock (RFC 0006 §6.4): a header item with the unread count, a list of conversations, and small panels
 * at the bottom corner of any page for the conversations opened from it, so a chat goes on while working on a
 * record (full screen on a phone). Hidden for users without Messaging.
 */
import { ApiError, Badge, type HeaderItemProps, useKosh } from '@kosh/ui';
import { useNavigate } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelItem } from '../chat.js';
import { Conversation, useChannels } from './Chat.js';

const DOCK_KEY = 'kosh.chat.dock';
const MAX_PANELS = 3;

function readDock(): number[] {
  try {
    const stored = sessionStorage.getItem(DOCK_KEY);
    const ids = stored === null ? [] : (JSON.parse(stored) as unknown);
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'number') : [];
  } catch {
    return [];
  }
}

export function ChatDock({ api }: HeaderItemProps): ReactElement | null {
  const { t } = useTranslation('messaging');
  const { registry } = useKosh();
  const navigate = useNavigate();
  const channels = useChannels(api);
  const [open, setOpen] = useState(false);
  const [panels, setPanels] = useState<number[]>(readDock);
  const setDock = (ids: number[]) => {
    setPanels(ids);
    try {
      sessionStorage.setItem(DOCK_KEY, JSON.stringify(ids));
    } catch {
      // storage unavailable: the dock lives for the page
    }
  };
  if (channels.error instanceof ApiError && channels.error.status === 403) return null;
  if (registry.page('messaging.Chat') === undefined) return null;
  const list = channels.data?.channels ?? [];
  const unread = list.reduce((n, c) => n + c.unread, 0);
  const openPanel = (channel: ChannelItem) => {
    setOpen(false);
    if (!panels.includes(channel.id)) setDock([...panels.slice(-(MAX_PANELS - 1)), channel.id]);
  };
  const recent = [...list]
    .filter((c) => c.member)
    .sort(
      (a, b) =>
        (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) ||
        (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''),
    )
    .slice(0, 8);
  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-kosh-chat
            className="relative inline-flex size-9 items-center justify-center rounded-md hover:bg-muted"
            aria-label={unread === 0 ? t('chat.title') : t('chat.unreadTotal', { count: unread })}
          >
            <MessagesSquare className="size-4" aria-hidden />
            {unread === 0 ? null : (
              <span
                aria-hidden
                className="absolute -end-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground"
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
            className="z-40 w-[min(20rem,calc(100vw-1rem))] rounded-lg border bg-surface text-surface-foreground shadow-xl"
          >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <h2 className="text-sm font-semibold">{t('chat.title')}</h2>
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-primary hover:bg-muted"
                onClick={() => {
                  setOpen(false);
                  void navigate({
                    to: '/$app/a/$action',
                    params: { app: 'chat', action: 'messaging.action_chat' },
                  });
                }}
              >
                {t('chat.openApp')}
              </button>
            </div>
            <ul aria-label={t('chat.conversations')} className="max-h-[60vh] overflow-y-auto py-1">
              {recent.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('chat.none')}
                </li>
              ) : (
                recent.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted"
                      onClick={() => openPanel(c)}
                    >
                      <span
                        className={
                          c.unread > 0
                            ? 'min-w-0 flex-1 truncate font-semibold'
                            : 'min-w-0 flex-1 truncate'
                        }
                      >
                        {c.kind === 'channel' ? '#' : ''}
                        {c.name}
                      </span>
                      {c.unread > 0 ? <Badge tone="info">{c.unread}</Badge> : null}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {panels.length === 0 ? null : (
        <section
          className="fixed inset-0 z-30 flex items-end justify-end gap-2 sm:inset-auto sm:bottom-0 sm:end-4 sm:pointer-events-none"
          aria-label={t('chat.dock')}
        >
          {panels.map((id) => {
            const channel = list.find((c) => c.id === id);
            if (channel === undefined) return null;
            return (
              <div
                key={id}
                className="pointer-events-auto flex h-full w-full flex-col bg-surface text-surface-foreground shadow-xl sm:h-[28rem] sm:w-80 sm:rounded-t-lg sm:border"
              >
                <Conversation
                  api={api}
                  channel={channel}
                  compact
                  onClose={() => setDock(panels.filter((p) => p !== id))}
                />
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}
