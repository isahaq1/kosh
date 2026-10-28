/**
 * One document: its fields, lines and totals, the PDF, the actions that apply now (signing in a dialog), Pay now
 * when it is open for payment online (and the outcome on the way back), and its thread. The server decides what applies; the page shows what it says.
 */
import { Alert, Button, Card, Dialog, Input, Label, Skeleton, Textarea } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Download, Send } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PayButtons, PaymentOutcome } from '../Pay.js';
import {
  type DocumentView,
  type Message,
  type PortalAction,
  saveFile,
  usePortal,
} from '../portal.js';
import { SignaturePad } from '../SignaturePad.js';
import { Value } from '../Value.js';

function ActionDialog({
  path,
  action,
  onClose,
  onDone,
}: {
  readonly path: string;
  readonly action: PortalAction;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const id = useId();
  const [name, setName] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api.call('POST', `${path}/actions/${action.key}`, {
        ...(action.signature ? { signature: { name: name.trim(), image } } : {}),
        ...(message.trim() === '' ? {} : { message: message.trim() }),
      }),
    onSuccess: onDone,
  });
  const ready =
    (!action.signature || (name.trim() !== '' && image !== null)) &&
    (!action.message || message.trim() !== '');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={action.label}
      {...(action.signature ? { description: t('signIntro') } : {})}
      footer={
        <Button
          variant="primary"
          disabled={!ready}
          busy={run.isPending}
          onClick={() => run.mutate()}
        >
          {action.signature ? t('confirmSign') : t('confirmAction')}
        </Button>
      }
    >
      <div className="grid gap-3">
        {action.signature ? (
          <>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-name`}>{t('fullName')}</Label>
              <Input
                id={`${id}-name`}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <span className="text-sm font-medium">{t('drawHere')}</span>
              <SignaturePad name={name} onChange={setImage} />
            </div>
          </>
        ) : null}
        {action.message ? (
          <div className="grid gap-1">
            <Label htmlFor={`${id}-message`}>{t('reason')}</Label>
            <Textarea
              id={`${id}-message`}
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
        ) : null}
        {run.error === null ? null : <Alert>{run.error.message}</Alert>}
      </div>
    </Dialog>
  );
}

function Thread({ path }: { readonly path: string }): ReactElement {
  const { t } = useTranslation('portal');
  const { api, format } = usePortal();
  const id = useId();
  const [body, setBody] = useState('');
  const thread = useQuery({
    queryKey: ['portal', 'thread', path],
    queryFn: () => api.call<{ messages: Message[] }>('GET', `${path}/thread`),
  });
  const send = useMutation({
    mutationFn: () => api.call('POST', `${path}/thread`, { body: body.trim() }),
    onSuccess: () => {
      setBody('');
      void thread.refetch();
    },
  });
  const messages = [...(thread.data?.messages ?? [])].reverse();
  return (
    <Card className="grid gap-3 p-4">
      <h2 className="font-semibold">{t('thread')}</h2>
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noMessages')}</p>
      ) : (
        <ol className="grid gap-3">
          {messages.map((m) => (
            <li
              key={m.id}
              className={m.mine ? 'rounded-md bg-accent p-3' : 'rounded-md border p-3'}
            >
              <p className="text-xs text-muted-foreground">
                {m.mine ? t('you') : m.author} · {format.datetime(m.at)}
              </p>
              {/* The server renders message bodies from escaped text (RFC 0006). */}
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by the server */}
              <div className="text-sm" dangerouslySetInnerHTML={{ __html: m.body }} />
            </li>
          ))}
        </ol>
      )}
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim() !== '') send.mutate();
        }}
      >
        <Label htmlFor={`${id}-body`}>{t('write')}</Label>
        <Textarea
          id={`${id}-body`}
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {send.error === null ? null : <Alert>{send.error.message}</Alert>}
        <Button type="submit" size="sm" className="justify-self-end" busy={send.isPending}>
          <Send aria-hidden />
          {t('send')}
        </Button>
      </form>
    </Card>
  );
}

export function Document(): ReactElement {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const queryClient = useQueryClient();
  const { key, id } = useParams({ strict: false }) as { readonly key: string; readonly id: string };
  const path = `/api/portal/v1/documents/${encodeURIComponent(key)}/${encodeURIComponent(id)}`;
  const [acting, setActing] = useState<PortalAction | null>(null);
  const [done, setDone] = useState(false);
  // Back from a payment provider: `?payment=<reference>`.
  const [payment] = useState(() => new URLSearchParams(window.location.search).get('payment'));
  const view = useQuery({
    queryKey: ['portal', 'document', path],
    queryFn: () => api.call<DocumentView>('GET', path),
    retry: false,
  });
  const pdf = useMutation({
    mutationFn: async () => {
      const { blob, filename } = await api.download(`${path}/pdf`, undefined, 'GET');
      saveFile(blob, filename);
    },
  });
  if (view.isError) return <Alert>{view.error.message}</Alert>;
  if (view.data === undefined) return <Skeleton className="h-64" />;
  const { record, fields, lineFields, lines, actions } = view.data;
  const title =
    typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : `#${record.id}`;
  return (
    <>
      <Link
        to="/d/$key"
        params={{ key }}
        className="inline-flex items-center gap-1 text-sm text-primary"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
        {view.data.label}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        <div className="flex flex-wrap gap-2">
          {view.data.payable === true ? <PayButtons document={key} id={id} /> : null}
          {actions.map((a) => (
            <Button
              key={a.key}
              variant={a.signature ? 'primary' : 'secondary'}
              onClick={() => setActing(a)}
            >
              {a.label}
            </Button>
          ))}
          {view.data.pdf ? (
            <Button variant="ghost" busy={pdf.isPending} onClick={() => pdf.mutate()}>
              <Download aria-hidden />
              {t('pdf')}
            </Button>
          ) : null}
        </div>
      </div>
      {done ? <Alert tone="info">{t('done')}</Alert> : null}
      {payment === null || payment === '' ? null : <PaymentOutcome reference={payment} />}
      {pdf.error === null ? null : <Alert>{pdf.error.message}</Alert>}
      <Card className="p-4">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {fields
            .filter((f) => f.key !== 'name')
            .map((f) => (
              <div key={f.key} className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">{f.label}</dt>
                <dd className="text-sm">
                  <Value field={f} value={record[f.key]} />
                </dd>
              </div>
            ))}
        </dl>
      </Card>
      {lineFields === undefined || lines === undefined ? null : (
        <Card className="grid gap-2 p-4">
          <h2 className="font-semibold">{t('lines')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  {lineFields.map((f) => (
                    <th key={f.key} className="px-2 py-2 text-start font-medium">
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-b last:border-0">
                    {lineFields.map((f) => (
                      <td key={f.key} className="px-2 py-2">
                        <Value field={f} value={line[f.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {view.data.thread ? <Thread path={path} /> : null}
      {acting === null ? null : (
        <ActionDialog
          path={path}
          action={acting}
          onClose={() => setActing(null)}
          onDone={() => {
            setActing(null);
            setDone(true);
            void queryClient.invalidateQueries({ queryKey: ['portal'] });
          }}
        />
      )}
    </>
  );
}
