/**
 * The search bar (RFC 0004 §5): text facets with suggestions per search field, filters, group-by, and favorites
 * (saved searches, private or shared, stored as `kosh.saved_view` records). It edits a `@kosh/search` state; the
 * views compile it, so a search means the same in every view.
 */
import {
  addFacet,
  isEmpty,
  removeFacet,
  type SearchState,
  suggestions,
  toggle,
} from '@kosh/search';
import type { SearchSpec } from '@kosh/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Filter, Layers, Search, Star, X } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Checkbox,
  Dialog,
  Input,
  Label,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from '../components/primitives.js';
import { useKosh } from '../context.js';

export interface SearchBarProps {
  readonly model: string;
  readonly viewType: string;
  readonly spec: SearchSpec;
  readonly state: SearchState;
  readonly onChange: (state: SearchState) => void;
  /** Labels of search fields and group-by options (`company.name` → `Company`). */
  readonly labels: Readonly<Record<string, string>>;
}

export function SearchBar({
  model,
  viewType,
  spec,
  state,
  onChange,
  labels,
}: SearchBarProps): ReactElement {
  const { t } = useTranslation();
  const { api, registry } = useKosh();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const listId = useId();
  const options = suggestions(spec, text);
  const label = (key: string) => labels[key] ?? key;

  const favorites = useQuery({
    queryKey: ['saved-views', model],
    queryFn: () =>
      api.list('kosh.saved_view', {
        filter: { targetModel: model },
        fields: ['name', 'state', 'shared', 'viewType'],
      }),
  });
  const save = useMutation({
    mutationFn: () =>
      api.create('kosh.saved_view', { name, targetModel: model, viewType, state, shared }),
    onSuccess: async () => {
      setSaving(false);
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['saved-views', model] });
    },
  });

  const add = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    onChange(addFacet(state, option.field, option.value));
    setText('');
    setActive(0);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(active);
    } else if (e.key === 'Escape') setText('');
    else if (e.key === 'Backspace' && text === '' && (state.facets ?? []).length > 0) {
      const last = (state.facets ?? [])[(state.facets ?? []).length - 1];
      if (last !== undefined) onChange(removeFacet(state, last.field));
    }
  };

  const filterGroups = new Map<string, [string, { label: string }][]>();
  for (const [key, filter] of Object.entries(spec.filters ?? {}))
    filterGroups.set(filter.group ?? key, [
      ...(filterGroups.get(filter.group ?? key) ?? []),
      [key, filter],
    ]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex min-w-64 flex-1 flex-wrap items-center gap-1 rounded-md border border-input bg-surface px-2 py-1">
        <Search className="size-4 text-muted-foreground" aria-hidden />
        {(state.facets ?? []).map((facet) => {
          const description = `${label(facet.field)}: ${facet.values.join(` ${t('search.or')} `)}`;
          return (
            <span
              key={facet.field}
              className="inline-flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-xs text-accent-foreground"
            >
              {description}
              <button
                type="button"
                aria-label={t('search.remove', { facet: description })}
                onClick={() => onChange(removeFacet(state, facet.field))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          );
        })}
        {(state.filters ?? []).map((key) => (
          <span
            key={key}
            className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
          >
            {spec.filters?.[key]?.label ?? key}
            <button
              type="button"
              aria-label={t('search.remove', { facet: spec.filters?.[key]?.label ?? key })}
              onClick={() => onChange({ ...state, filters: toggle(state.filters, key) })}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        {(state.groupBy ?? []).map((key) => (
          <span
            key={key}
            className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
          >
            <Layers className="size-3" aria-hidden />
            {label(key)}
            <button
              type="button"
              aria-label={t('search.remove', { facet: label(key) })}
              onClick={() => onChange({ ...state, groupBy: toggle(state.groupBy, key) })}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        {state.custom === undefined || Object.keys(state.custom).length === 0 ? null : (
          <span className="inline-flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-xs text-accent-foreground">
            {state.customLabel ?? t('search.custom')}
            <button
              type="button"
              aria-label={t('search.remove', { facet: state.customLabel ?? t('search.custom') })}
              onClick={() => {
                const { custom: _custom, customLabel: _label, ...rest } = state;
                onChange(rest);
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        )}
        <input
          data-kosh-search
          role="combobox"
          aria-label={t('search.placeholder')}
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-activedescendant={options.length > 0 ? `${listId}-${active}` : undefined}
          className="h-7 min-w-24 flex-1 bg-transparent text-sm outline-none"
          placeholder={isEmpty(state) ? t('search.placeholder') : ''}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {options.length > 0 ? (
          <div
            id={listId}
            role="listbox"
            className="absolute start-0 top-full z-40 mt-1 w-full rounded-md border bg-surface p-1 shadow-lg"
          >
            {options.map((o, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: combobox pattern: the input keeps focus, aria-activedescendant points at the option
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input
              <div
                key={o.field}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`cursor-default rounded-sm px-2 py-1.5 text-sm ${i === active ? 'bg-muted' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(i)}
              >
                {t('search.searchFor', { field: label(o.field), value: o.value })}
              </div>
            ))}
          </div>
        ) : null}
        {isEmpty(state) ? null : (
          <Button variant="ghost" size="sm" onClick={() => onChange({})}>
            {t('search.clear')}
          </Button>
        )}
      </div>

      {registry.searchAssists().map((Assist, i) => (
        <Assist
          // biome-ignore lint/suspicious/noArrayIndexKey: registered once at start, never reordered
          key={i}
          api={api}
          model={model}
          onDomain={(where, text) => onChange({ ...state, custom: where, customLabel: text })}
        />
      ))}
      {filterGroups.size === 0 ? null : (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm">
              <Filter aria-hidden />
              {t('search.filters')}
            </Button>
          </MenuTrigger>
          <MenuContent>
            {[...filterGroups.values()].map((group, i) => (
              <div key={group[0]?.[0] ?? i}>
                {i > 0 ? <MenuSeparator /> : null}
                {group.map(([key, filter]) => (
                  <MenuCheckboxItem
                    key={key}
                    checked={(state.filters ?? []).includes(key)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() =>
                      onChange({ ...state, filters: toggle(state.filters, key) })
                    }
                  >
                    {filter.label}
                  </MenuCheckboxItem>
                ))}
              </div>
            ))}
          </MenuContent>
        </Menu>
      )}

      {(spec.groupBy ?? []).length === 0 ? null : (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm">
              <Layers aria-hidden />
              {t('search.groupBy')}
            </Button>
          </MenuTrigger>
          <MenuContent>
            {(spec.groupBy ?? []).map((key) => (
              <MenuCheckboxItem
                key={key}
                checked={(state.groupBy ?? []).includes(key)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => onChange({ ...state, groupBy: toggle(state.groupBy, key) })}
              >
                {label(key)}
              </MenuCheckboxItem>
            ))}
          </MenuContent>
        </Menu>
      )}

      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" aria-label={t('search.favorites')}>
            <Star aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>{t('search.favorites')}</MenuLabel>
          {(favorites.data?.items ?? []).map((saved) => (
            <MenuItem
              key={saved.id}
              onSelect={() => onChange((saved['state'] as SearchState | null) ?? {})}
            >
              {String(saved['name'])}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => setSaving(true)}>{t('search.saveCurrent')}</MenuItem>
        </MenuContent>
      </Menu>

      <Dialog
        open={saving}
        onOpenChange={setSaving}
        title={t('search.saveCurrent')}
        footer={
          <>
            <Button onClick={() => setSaving(false)}>{t('views.discard')}</Button>
            <Button
              variant="primary"
              busy={save.isPending}
              disabled={name.trim() === ''}
              onClick={() => save.mutate()}
            >
              {t('views.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`${listId}-name`}>{t('search.name')}</Label>
            <Input id={`${listId}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${listId}-share`}
              checked={shared}
              onCheckedChange={(c) => setShared(c === true)}
            />
            <Label htmlFor={`${listId}-share`}>{t('search.share')}</Label>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
