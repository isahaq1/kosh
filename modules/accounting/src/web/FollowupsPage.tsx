/**
 * Accounting › Follow-ups (RFC 0029 §3.4): every customer with overdue invoices — how much, how late, the level
 * reached and the last one sent, a pause with its promise. Send now sends the reminder of the level reached; Pause
 * holds reminders until a date. The server decides what is due, sends and refuses.
 */
import { Alert, Button, Input, Label, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Row {
  readonly partner: number;
  readonly name: string;
  readonly amount: string;
  readonly days: number;
  readonly invoices: readonly { readonly id: number; readonly name: string }[];
  readonly due: { readonly name: string } | null;
  readonly sent: { readonly name: string } | null;
  readonly sentAt: string | null;
  readonly pausedUntil: string | null;
  readonly pauseNote: string | null;
}

export function FollowupsPage({ api, label }: PageProps): ReactElement {
  const { t } = useTranslation('accounting');
  const { format } = useKosh();
  const id = useId();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [pausing, setPausing] = useState<number | null>(null);
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const rows = useQuery({
    queryKey: ['accounting', 'followups'],
    queryFn: () => api.call<{ rows: Row[] }>('GET', '/api/v1/accounting/followups'),
  });
  const done = async (text: string) => {
    setMessage(text);
    await queryClient.invalidateQueries({ queryKey: ['accounting', 'followups'] });
  };
  const send = useMutation({
    mutationFn: (partner: number) =>
      api.call<{ level: string; channels: string[] }>(
        'POST',
        `/api/v1/accounting/followups/${partner}/send`,
      ),
    onSuccess: (r) =>
      done(t('followups.sent', { level: r.level, channels: r.channels.join(', ') })),
  });
  const pause = useMutation({
    mutationFn: (input: { partner: number; until: string | null }) =>
      api.call('POST', `/api/v1/accounting/followups/${input.partner}/pause`, {
        until: input.until,
        note,
      }),
    onSuccess: (_r, input) => {
      setPausing(null);
      return done(input.until === null ? t('followups.resumed') : t('followups.paused'));
    },
  });
  const error = send.error ?? pause.error;
  const list = rows.data?.rows ?? [];
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4">
      <h1 id={`${id}-title`} className="text-lg font-semibold">
        {label ?? t('followups.title')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('followups.intro')}</p>
      {message === null ? null : <Alert tone="info">{message}</Alert>}
      {error === null ? null : <Alert>{error.message}</Alert>}
      {list.length === 0 && !rows.isPending ? (
        <p className="text-sm text-muted-foreground">{t('followups.nobody')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-start text-muted-foreground">
              <tr>
                <th className="py-1 text-start font-medium">{t('followups.customer')}</th>
                <th className="py-1 text-end font-medium">{t('followups.overdue')}</th>
                <th className="py-1 text-end font-medium">{t('followups.late')}</th>
                <th className="py-1 text-start font-medium">{t('followups.level')}</th>
                <th className="py-1 text-start font-medium">{t('followups.lastSent')}</th>
                <th className="py-1">
                  <span className="sr-only">{t('followups.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.partner} className="border-t align-top">
                  <td className="py-2">
                    <span className="font-medium">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.invoices.map((i) => i.name).join(', ')}
                    </span>
                    {r.pausedUntil === null ? null : (
                      <span className="block text-xs text-muted-foreground">
                        {t('followups.pausedUntil', {
                          date: format.date(r.pausedUntil),
                          note: r.pauseNote ?? '',
                        })}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-end tabular-nums">{r.amount}</td>
                  <td className="py-2 text-end tabular-nums">
                    {t('followups.days', { count: r.days })}
                  </td>
                  <td className="py-2">{r.due?.name ?? t('followups.none')}</td>
                  <td className="py-2">
                    {r.sent === null
                      ? t('followups.never')
                      : `${r.sent.name}${r.sentAt === null ? '' : ` · ${format.date(r.sentAt)}`}`}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        size="sm"
                        disabled={r.due === null}
                        busy={send.isPending && send.variables === r.partner}
                        onClick={() => send.mutate(r.partner)}
                      >
                        {t('followups.sendNow')}
                      </Button>
                      {r.pausedUntil === null ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setPausing(r.partner);
                            setUntil('');
                            setNote('');
                          }}
                        >
                          {t('followups.pause')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={pause.isPending}
                          onClick={() => pause.mutate({ partner: r.partner, until: null })}
                        >
                          {t('followups.resume')}
                        </Button>
                      )}
                    </div>
                    {pausing !== r.partner ? null : (
                      <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-end">
                        <div className="grid gap-1">
                          <Label htmlFor={`${id}-until`}>{t('followups.until')}</Label>
                          <Input
                            id={`${id}-until`}
                            type="date"
                            value={until}
                            onChange={(e) => setUntil(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={`${id}-note`}>{t('followups.promise')}</Label>
                          <Input
                            id={`${id}-note`}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                          />
                        </div>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={until === ''}
                          busy={pause.isPending}
                          onClick={() => pause.mutate({ partner: r.partner, until })}
                        >
                          {t('followups.confirmPause')}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
