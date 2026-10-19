/**
 * The map view (MapLibre, loaded on demand): records with coordinates as markers, fitted to their bounds, a popup
 * per marker that opens the record. The same records are listed for keyboard and screen-reader users. The map
 * style comes from the view (`style`) or the distribution's default.
 */
import { Alert, Button, Spinner, useKosh, type ViewProps } from '@isahaq/kosh-ui';
import type { MapView as MapDefinition } from '@isahaq/kosh-views';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { and } from './shared.js';

/** The default map style (a free MapLibre demo style; distributions set their own tiles). */
export const DEFAULT_MAP_STYLE = 'https://demotiles.maplibre.org/style.json';

interface MapLike {
  remove(): void;
  fitBounds(bounds: [[number, number], [number, number]], options: unknown): void;
  on(event: string, fn: () => void): void;
}

export function MapView(props: ViewProps): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation('reporting');
  const view = props.served.view as MapDefinition;
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const where = and(
    props.where,
    { [view.latitude]: { isNull: false } },
    { [view.longitude]: { isNull: false } },
  );
  const keys = [
    ...new Set([
      'id',
      view.latitude,
      view.longitude,
      view.title,
      ...(view.subtitle === undefined ? [] : [view.subtitle]),
    ]),
  ];
  const records = useQuery({
    queryKey: ['list', view.model, where, keys, 'map'],
    queryFn: () => api.list(view.model, { filter: where, fields: keys, limit: 1000 }),
  });
  const items = (records.data?.items ?? []).filter(
    (r) => Number.isFinite(Number(r[view.latitude])) && Number.isFinite(Number(r[view.longitude])),
  );

  const loaded = JSON.stringify(items.map((r) => [r.id, r[view.latitude], r[view.longitude]]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the map is rebuilt when the located records change
  useEffect(() => {
    if (element.current === null || records.data === undefined) return;
    let map: MapLike | undefined;
    let cancelled = false;
    void Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl.css' as string).catch(() => undefined),
    ])
      .then(([maplibre]) => {
        if (cancelled || element.current === null) return;
        const instance = new maplibre.Map({
          container: element.current,
          style: view.style ?? DEFAULT_MAP_STYLE,
          center: [90.4, 23.8],
          zoom: 4,
          attributionControl: { compact: true },
        });
        map = instance as unknown as MapLike;
        for (const r of items) {
          const popup = new maplibre.Popup({ offset: 16 });
          const content = document.createElement('div');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'font-medium underline';
          button.textContent = String(r[view.title] ?? r.id);
          button.addEventListener('click', () => props.onOpen(r.id));
          content.append(button);
          if (view.subtitle !== undefined && r[view.subtitle] != null) {
            const sub = document.createElement('div');
            sub.textContent = String(r[view.subtitle]);
            content.append(sub);
          }
          popup.setDOMContent(content);
          new maplibre.Marker()
            .setLngLat([Number(r[view.longitude]), Number(r[view.latitude])])
            .setPopup(popup)
            .addTo(instance);
        }
        if (items.length > 0) {
          const lng = items.map((r) => Number(r[view.longitude]));
          const lat = items.map((r) => Number(r[view.latitude]));
          map.fitBounds(
            [
              [Math.min(...lng), Math.min(...lat)],
              [Math.max(...lng), Math.max(...lat)],
            ],
            { padding: 48, maxZoom: 12, duration: 0 },
          );
        }
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [loaded, view.style]);

  if (records.isError) return <Alert>{records.error.message}</Alert>;
  if (records.isPending) return <Spinner label="…" />;
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_18rem]">
      {failed === null ? (
        <section
          ref={element}
          className="h-[480px] overflow-hidden rounded-lg border"
          aria-label={view.label ?? view.model}
        />
      ) : (
        <Alert>{failed}</Alert>
      )}
      <section aria-labelledby="map-locations" className="rounded-lg border bg-surface p-3">
        <h2 id="map-locations" className="mb-2 text-sm font-semibold">
          {t('locations')}
        </h2>
        <ul className="grid max-h-[440px] gap-1 overflow-auto text-sm">
          {items.map((r) => (
            <li key={r.id}>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => props.onOpen(r.id)}
              >
                {String(r[view.title] ?? r.id)}
              </Button>
              <span className="ms-1 text-xs text-muted-foreground tabular-nums">
                {Number(r[view.latitude]).toFixed(3)}, {Number(r[view.longitude]).toFixed(3)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{t('noLocation')}</p>
      </section>
    </div>
  );
}
