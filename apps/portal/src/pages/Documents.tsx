/** The portal's home (what needs the user) and a document type's list. */
import { Button, Card, EmptyState, Input, Skeleton } from '@kosh/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type DocumentList, type FieldMeta, type Row, usePortal } from '../portal.js';
import { Value } from '../Value.js';

const PAGE = 30;

/** Rows as a table on wide screens and as cards on phones; each opens its document. */
function Rows({
  type,
  fields,
  items,
}: {
  readonly type: string;
  readonly fields: readonly FieldMeta[];
  readonly items: readonly Row[];
}): ReactElement {
  const [first, ...rest] = fields;
  return (
    <>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-muted-foreground">
              {fields.map((f) => (
                <th key={f.key} className="px-2 py-2 text-start font-medium">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b last:border-0 hover:bg-muted/50">
                {fields.map((f, i) => (
                  <td key={f.key} className="px-2 py-2">
                    {i === 0 ? (
                      <Link
                        to="/d/$key/$id"
                        params={{ key: type, id: String(item.id) }}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        <Value field={f} value={item[f.key]} />
                      </Link>
                    ) : (
                      <Value field={f} value={item[f.key]} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="grid gap-2 sm:hidden">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              to="/d/$key/$id"
              params={{ key: type, id: String(item.id) }}
              className="grid gap-1 rounded-md border p-3"
            >
              {first === undefined ? null : (
                <span className="font-medium">
                  <Value field={first} value={item[first.key]} />
                </span>
              )}
              {rest.map((f) => (
                <span key={f.key} className="flex justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">{f.label}</span>
                  <Value field={f} value={item[f.key]} />
                </span>
              ))}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

interface Section extends DocumentList {}

export function Home(): ReactElement {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const home = useQuery({
    queryKey: ['portal', 'home'],
    queryFn: () => api.call<{ sections: Section[] }>('GET', '/api/portal/v1/home'),
  });
  if (home.data === undefined) return <Skeleton className="h-40" />;
  const sections = home.data.sections.filter((s) => s.count > 0);
  return (
    <>
      <h1 className="text-xl font-semibold">{t('attention')}</h1>
      {sections.length === 0 ? <EmptyState title={t('nothing')} /> : null}
      {sections.map((s) => (
        <Card key={s.key} className="grid gap-3 p-4">
          <h2 className="font-semibold">
            {s.label} <span className="text-muted-foreground">({s.count})</span>
          </h2>
          <Rows type={s.key} fields={s.fields} items={s.items} />
          <Link to="/d/$key" params={{ key: s.key }} className="text-sm text-primary">
            {t('seeAll', { label: s.label.toLowerCase() })}
          </Link>
        </Card>
      ))}
    </>
  );
}

export function Documents(): ReactElement {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const id = useId();
  const { key } = useParams({ strict: false }) as { readonly key: string };
  const [q, setQ] = useState('');
  const pages = useInfiniteQuery({
    queryKey: ['portal', 'list', key, q],
    queryFn: ({ pageParam }) =>
      api.call<DocumentList>(
        'GET',
        `/api/portal/v1/documents/${encodeURIComponent(key)}?limit=${PAGE}&offset=${pageParam}&q=${encodeURIComponent(q)}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.count ? loaded : undefined;
    },
  });
  const first = pages.data?.pages[0];
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">{first?.label ?? ''}</h1>
        <div className="grid gap-1">
          <label htmlFor={`${id}-q`} className="sr-only">
            {t('search')}
          </label>
          <Input
            id={`${id}-q`}
            type="search"
            placeholder={t('search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      {first === undefined ? (
        <Skeleton className="h-40" />
      ) : items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <Card className="grid gap-3 p-4">
          <p className="text-sm text-muted-foreground">{t('total', { count: first.count })}</p>
          <Rows type={key} fields={first.fields} items={items} />
          {pages.hasNextPage ? (
            <Button
              size="sm"
              className="justify-self-start"
              busy={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              {t('more')}
            </Button>
          ) : null}
        </Card>
      )}
    </>
  );
}
