/**
 * The vendor's scorecard on their contact (RFC 0030 §3.1): on-time receipts, average lead days and the price trend
 * of what is bought most, over the last year. Shown to Purchase users for vendors with orders; the server computes.
 */
import type { NodeComponentProps } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useId } from 'react';
import { useTranslation } from 'react-i18next';

interface Scorecard {
  readonly orders: number;
  readonly receipts: number;
  readonly onTime: number;
  readonly onTimeRate: number | null;
  readonly averageLeadDays: number | null;
  readonly products: readonly {
    readonly name: string;
    readonly lastPrice: string;
    readonly averagePrice: string;
    readonly change: number;
  }[];
}

export function VendorScorecard({ record, api }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('purchase_stock');
  const id = useId();
  const card = useQuery({
    queryKey: ['purchase', 'scorecard', record?.id],
    queryFn: () => api.call<Scorecard>('GET', `/api/v1/purchase/vendors/${record?.id}/scorecard`),
    enabled: record !== null && record['isVendor'] === true,
    retry: false,
  });
  const c = card.data;
  if (c === undefined || c.orders === 0) return null;
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2 rounded-md border p-3 text-sm">
      <h3 id={`${id}-title`} className="font-medium">
        {t('scorecard.title')}
      </h3>
      <dl className="grid grid-cols-3 gap-2">
        <div>
          <dt className="text-muted-foreground">{t('scorecard.onTime')}</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {c.onTimeRate === null ? '—' : `${c.onTimeRate}%`}
          </dd>
          <dd className="text-xs text-muted-foreground">
            {t('scorecard.receipts', { onTime: c.onTime, count: c.receipts })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('scorecard.lead')}</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {c.averageLeadDays === null ? '—' : t('scorecard.days', { count: c.averageLeadDays })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('scorecard.orders')}</dt>
          <dd className="text-lg font-semibold tabular-nums">{c.orders}</dd>
        </div>
      </dl>
      {c.products.length === 0 ? null : (
        <ul className="grid gap-0.5">
          {c.products.map((p) => (
            <li key={p.name} className="flex justify-between gap-2">
              <span className="truncate">{p.name}</span>
              <span className="tabular-nums">
                {t('scorecard.price', {
                  last: p.lastPrice,
                  average: p.averagePrice,
                  change: `${p.change > 0 ? '+' : ''}${p.change}`,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
