/**
 * Email › Inbound (RFC 0006 §7.1): the log of received messages by state. A quarantined message (no record
 * named, or a sender the record does not know) is attached to a record by hand, tried again, or discarded.
 */
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Input,
  Label,
  type PageProps,
  Select,
  Spinner,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Item {
  readonly id: number;
  readonly from: string | null;
  readonly fromName: string | null;
  readonly to: string | null;
  readonly subject: string | null;
  readonly text: string | null;
  readonly receivedAt: string | null;
  readonly state: string;
  readonly reason: string | null;
  readonly resModel: string | null;
  readonly resId: number | null;
  readonly attachmentCount: number;
}

const STATES = ['quarantined', 'posted', 'dropped', 'discarded', 'received'] as const;

function AttachDialog({
  api,
  item,
  models,
  onClose,
  onDone,
}: {
  readonly api: PageProps['api'];
  readonly item: Item;
  readonly models: readonly string[];
  readonly onClose: () => void;
  readonly onDone: (record: string) => void;
}): ReactElement {
  const { t } = useTranslation('mail');
  const id = useId();
  const [model, setModel] = useState(item.resModel ?? models[0] ?? '');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ id: number; displayName: string } | null>(null);
  const names = useQuery({
    queryKey: ['names', model, query],
    queryFn: () => api.names(model, { q: query, limit: 8 }),
    enabled: model !== '',
  });
  const attach = useMutation({
    mutationFn: () =>
      api.call('POST', `/api/v1/mail/inbound/${item.id}/attach`, { model, id: picked?.id }),
    onSuccess: () => onDone(picked?.displayName ?? ''),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('inbound.attach')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('inbound.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={attach.isPending}
            disabled={picked === null}
            onClick={() => attach.mutate()}
          >
            {t('inbound.confirmAttach')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-model`}>{t('inbound.model')}</Label>
          <Select
            id={`${id}-model`}
            value={model}
            onChange={(value) => {
              setModel(value);
              setPicked(null);
            }}
            options={models.map((m) => ({ value: m, label: m }))}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-record`}>{t('inbound.record')}</Label>
          <Input
            id={`${id}-record`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={(names.data?.length ?? 0) > 0}
            aria-controls={`${id}-list`}
            placeholder={t('inbound.recordSearch')}
            value={picked === null ? query : picked.displayName}
            onChange={(e) => {
              setPicked(null);
              setQuery(e.target.value);
            }}
          />
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label={t('inbound.record')}
            className="grid max-h-40 overflow-y-auto"
          >
            {picked === null
              ? (names.data ?? []).map((r) => (
                  <div
                    key={r.id}
                    role="option"
                    aria-selected={false}
                    tabIndex={0}
                    className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-muted"
                    onClick={() => setPicked(r)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setPicked(r);
                      }
                    }}
                  >
                    {r.displayName}
                  </div>
                ))
              : null}
          </div>
        </div>
        {attach.error === null ? null : <Alert>{attach.error.message}</Alert>}
      </div>
    </Dialog>
  );
}

export function InboundPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('mail');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const [state, setState] = useState<(typeof STATES)[number]>('quarantined');
  const [attaching, setAttaching] = useState<Item | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['mail', 'inbound', state],
    queryFn: () => api.call<{ items: Item[] }>('GET', `/api/v1/mail/inbound?state=${state}`),
  });
  const routes = useQuery({
    queryKey: ['routes'],
    queryFn: () => api.call<Record<string, unknown>>('GET', '/api/v1/routes'),
  });
  const models = Object.keys(routes.data ?? {}).sort();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['mail', 'inbound'] });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'discard' | 'retry' }) =>
      api.call('POST', `/api/v1/mail/inbound/${id}/${action}`),
    onSuccess: (_r, { action }) => {
      setNotice(action === 'discard' ? t('inbound.discarded') : null);
      refresh();
    },
  });
  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('inbound.title')}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t('inbound.intro')}</p>
      <fieldset className="flex flex-wrap gap-1">
        <legend className="sr-only">{t('inbound.title')}</legend>
        {STATES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={state === s ? 'primary' : 'secondary'}
            aria-pressed={state === s}
            onClick={() => setState(s)}
          >
            {t(`inbound.states.${s}`)}
          </Button>
        ))}
      </fieldset>
      {notice === null ? null : <Alert tone="info">{notice}</Alert>}
      {act.error === null ? null : <Alert>{act.error.message}</Alert>}
      {list.isPending ? (
        <Spinner label={t('inbound.title')} />
      ) : list.error !== null ? (
        <Alert>{list.error.message}</Alert>
      ) : (list.data?.items ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inbound.empty')}</p>
      ) : (
        <ul className="grid gap-2" aria-label={t(`inbound.states.${state}`)}>
          {(list.data?.items ?? []).map((item) => (
            <li key={item.id} className="grid gap-2 rounded-lg border bg-surface p-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">
                  {item.subject === null || item.subject === '' ? '—' : item.subject}
                </span>
                <span className="text-muted-foreground">
                  {t('inbound.from')}:{' '}
                  {item.fromName ? `${item.fromName} <${item.from ?? ''}>` : (item.from ?? '—')}
                </span>
                {item.receivedAt === null ? null : (
                  <time className="text-xs text-muted-foreground" dateTime={item.receivedAt}>
                    {format.datetime(item.receivedAt)}
                  </time>
                )}
                {item.attachmentCount > 0 ? (
                  <Badge tone="neutral">
                    {t('inbound.attachments', { count: item.attachmentCount })}
                  </Badge>
                ) : null}
                {item.reason === null ? null : (
                  <Badge tone="warning">
                    {t(`inbound.reasons.${item.reason}`, { defaultValue: item.reason })}
                  </Badge>
                )}
                {item.resModel === null ? null : (
                  <span className="text-xs text-muted-foreground">
                    {t('inbound.meant')}: {item.resModel} #{item.resId}
                  </span>
                )}
              </div>
              {shown === item.id ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                  {item.text ?? ''}
                </pre>
              ) : (
                <button
                  type="button"
                  className="justify-self-start text-xs text-primary hover:underline"
                  onClick={() => setShown(item.id)}
                >
                  {t('inbound.showText')}
                </button>
              )}
              {state === 'quarantined' || state === 'received' ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" onClick={() => setAttaching(item)}>
                    {t('inbound.attach')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => act.mutate({ id: item.id, action: 'retry' })}
                  >
                    {t('inbound.retry')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => act.mutate({ id: item.id, action: 'discard' })}
                  >
                    {t('inbound.discard')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {attaching === null ? null : (
        <AttachDialog
          api={api}
          item={attaching}
          models={models}
          onClose={() => setAttaching(null)}
          onDone={(record) => {
            setAttaching(null);
            setNotice(t('inbound.attached', { record }));
            refresh();
          }}
        />
      )}
    </div>
  );
}
