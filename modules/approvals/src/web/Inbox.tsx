/**
 * The Approvals inbox (RFC 0025 §3.1): what waits for me, as cards — the record and its app, who asked and how long
 * ago, every level of the round as a step with its votes —, decided one by one (approve, reject or send back, with a
 * comment; a reason is needed for the last two) or many at once. Keyboard: J / K move, A approves, R rejects, X
 * selects. The server decides who may decide what; this page shows and sends.
 */
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  type PageProps,
  Textarea,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ago, type Card, cardsQuery, Steps, waitedTone } from './shared.js';

type Decision = 'approve' | 'reject' | 'send-back';

export function Inbox({ api }: PageProps): ReactElement {
  const { t } = useTranslation('approvals');
  const { format } = useKosh();
  const id = useId();
  const client = useQueryClient();
  const cards = useQuery(cardsQuery(api, 'inbox'));
  const stats = useQuery({
    queryKey: ['approvals', 'stats'],
    queryFn: () =>
      api.call<{
        waiting: number;
        overdue: number;
        decidedThisMonth: number;
        medianHours: number | null;
      }>('GET', '/api/v1/approvals/stats'),
  });
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api.routes() });
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [focus, setFocus] = useState(0);
  const [comments, setComments] = useState<Readonly<Record<number, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const rows = cards.data ?? [];
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['approvals'] });
    await client.invalidateQueries({ queryKey: ['home', 'approvals'] });
  };
  const decide = useMutation({
    mutationFn: ({ request, decision }: { request: number; decision: Decision }) =>
      api.call('POST', `/api/v1/approvals/requests/${request}/${decision}`, {
        comment: comments[request] ?? '',
      }),
    onSuccess: async (_r, v) => {
      setMessage(t(`done.${v.decision}`));
      await refresh();
    },
    onError: (e) => setMessage(e.message),
  });
  const bulk = useMutation({
    mutationFn: () =>
      api.call<{ approved: number; failed: { id: number; reason: string }[] }>(
        'POST',
        '/api/v1/approvals/bulk',
        { requests: [...selected], decision: 'approve' },
      ),
    onSuccess: async (r) => {
      setMessage(t('bulkDone', { count: r.approved, failed: r.failed.length }));
      setSelected(new Set());
      await refresh();
    },
    onError: (e) => setMessage(e.message),
  });
  // Keyboard: J / K move, A approves, R rejects (with the comment typed), X selects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target !== null && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      const card = rows[focus];
      if (e.key === 'j') setFocus((f) => Math.min(f + 1, rows.length - 1));
      else if (e.key === 'k') setFocus((f) => Math.max(f - 1, 0));
      else if (card === undefined) return;
      else if (e.key === 'a') decide.mutate({ request: card.id, decision: 'approve' });
      else if (e.key === 'r' && (comments[card.id] ?? '').trim() !== '')
        decide.mutate({ request: card.id, decision: 'reject' });
      else if (e.key === 'x')
        setSelected((s) => {
          const next = new Set(s);
          if (next.has(card.id)) next.delete(card.id);
          else next.add(card.id);
          return next;
        });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, focus, comments, decide]);
  const link = (c: Card) => {
    const route = routes.data?.[c.record.model];
    return route?.app === undefined ? null : `/${route.app}/a/${route.action}/${c.record.id}`;
  };
  return (
    <div className="grid gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t('inbox.title')}</h1>
        <Badge tone="neutral">{rows.length}</Badge>
        <p className="w-full text-sm text-muted-foreground">{t('inbox.hint')}</p>
      </header>
      {stats.data === undefined ? null : (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(
            [
              ['waiting', String(stats.data.waiting), 'neutral'],
              [
                'overdue',
                String(stats.data.overdue),
                stats.data.overdue > 0 ? 'danger' : 'neutral',
              ],
              ['decided', String(stats.data.decidedThisMonth), 'neutral'],
              [
                'median',
                stats.data.medianHours === null ? '—' : t('hours', { n: stats.data.medianHours }),
                'neutral',
              ],
            ] as const
          ).map(([key, value, tone]) => (
            <div key={key} className="rounded-lg border bg-surface p-3">
              <dt className="text-xs text-muted-foreground">{t(`stats.${key}`)}</dt>
              <dd
                className={`text-2xl font-semibold tabular-nums ${tone === 'danger' ? 'text-danger' : ''}`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {rows.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            id={`${id}-all`}
            checked={selected.size === rows.length && rows.length > 0}
            onCheckedChange={(c) =>
              setSelected(c === true ? new Set(rows.map((r) => r.id)) : new Set())
            }
          />
          <label htmlFor={`${id}-all`} className="text-sm">
            {t('inbox.selectAll')}
          </label>
          <Button
            variant="primary"
            disabled={selected.size === 0 || bulk.isPending}
            onClick={() => bulk.mutate()}
          >
            {t('inbox.approveSelected', { count: selected.size })}
          </Button>
        </div>
      )}
      {message === null ? null : <Alert tone="info">{message}</Alert>}
      {cards.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : rows.length === 0 ? (
        <EmptyState title={t('inbox.empty')} description={t('inbox.emptyHint')} />
      ) : (
        <ul className="grid gap-3">
          {rows.map((c, i) => {
            const href = link(c);
            const comment = comments[c.id] ?? '';
            return (
              <li
                key={c.id}
                aria-current={i === focus ? 'true' : undefined}
                className={`grid gap-3 rounded-lg border bg-surface p-4 ${i === focus ? 'ring-2 ring-accent' : ''}`}
              >
                <div className="flex flex-wrap items-start gap-3">
                  <Checkbox
                    aria-label={t('inbox.select', { name: c.record.name })}
                    checked={selected.has(c.id)}
                    onCheckedChange={(v) =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (v === true) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                  />
                  <div className="grid min-w-0 flex-1 gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {href === null ? (
                        <span className="font-semibold">{c.record.name}</span>
                      ) : (
                        <a href={href} className="font-semibold underline-offset-2 hover:underline">
                          {c.record.name}
                        </a>
                      )}
                      <Badge tone="neutral">{c.record.label}</Badge>
                      <Badge tone={waitedTone(c)}>
                        {t('waiting', { since: ago(format.locale, c.waitingSince) })}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {t('askedBy', { name: c.requester?.name ?? '—' })} · {c.levelName}
                      {c.required > 1 ? ` · ${t('votes', { n: c.approvals, of: c.required })}` : ''}
                      {c.round > 1 ? ` · ${t('round', { n: c.round })}` : ''}
                    </p>
                  </div>
                </div>
                <Steps steps={c.steps} />
                <Textarea
                  aria-label={t('comment', { name: c.record.name })}
                  placeholder={t('commentHint')}
                  value={comment}
                  onChange={(e) => setComments((m) => ({ ...m, [c.id]: e.target.value }))}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ request: c.id, decision: 'approve' })}
                  >
                    {t('approve')}
                  </Button>
                  <Button
                    disabled={decide.isPending || comment.trim() === ''}
                    onClick={() => decide.mutate({ request: c.id, decision: 'send-back' })}
                  >
                    {t('sendBack')}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={decide.isPending || comment.trim() === ''}
                    onClick={() => decide.mutate({ request: c.id, decision: 'reject' })}
                  >
                    {t('reject')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
