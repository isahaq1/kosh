/**
 * On a draft landed cost (RFC 0030 §3.3): each receipt line's share of the costs, what goes to the stock on hand and
 * what to the cost of goods sold, before posting. The server splits; this shows it, or why it cannot yet.
 */
import { ApiError, type NodeComponentProps } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useId } from 'react';
import { useTranslation } from 'react-i18next';

interface Share {
  readonly move: number;
  readonly picking: string;
  readonly product: string;
  readonly quantity: string;
  readonly value: string;
  readonly added: string;
  readonly toStock: string;
  readonly toCogs: string;
}

export function LandedPreview({ record, api, version }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('stock_account');
  const id = useId();
  const draft = record !== null && record['state'] === 'draft';
  const preview = useQuery({
    queryKey: ['stock_account', 'landed-preview', record?.id, version],
    queryFn: () =>
      api.call<{ lines: Share[] }>('GET', `/api/v1/stockroom/landed-costs/${record?.id}/preview`),
    enabled: draft,
    retry: false,
  });
  if (!draft) return null;
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2 rounded-md border p-3 text-sm">
      <h3 id={`${id}-title`} className="font-medium">
        {t('landed.title')}
      </h3>
      {preview.error !== null ? (
        <p className="text-muted-foreground">
          {preview.error instanceof ApiError ? preview.error.message : String(preview.error)}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-start font-medium">{t('landed.receipt')}</th>
                <th className="py-1 text-start font-medium">{t('landed.product')}</th>
                <th className="py-1 text-end font-medium">{t('landed.quantity')}</th>
                <th className="py-1 text-end font-medium">{t('landed.value')}</th>
                <th className="py-1 text-end font-medium">{t('landed.added')}</th>
                <th className="py-1 text-end font-medium">{t('landed.toStock')}</th>
                <th className="py-1 text-end font-medium">{t('landed.toCogs')}</th>
              </tr>
            </thead>
            <tbody>
              {(preview.data?.lines ?? []).map((l) => (
                <tr key={l.move} className="border-t">
                  <td className="py-1">{l.picking}</td>
                  <td className="py-1">{l.product}</td>
                  <td className="py-1 text-end tabular-nums">{l.quantity}</td>
                  <td className="py-1 text-end tabular-nums">{l.value}</td>
                  <td className="py-1 text-end tabular-nums font-medium">{l.added}</td>
                  <td className="py-1 text-end tabular-nums">{l.toStock}</td>
                  <td className="py-1 text-end tabular-nums">{l.toCogs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
