/**
 * Settings › Audit log (RFC 0019 §3.5): every sign-in, permission change, export and sensitive action, newest first,
 * filtered by kind, person, period and words, with more on demand and the filtered events exported as CSV (the export
 * is itself logged). Administrators, and holders of the "View the audit log" permission.
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
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface AuditEvent {
  readonly id: number;
  readonly kind: string;
  readonly actorName: string | null;
  readonly summary: string;
  readonly targetModel: string | null;
  readonly targetId: number | null;
  readonly ip: string | null;
  readonly createdAt: string;
}

const PAGE = 50;
/** The families of events, by their kind's prefix. */
const FAMILIES = ['auth.', 'security.', 'people.', 'settings.', 'data.', 'admin.'] as const;
const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));
const tone = (kind: string) =>
  kind.endsWith('_failed') || kind.endsWith('_revoked')
    ? 'warning'
    : kind.startsWith('security.')
      ? 'info'
      : 'neutral';

function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AuditPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const id = useId();
  const [family, setFamily] = useState('all');
  const [actor, setActor] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [words, setWords] = useState('');
  const people = useQuery({
    queryKey: ['settings', 'people', 'all'],
    queryFn: () =>
      api.call<{ people: { id: number; name: string }[] }>('GET', '/api/v1/settings/people'),
  });
  const filters = new URLSearchParams();
  if (family !== 'all') filters.set('kind', family);
  if (actor !== 'all') filters.set('actor', actor);
  if (from !== '') filters.set('from', from);
  if (to !== '') filters.set('to', to);
  if (words.trim() !== '') filters.set('q', words.trim());
  const query = filters.toString();
  const events = useInfiniteQuery({
    queryKey: ['settings', 'audit', query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.call<{ events: AuditEvent[] }>(
        'GET',
        `/api/v1/admin/audit?${query}${query === '' ? '' : '&'}limit=${PAGE}${pageParam === 0 ? '' : `&before=${pageParam}`}`,
      ),
    getNextPageParam: (last) =>
      last.events.length < PAGE ? undefined : last.events[last.events.length - 1]?.id,
  });
  const exported = useMutation({
    mutationFn: async () => {
      const { blob, filename } = await api.download(
        `/api/v1/admin/audit?${query}${query === '' ? '' : '&'}limit=1000&format=csv`,
        undefined,
        'GET',
      );
      saveFile(blob, filename);
    },
  });
  const list = events.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('audit.intro')}</p>
        </div>
        <Button busy={exported.isPending} onClick={() => exported.mutate()}>
          <Download className="size-4" aria-hidden />
          {t('audit.export')}
        </Button>
      </header>
      <div className="grid gap-3 rounded-lg border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-kind`}>{t('audit.kind')}</Label>
          <Select
            id={`${id}-kind`}
            label={t('audit.kind')}
            value={family}
            options={[
              { value: 'all', label: t('audit.all') },
              ...FAMILIES.map((f) => ({ value: f, label: t(`audit.families.${f.slice(0, -1)}`) })),
            ]}
            onChange={setFamily}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-actor`}>{t('audit.person')}</Label>
          <Select
            id={`${id}-actor`}
            label={t('audit.person')}
            value={actor}
            options={[
              { value: 'all', label: t('audit.everyone') },
              ...(people.data?.people ?? []).map((p) => ({ value: String(p.id), label: p.name })),
            ]}
            onChange={setActor}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-from`}>{t('audit.from')}</Label>
          <Input
            id={`${id}-from`}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-to`}>{t('audit.to')}</Label>
          <Input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-q`}>{t('audit.words')}</Label>
          <Input
            id={`${id}-q`}
            type="search"
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
        </div>
      </div>
      {events.error === null ? null : <Alert tone="danger">{message(events.error)}</Alert>}
      {exported.error === null ? null : <Alert tone="danger">{message(exported.error)}</Alert>}
      <div className="overflow-x-auto rounded-lg border bg-surface">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('audit.title')}</caption>
          <thead className="border-b bg-muted/40 text-start text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('audit.when')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('audit.person')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('audit.what')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('audit.ip')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {format.datetime(e.createdAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{e.actorName ?? t('audit.system')}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={tone(e.kind)}>
                      <span className="font-mono text-xs">{e.kind}</span>
                    </Badge>
                    <span>{e.summary}</span>
                  </div>
                  {e.targetModel === null ? null : (
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {e.targetModel}
                      {e.targetId === null ? '' : ` #${e.targetId}`}
                    </p>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                  {e.ip ?? ''}
                </td>
              </tr>
            ))}
            {events.data !== undefined && list.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  {t('audit.none')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {events.hasNextPage ? (
        <div className="flex justify-center">
          <Button busy={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            {t('audit.more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
