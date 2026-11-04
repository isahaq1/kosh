/** What I decided (RFC 0025 §3.1): each decision with the record, my answer, my comment and when. */
import { Badge, EmptyState, type PageProps, useKosh } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { cardsQuery, TONE } from './shared.js';

export function History({ api }: PageProps): ReactElement {
  const { t } = useTranslation('approvals');
  const { format } = useKosh();
  const cards = useQuery(cardsQuery(api, 'history'));
  const rows = cards.data ?? [];
  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('history.title')}</h1>
      {rows.length === 0 ? (
        <EmptyState title={cards.isLoading ? t('loading') : t('history.empty')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-2 py-1 text-start">{t('history.record')}</th>
                <th className="px-2 py-1 text-start">{t('history.level')}</th>
                <th className="px-2 py-1 text-start">{t('history.answer')}</th>
                <th className="px-2 py-1 text-start">{t('history.comment')}</th>
                <th className="px-2 py-1 text-start">{t('history.when')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b">
                  <td className="px-2 py-1">
                    <span className="font-medium">{c.record.name}</span>{' '}
                    <span className="text-muted-foreground">{c.record.label}</span>
                  </td>
                  <td className="px-2 py-1">{c.levelName}</td>
                  <td className="px-2 py-1">
                    <Badge tone={TONE[c.state]}>{t(`state.${c.state}`)}</Badge>
                  </td>
                  <td className="px-2 py-1">{c.comment ?? ''}</td>
                  <td className="px-2 py-1">
                    {c.decidedAt === null ? '' : format.datetime(c.decidedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
