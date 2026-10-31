/**
 * An app's overview page (RFC 0022 §3.2): the cards its manifest declared — KPIs with their change against the
 * previous period, charts, small pivots, top records — opened by the app's first menu. The cards come from the
 * overview route; each one queries the reports as the user (their rights and record rules apply), and a chart point
 * or a pivot row opens the records behind it. Read-only: the layout belongs to the app (personal layouts: step 3).
 */

import { Alert, Button, type PageProps, Spinner, useKosh } from '@kosh/ui';
import type { Condition } from '@kosh/views';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Card, CardFrame, Records } from './DashboardView.js';

export function Overview({ app }: PageProps): ReactElement {
  const { api, uid } = useKosh();
  const { t } = useTranslation('reporting');
  const [drill, setDrill] = useState<{ model: string; domain: Condition } | null>(null);
  // RFC 0022 step 3: the cards a person hid, kept in their browser (like a list's columns).
  const hiddenKey = `kosh.overview.${uid}.${app ?? ''}`;
  const [hidden, setHidden] = useState<readonly string[]>(() => {
    try {
      const raw = localStorage.getItem(hiddenKey);
      return raw === null ? [] : (JSON.parse(raw) as string[]);
    } catch {
      return [];
    }
  });
  const [editing, setEditing] = useState(false);
  const hide = (ids: readonly string[]): void => {
    setHidden(ids);
    try {
      localStorage.setItem(hiddenKey, JSON.stringify(ids));
    } catch {
      // storage unavailable: the choice lasts for the page
    }
  };
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
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{`${overview.data.label} · ${t('overview')}`}</h2>
        <div className="ms-auto flex items-center gap-2">
          {hidden.length === 0 ? null : (
            <Button size="sm" variant="ghost" onClick={() => hide([])}>
              {t('showAllCards', { count: hidden.length })}
            </Button>
          )}
          <Button size="sm" onClick={() => setEditing((e) => !e)}>
            {editing ? t('done') : t('customise')}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-12 gap-3">
        {overview.data.cards
          .filter((card) => editing || !hidden.includes(card.id))
          .map((card) => (
            <CardFrame
              key={card.id}
              card={card}
              editing={editing && !hidden.includes(card.id)}
              onRemove={() => hide([...hidden, card.id])}
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
