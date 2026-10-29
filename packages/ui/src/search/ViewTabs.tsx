/**
 * Saved views as tabs (RFC 0018 §4.3): above the search, *All* and the saved searches of this model and view type —
 * the user's own and the shared ones —, the one matching the current search marked. A tab applies its search; more
 * than a handful go into a *More* menu. Saving and the full list stay in the search bar's favorites menu; with
 * nothing saved, there are no tabs.
 */
import { encodeSearch, type SearchState } from '@kosh/search';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Users } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from '../components/primitives.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';

/** Tabs shown before the rest go into *More*. */
const VISIBLE = 6;

/** The search without its order: a tab matches whatever the columns are sorted by. */
const key = (state: SearchState) => encodeSearch({ ...state, order: [] });

export function ViewTabs({
  model,
  viewType,
  state,
  onChange,
}: {
  readonly model: string;
  readonly viewType: string;
  readonly state: SearchState;
  readonly onChange: (state: SearchState) => void;
}): ReactElement | null {
  const { api } = useKosh();
  const { t } = useTranslation();
  // The search bar's favorites query: one request, one cache.
  const favorites = useQuery({
    queryKey: ['saved-views', model],
    queryFn: () =>
      api.list('kosh.saved_view', {
        filter: { targetModel: model },
        fields: ['name', 'state', 'shared', 'viewType'],
      }),
  });
  const views = (favorites.data?.items ?? []).filter(
    (v) => v['viewType'] === viewType || v['viewType'] === null,
  );
  if (views.length === 0) return null;
  const current = key(state);
  const stateOf = (v: (typeof views)[number]) => (v['state'] as SearchState | null) ?? {};
  const active = views.find((v) => key(stateOf(v)) === current);
  const tab = (label: string, selected: boolean, apply: () => void, shared = false) => (
    <Button
      size="sm"
      variant="ghost"
      aria-current={selected ? 'true' : undefined}
      onClick={apply}
      className={cn(
        'h-8 rounded-none border-b-2 border-transparent px-3 text-muted-foreground hover:text-foreground',
        selected && 'border-primary font-medium text-foreground',
      )}
    >
      {label}
      {shared ? <Users className="size-3.5 opacity-60" aria-label={t('search.shared')} /> : null}
    </Button>
  );
  const shown = views.slice(0, VISIBLE);
  const more = views.slice(VISIBLE);
  return (
    <nav aria-label={t('search.savedViews')} className="-mb-1 flex items-end gap-1 border-b">
      {tab(t('search.allRecords'), current === '' && active === undefined, () => onChange({}))}
      {shown.map((v) => (
        <span key={v.id} className="contents">
          {tab(String(v['name']), v === active, () => onChange(stateOf(v)), v['shared'] === true)}
        </span>
      ))}
      {more.length === 0 ? null : (
        <Menu>
          <MenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                'h-8 rounded-none border-b-2 border-transparent px-3 text-muted-foreground',
                active !== undefined && more.includes(active) && 'border-primary text-foreground',
              )}
            >
              {active !== undefined && more.includes(active)
                ? String(active['name'])
                : t('search.moreViews', { count: more.length })}
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
          </MenuTrigger>
          <MenuContent align="start">
            {more.map((v) => (
              <MenuItem key={v.id} onSelect={() => onChange(stateOf(v))}>
                {String(v['name'])}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </nav>
  );
}
