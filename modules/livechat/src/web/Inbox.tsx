/**
 * The operator's inbox (RFC 0034 §2.6): whether they take conversations, the conversations that wait in their
 * channels and those they are in, and the one that is open — read as it comes, answered, ended. The page asks the
 * server every few seconds, which is also how the server knows the operator is there. It decides nothing: who may
 * read, take or answer a conversation is the server's.
 */
import { Alert, Button, Input, type PageProps, Spinner } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Row {
  readonly id: number;
  readonly name: string;
  readonly channel: string;
  readonly state: string;
  readonly visitor: string;
  readonly email: string | null;
  readonly page: string | null;
  readonly messageCount: number;
  readonly mine: boolean;
  readonly last: string;
}
interface InboxData {
  readonly available: boolean;
  readonly channels: number;
  readonly sessions: readonly Row[];
}
interface View {
  readonly id: number;
  readonly state: string;
  readonly operator: string | null;
  readonly messages: readonly {
    readonly id: number;
    readonly kind: string;
    readonly author: string;
    readonly body: string;
    readonly at: string;
  }[];
}

export function Inbox({ api }: PageProps): ReactElement {
  const { t } = useTranslation('livechat');
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<number | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const inbox = useQuery({
    queryKey: ['livechat', 'inbox'],
    queryFn: () => api.call<InboxData>('GET', '/api/v1/livechat/inbox'),
    refetchInterval: 4000,
  });
  const open = useQuery({
    queryKey: ['livechat', 'session', openId],
    queryFn: () => api.call<View>('GET', `/api/v1/livechat/sessions/${openId ?? 0}`),
    enabled: openId !== null,
    refetchInterval: 3000,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['livechat'] });
  };
  const failed = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));
  const presence = useMutation({
    mutationFn: (available: boolean) => api.call('PUT', '/api/v1/livechat/presence', { available }),
    onSuccess: refresh,
    onError: failed,
  });
  const take = useMutation({
    mutationFn: (id: number) => api.call('POST', `/api/v1/livechat/sessions/${id}/take`),
    onSuccess: (_r, id) => {
      setOpenId(id);
      setError(null);
      refresh();
    },
    onError: (e) => {
      failed(e);
      refresh();
    },
  });
  const send = useMutation({
    mutationFn: (body: string) =>
      api.call('POST', `/api/v1/livechat/sessions/${openId ?? 0}/messages`, { body }),
    onSuccess: () => {
      setReply('');
      setError(null);
      refresh();
    },
    onError: failed,
  });
  const end = useMutation({
    mutationFn: () => api.call('POST', `/api/v1/livechat/sessions/${openId ?? 0}/close`),
    onSuccess: refresh,
    onError: failed,
  });
  const count = open.data?.messages.length ?? 0;
  // The newest message stays in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the number of messages changes
  useEffect(() => {
    if (log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [count, openId]);

  if (inbox.isPending) return <Spinner label={t('loading')} />;
  if (inbox.isError) return <Alert tone="danger">{t('failed')}</Alert>;
  const data = inbox.data;
  if (data.channels === 0) return <Alert tone="info">{t('noChannels')}</Alert>;
  const current = data.sessions.find((s) => s.id === openId);
  const who = (s: { visitor: string }): string => (s.visitor === '' ? t('visitor') : s.visitor);
  const view = open.data;
  const over = view !== undefined && (view.state === 'closed' || view.state === 'missed');
  const mine = current?.mine === true && view?.state === 'active';

  return (
    <div className="grid gap-4 p-4 md:grid-cols-[20rem_1fr]">
      <section aria-label={t('conversations')} className="grid content-start gap-3">
        <div className="grid gap-1 rounded-md border p-3">
          <Button
            variant={data.available ? 'primary' : 'secondary'}
            aria-pressed={data.available}
            busy={presence.isPending}
            onClick={() => presence.mutate(!data.available)}
          >
            {data.available ? t('available') : t('away')}
          </Button>
          <p className="text-xs text-muted-foreground">
            {data.available ? t('availableHint') : t('awayHint')}
          </p>
        </div>
        {data.sessions.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('none')}
          </p>
        ) : (
          <ul className="grid gap-2">
            {data.sessions.map((s) => (
              <li
                key={s.id}
                className={`grid gap-1 rounded-md border p-3 text-sm ${s.id === openId ? 'border-primary' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{who(s)}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.mine ? t('mine') : t('waiting')} · {s.channel}
                  </span>
                </div>
                <p className="line-clamp-2 text-muted-foreground">{s.last}</p>
                {s.page === null ? null : (
                  <p className="text-xs text-muted-foreground">{t('from', { page: s.page })}</p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={t('openNamed', { who: who(s) })}
                    onClick={() => {
                      setOpenId(s.id);
                      setError(null);
                    }}
                  >
                    {s.name}
                  </Button>
                  {s.mine ? null : (
                    <Button
                      size="sm"
                      variant="primary"
                      aria-label={t('takeNamed', { who: who(s) })}
                      busy={take.isPending && take.variables === s.id}
                      onClick={() => take.mutate(s.id)}
                    >
                      {t('take')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid min-h-[24rem] content-start gap-3">
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        {openId === null || view === undefined ? (
          <p className="text-sm text-muted-foreground">{t('choose')}</p>
        ) : (
          <>
            <div
              ref={log}
              role="log"
              aria-live="polite"
              aria-label={t('log', { who: current === undefined ? t('visitor') : who(current) })}
              className="grid max-h-[60vh] content-start gap-2 overflow-y-auto rounded-md border p-3"
            >
              {view.messages.map((m) =>
                m.kind === 'system' ? (
                  <p key={m.id} className="text-center text-xs text-muted-foreground">
                    {m.body}
                  </p>
                ) : (
                  <div
                    key={m.id}
                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                      m.kind === 'operator'
                        ? 'justify-self-end bg-primary text-primary-foreground'
                        : 'justify-self-start bg-muted'
                    }`}
                  >
                    <span className="block text-xs opacity-80">
                      {m.kind === 'operator' ? m.author || t('you') : m.author || t('visitor')}
                    </span>
                    {m.body}
                  </div>
                ),
              )}
            </div>
            {over ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t('ended')}
              </p>
            ) : mine ? (
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reply.trim() !== '') send.mutate(reply);
                }}
              >
                <div className="flex gap-2">
                  <Input
                    aria-label={t('reply')}
                    placeholder={t('replyHint')}
                    maxLength={2000}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={reply.trim() === ''}
                    busy={send.isPending}
                  >
                    {t('send')}
                  </Button>
                </div>
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    busy={end.isPending}
                    onClick={() => end.mutate()}
                  >
                    {t('end')}
                  </Button>
                </div>
              </form>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {t('notYet')}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
