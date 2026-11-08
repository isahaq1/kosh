/**
 * Stockroom › My operations (RFC 0032 §3.3): a card per warehouse and kind of transfer — receipts, deliveries,
 * internal moves — with what is ready, waiting and late. The server counts (`GET /api/v1/stockroom/operations`);
 * each count opens the transfers it counts.
 */
import { Alert, type PageProps } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface Count {
  readonly count: number;
  readonly domain: Readonly<Record<string, unknown>>;
}
interface Operation {
  readonly warehouse: { readonly id: number; readonly name: string };
  readonly kind: 'receipt' | 'delivery' | 'internal';
  readonly action: string;
  readonly ready: Count;
  readonly waiting: Count;
  readonly late: Count;
}

/** A link to an action's list filtered by `domain`, labelled in its search bar. */
function hrefOf(app: string, action: string, domain: object, label: string): string {
  const q = JSON.stringify({ c: domain, cl: label });
  // The router reads search values as JSON: a string is quoted.
  return `/${app}/a/${action}?q=${encodeURIComponent(JSON.stringify(q))}`;
}

export function Operations({ api, app = 'stockroom' }: PageProps): ReactElement {
  const { t } = useTranslation('stock');
  const operations = useQuery({
    queryKey: ['stock', 'operations'],
    queryFn: () => api.call<{ operations: Operation[] }>('GET', '/api/v1/stockroom/operations'),
    refetchInterval: 60_000,
  });
  if (operations.isError) return <Alert tone="danger">{(operations.error as Error).message}</Alert>;
  const list = operations.data?.operations ?? [];
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('operations.hint')}</p>
      {operations.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('operations.loading')}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('operations.empty')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((o) => {
            const title = `${o.warehouse.name}: ${t(`operations.kind.${o.kind}`)}`;
            const link = (count: Count, which: 'ready' | 'waiting' | 'late') => (
              <a
                href={hrefOf(app, o.action, count.domain, `${title} · ${t(`operations.${which}`)}`)}
                className={
                  which === 'late' && count.count > 0
                    ? 'rounded-md border border-destructive/40 px-3 py-2 text-destructive hover:bg-destructive/10'
                    : 'rounded-md border px-3 py-2 hover:bg-accent'
                }
                aria-label={t(`operations.${which}Of`, { count: count.count, title })}
              >
                <span className="block text-2xl font-semibold tabular-nums">{count.count}</span>
                <span className="text-xs text-muted-foreground">{t(`operations.${which}`)}</span>
              </a>
            );
            return (
              <li key={`${o.warehouse.id}-${o.kind}`}>
                <section
                  aria-label={title}
                  className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
                >
                  <h2 className="font-medium">{title}</h2>
                  <div className="grid grid-cols-3 gap-2">
                    {link(o.ready, 'ready')}
                    {link(o.waiting, 'waiting')}
                    {link(o.late, 'late')}
                  </div>
                </section>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
