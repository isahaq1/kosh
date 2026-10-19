/**
 * The hierarchy view: a tree of records through their parent field (org charts, category trees). Roots are the
 * records of the search without a parent; children load when a node opens. ARIA tree pattern: arrow keys move and
 * open / close, Enter opens the record.
 */
import { Alert, Spinner, useKosh, type ViewProps } from '@isahaq/kosh-ui';
import type { Condition, HierarchyView as HierarchyDefinition } from '@isahaq/kosh-views';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Dot } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { and } from './shared.js';

function Level({
  props,
  where,
  depth,
}: {
  readonly props: ViewProps;
  readonly where: Condition | undefined;
  readonly depth: number;
}): ReactElement | null {
  const { api } = useKosh();
  const view = props.served.view as HierarchyDefinition;
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const keys = [
    ...new Set([
      'id',
      view.title,
      view.parent,
      ...(view.subtitle === undefined ? [] : [view.subtitle]),
    ]),
  ];
  const nodes = useQuery({
    queryKey: ['list', view.model, where, keys, 'hierarchy'],
    queryFn: () =>
      api.list(view.model, {
        filter: where,
        fields: keys,
        limit: 500,
        order: [`${view.title} asc`],
      }),
  });
  const ids = (nodes.data?.items ?? []).map((n) => n.id);
  // Which nodes have children (one aggregate for the level).
  const counts = useQuery({
    queryKey: ['children', view.model, ids],
    queryFn: () =>
      api.aggregate(view.model, {
        where: { [view.parent]: { in: ids } },
        groupBy: [view.parent],
        measures: { n: 'count' },
      }),
    enabled: ids.length > 0,
  });
  if (nodes.isError) return <Alert>{nodes.error.message}</Alert>;
  if (nodes.isPending) return <Spinner label="…" />;
  const hasChildren = new Set((counts.data ?? []).map((c) => Number(c[view.parent])));
  const toggle = (id: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const onKey = (e: KeyboardEvent<HTMLElement>, id: number) => {
    const item = e.currentTarget;
    const items = [
      ...(item.closest('[role=tree]')?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? []),
    ];
    const index = items.indexOf(item);
    if (e.key === 'ArrowDown') items[index + 1]?.focus();
    else if (e.key === 'ArrowUp') items[index - 1]?.focus();
    else if (e.key === 'ArrowRight' && hasChildren.has(id) && !open.has(id)) toggle(id);
    else if (e.key === 'ArrowLeft' && open.has(id)) toggle(id);
    else if (e.key === 'Enter') props.onOpen(id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <ul
      role={depth === 0 ? 'tree' : 'group'}
      aria-label={depth === 0 ? (view.label ?? view.model) : undefined}
      className={depth === 0 ? 'grid gap-1' : 'ms-6 grid gap-1 border-s ps-2'}
    >
      {(nodes.data?.items ?? []).map((n) => {
        const expandable = hasChildren.has(n.id);
        const isOpen = open.has(n.id);
        return (
          <li
            key={n.id}
            role="treeitem"
            tabIndex={0}
            aria-expanded={expandable ? isOpen : undefined}
            aria-level={depth + 1}
            className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={(e) => onKey(e, n.id)}
          >
            <div className="flex items-center gap-1 py-0.5">
              {expandable ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="rounded p-0.5 hover:bg-muted"
                  onClick={() => toggle(n.id)}
                >
                  {isOpen ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4 rtl:-scale-x-100" />
                  )}
                </button>
              ) : (
                <Dot className="size-5 text-muted-foreground" aria-hidden />
              )}
              <button
                type="button"
                tabIndex={-1}
                className="text-start text-sm font-medium hover:underline"
                onClick={() => props.onOpen(n.id)}
              >
                {String(n[view.title] ?? n.id)}
              </button>
              {view.subtitle === undefined || n[view.subtitle] == null ? null : (
                <span className="text-xs text-muted-foreground">{String(n[view.subtitle])}</span>
              )}
            </div>
            {isOpen ? (
              <Level props={props} where={{ [view.parent]: n.id }} depth={depth + 1} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function HierarchyView(props: ViewProps): ReactElement {
  const { t } = useTranslation('reporting');
  const view = props.served.view as HierarchyDefinition;
  return (
    <div className="rounded-lg border bg-surface p-3">
      <p className="sr-only">{t('expand')}</p>
      <Level props={props} where={and(props.where, { [view.parent]: null })} depth={0} />
    </div>
  );
}
