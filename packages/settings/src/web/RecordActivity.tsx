/**
 * Settings › Audit log › Records: what was created, changed (the field, the old and the new value) and deleted on
 * every business record, newest first — also the records that are gone, which have no page left to show their
 * history on. Read from the audit trail (`GET /api/v1/admin/activity`); filtered by what was done, the kind of
 * record, and the page's person and period.
 */
import {
  Alert,
  ApiError,
  Badge,
  Button,
  Input,
  Label,
  type PageProps,
  Select,
  useKosh,
} from '@kosh/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Activity {
  readonly id: number;
  readonly at: string;
  readonly actorName: string | null;
  readonly action: 'create' | 'write' | 'unlink';
  readonly model: string;
  readonly modelLabel: string;
  readonly record: number;
  readonly recordName: string | null;
  readonly field: string | null;
  readonly fieldLabel: string | null;
  readonly old: unknown;
  readonly new: unknown;
}

const PAGE = 50;
const ACTIONS = ['create', 'write', 'unlink'] as const;
const TONE = { create: 'success', write: 'info', unlink: 'warning' } as const;
const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

/** A logged value in words: money with its currency, nothing as a dash, anything else as it is. */
function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') {
    const money = value as { amount?: unknown; currency?: unknown };
    if (money.amount !== undefined)
      return `${String(money.amount)} ${String(money.currency ?? '')}`.trim();
    return JSON.stringify(value);
  }
  return String(value);
}

export function RecordActivity({
  api,
  actor,
  from,
  to,
}: Pick<PageProps, 'api'> & {
  /** The page's filters: a user id or `all`, and ISO days or nothing. */
  readonly actor: string;
  readonly from: string;
  readonly to: string;
}): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const id = useId();
  const [action, setAction] = useState('all');
  const [model, setModel] = useState('');
  const filters = new URLSearchParams();
  if (action !== 'all') filters.set('action', action);
  if (model.trim() !== '') filters.set('model', model.trim());
  if (actor !== 'all') filters.set('actor', actor);
  if (from !== '') filters.set('from', from);
  if (to !== '') filters.set('to', to);
  const query = filters.toString();
  const rows = useInfiniteQuery({
    queryKey: ['settings', 'activity', query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.call<{ activity: Activity[] }>(
        'GET',
        `/api/v1/admin/activity?${query}${query === '' ? '' : '&'}limit=${PAGE}${pageParam === 0 ? '' : `&before=${pageParam}`}`,
      ),
    getNextPageParam: (last) =>
      last.activity.length < PAGE ? undefined : last.activity[last.activity.length - 1]?.id,
  });
  const list = rows.data?.pages.flatMap((p) => p.activity) ?? [];
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 rounded-lg border bg-surface p-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-action`}>{t('activity.action')}</Label>
          <Select
            id={`${id}-action`}
            label={t('activity.action')}
            value={action}
            options={[
              { value: 'all', label: t('activity.any') },
              ...ACTIONS.map((a) => ({ value: a, label: t(`activity.actions.${a}`) })),
            ]}
            onChange={setAction}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-model`}>{t('activity.model')}</Label>
          <Input
            id={`${id}-model`}
            type="search"
            placeholder="sale.order"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      </div>
      {rows.error === null ? null : <Alert tone="danger">{message(rows.error)}</Alert>}
      <div className="overflow-x-auto rounded-lg border bg-surface">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('activity.title')}</caption>
          <thead className="border-b bg-muted/40 text-start text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('audit.when')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('audit.person')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('activity.record')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('audit.what')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {format.datetime(r.at)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{r.actorName ?? t('audit.system')}</td>
                <td className="px-3 py-2">
                  <span>{r.recordName ?? r.modelLabel}</span>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {r.model} #{r.record}
                  </p>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TONE[r.action]}>{t(`activity.actions.${r.action}`)}</Badge>
                    {r.field === null ? null : (
                      <span>
                        <span className="font-medium">{r.fieldLabel}</span>
                        {': '}
                        <span className="text-muted-foreground line-through">{shown(r.old)}</span>
                        {' → '}
                        <span>{shown(r.new)}</span>
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.data !== undefined && list.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  {t('activity.none')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {rows.hasNextPage ? (
        <div className="flex justify-center">
          <Button busy={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>
            {t('audit.more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
