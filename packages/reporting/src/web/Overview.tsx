/**
 * An app's overview page (RFC 0022 §3.2): the cards its manifest declared — KPIs with their change against the
 * previous period, charts, small pivots, top records — opened by the app's first menu. The cards come from the
 * overview route; each one queries the reports as the user (their rights and record rules apply), and a chart point
 * or a pivot row opens the records behind it. Read-only: the layout belongs to the app (personal layouts: step 3).
 */

import { Alert, type PageProps, Spinner, useKosh } from '@kosh/ui';
import type { Condition } from '@kosh/views';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Card, CardFrame, Records } from './DashboardView.js';

export function Overview({ app }: PageProps): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation('reporting');
  const [drill, setDrill] = useState<{ model: string; domain: Condition } | null>(null);
  const overview = useQuery({
    queryKey: ['overview', app],
    queryFn: () =>
      api.call<{ label: string; cards: Card[] }>(
        'GET',
        `/api/v1/reports/overview?app=${encodeURIComponent(app ?? '')}`,
      ),
    enabled: app !== undefined,
  });
  if (overview.isError) return <Alert>{overview.error.message}</Alert>;
  if (overview.data === undefined) return <Spinner label={t('overview')} />;
  return (
    <div className="grid gap-3">
      <h2 className="text-base font-semibold">{`${overview.data.label} · ${t('overview')}`}</h2>
      <div className="grid grid-cols-12 gap-3">
        {overview.data.cards.map((card) => (
          <CardFrame
            key={card.id}
            card={card}
            editing={false}
            onRemove={() => undefined}
            onDrill={(domain) =>
              setDrill({
                model: card.model,
                domain: card.filter === undefined ? domain : { and: [card.filter, domain] },
              })
            }
          />
        ))}
      </div>
      {drill === null ? null : (
        <Records model={drill.model} domain={drill.domain} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
