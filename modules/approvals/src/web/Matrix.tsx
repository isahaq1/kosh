/**
 * The matrix (RFC 0027 §2.7): the requests of a period the user decides — directly (named, or holding the role) or
 * for others (as a backup, or for someone away) — a card per policy with what waits, what was approved and what was
 * rejected; for Approvals managers also how long each level takes and who has the most requests late. The waiting
 * counts open the inbox.
 */
import { Badge, Card, EmptyState, type PageProps, Select } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const PERIODS = ['7d', '30d', '3m', '6m', '1y', 'all'] as const;
type Period = (typeof PERIODS)[number];
type Mode = 'direct' | 'delegated';

interface Matrix {
  readonly cards: readonly {
    readonly policy: number | null;
    readonly title: string;
    readonly waiting: number;
    readonly approved: number;
    readonly rejected: number;
    readonly total: number;
  }[];
  readonly direct: number;
  readonly delegated: number;
  readonly levels:
    | readonly { policy: string; level: string; decided: number; averageHours: number }[]
    | null;
  readonly bottlenecks:
    | readonly { user: number; name: string; late: number; waiting: number }[]
    | null;
}

export function Matrix({ api, label }: PageProps): ReactElement {
  const { t } = useTranslation('approvals');
  const id = useId();
  const [period, setPeriod] = useState<Period>('3m');
  const [mode, setMode] = useState<Mode>('direct');
  const data = useQuery({
    queryKey: ['approvals', 'matrix', period, mode],
    queryFn: () =>
      api.call<Matrix>('GET', `/api/v1/approvals/matrix?period=${period}&mode=${mode}`),
  });
  const m = data.data;
  return (
    <div className="grid gap-4 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">{label ?? t('matrix.title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label={t('matrix.mode')}
            className="flex rounded-md border p-0.5"
          >
            {(['direct', 'delegated'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={mode === k}
                className={`rounded px-3 py-1 text-sm ${mode === k ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'}`}
                onClick={() => setMode(k)}
              >
                {t(`matrix.${k}`)}
                <Badge tone="neutral" className="ms-2">
                  {k === 'direct' ? (m?.direct ?? 0) : (m?.delegated ?? 0)}
                </Badge>
              </button>
            ))}
          </div>
          <Select
            id={`${id}-period`}
            label={t('matrix.period')}
            value={period}
            options={PERIODS.map((p) => ({ value: p, label: t(`matrix.periods.${p}`) }))}
            onChange={(v) => setPeriod(v as Period)}
          />
        </div>
      </header>

      {m === undefined ? (
        <EmptyState title={t('loading')} />
      ) : m.cards.length === 0 ? (
        <EmptyState title={t('matrix.empty')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {m.cards.map((c) => (
            <li key={String(c.policy)}>
              <Card className="grid gap-3 p-4">
                <h2 className="font-medium">{c.title}</h2>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('matrix.waiting')}</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {c.waiting > 0 ? (
                        <a
                          className="text-primary underline-offset-4 hover:underline"
                          href="/approvals/a/approvals.action_inbox"
                        >
                          {c.waiting}
                        </a>
                      ) : (
                        0
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('matrix.approved')}</dt>
                    <dd className="text-lg font-semibold tabular-nums text-success">
                      {c.approved}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('matrix.rejected')}</dt>
                    <dd className="text-lg font-semibold tabular-nums text-danger">{c.rejected}</dd>
                  </div>
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {m?.levels === null || m?.levels === undefined || m.levels.length === 0 ? null : (
        <section aria-labelledby={`${id}-levels`} className="grid gap-2">
          <h2 id={`${id}-levels`} className="font-semibold">
            {t('matrix.levels')}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-2 py-1 text-start">{t('matrix.policy')}</th>
                  <th className="px-2 py-1 text-start">{t('matrix.level')}</th>
                  <th className="px-2 py-1 text-end">{t('matrix.decided')}</th>
                  <th className="px-2 py-1 text-end">{t('matrix.hours')}</th>
                </tr>
              </thead>
              <tbody>
                {m.levels.map((l) => (
                  <tr key={`${l.policy}-${l.level}`} className="border-b">
                    <td className="px-2 py-1">{l.policy}</td>
                    <td className="px-2 py-1">{l.level}</td>
                    <td className="px-2 py-1 text-end tabular-nums">{l.decided}</td>
                    <td className="px-2 py-1 text-end tabular-nums">{l.averageHours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {m?.bottlenecks === null ||
      m?.bottlenecks === undefined ||
      m.bottlenecks.length === 0 ? null : (
        <section aria-labelledby={`${id}-late`} className="grid gap-2">
          <h2 id={`${id}-late`} className="font-semibold">
            {t('matrix.bottlenecks')}
          </h2>
          <ul className="grid gap-1 text-sm">
            {m.bottlenecks.map((b) => (
              <li key={b.user} className="flex items-center justify-between gap-2 border-b py-1">
                <span>{b.name}</span>
                <span className="flex gap-2">
                  {b.late > 0 ? (
                    <Badge tone="danger">{t('matrix.late', { count: b.late })}</Badge>
                  ) : null}
                  <Badge tone="neutral">{t('matrix.waitingCount', { count: b.waiting })}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
