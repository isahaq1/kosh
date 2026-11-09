/**
 * "Send" on the form of a sendable document (RFC 0029 §3.3): the dialog opens with the customer's address, the
 * template's subject and body in their language and the PDF named; everything can be edited before sending. The
 * server renders the PDF, posts the message on the chatter and queues the email. Hidden on documents that are not
 * sendable, and refused by the server on records not ready to send.
 */
import {
  ApiError,
  Button,
  Checkbox,
  Dialog,
  Input,
  Label,
  type NodeComponentProps,
  Textarea,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Paperclip } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Composition {
  readonly to: readonly { readonly name: string; readonly email: string | null }[];
  readonly subject: string;
  readonly body: string;
  readonly attachment: string | null;
  readonly sent: number;
  readonly lastSentAt: string | null;
}

export function SendButton({
  record,
  model,
  api,
  reload,
}: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('mail');
  const { format } = useKosh();
  const id = useId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attach, setAttach] = useState(true);
  const [done, setDone] = useState(false);
  const sendable = useQuery({
    queryKey: ['mail', 'sendable'],
    queryFn: () => api.call<{ models: string[] }>('GET', '/api/v1/mail/sendable'),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const compose = useMutation({
    mutationFn: () => api.call<Composition>('GET', `/api/v1/mail/compose/${model}/${record?.id}`),
    onSuccess: (c) => {
      setTo(
        c.to
          .map((r) => r.email)
          .filter((e): e is string => e !== null && e !== '')
          .join(', '),
      );
      setCc('');
      setSubject(c.subject);
      setBody(c.body);
      setAttach(c.attachment !== null);
      setDone(false);
      setOpen(true);
    },
  });
  const send = useMutation({
    mutationFn: () =>
      api.call('POST', `/api/v1/mail/send/${model}/${record?.id}`, {
        to,
        cc,
        subject,
        body,
        attach,
      }),
    onSuccess: () => {
      setDone(true);
      setOpen(false);
      // The message is on the chatter now.
      void queryClient.invalidateQueries({ queryKey: ['chatter', model, record?.id] });
      reload?.();
    },
  });
  if (record === null || !(sendable.data?.models ?? []).includes(model)) return null;
  const c = compose.data;
  const error = compose.error ?? send.error;
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" busy={compose.isPending} onClick={() => compose.mutate()}>
        <Mail aria-hidden />
        {t('send.button')}
      </Button>
      {done ? (
        <span role="status" className="text-xs text-muted-foreground">
          {t('send.queued')}
        </span>
      ) : null}
      {error !== null && !open ? (
        <span role="alert" className="text-xs text-danger">
          {error instanceof ApiError ? error.message : String(error)}
        </span>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('send.title')}
        description={
          c === undefined || c.sent === 0
            ? t('send.intro')
            : t('send.already', {
                count: c.sent,
                date: c.lastSentAt === null ? '' : format.date(c.lastSentAt),
              })
        }
        footer={
          <Button
            variant="primary"
            busy={send.isPending}
            disabled={to.trim() === '' || subject.trim() === ''}
            onClick={() => send.mutate()}
          >
            {t('send.confirm')}
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-to`}>{t('send.to')}</Label>
            <Input id={`${id}-to`} type="text" value={to} onChange={(e) => setTo(e.target.value)} />
            {c?.to.some((r) => r.email === null || r.email === '') ? (
              <p className="text-xs text-muted-foreground">
                {t('send.noEmail', { name: c.to[0]?.name ?? '' })}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-cc`}>{t('send.cc')}</Label>
            <Input id={`${id}-cc`} type="text" value={cc} onChange={(e) => setCc(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-subject`}>{t('send.subject')}</Label>
            <Input
              id={`${id}-subject`}
              value={subject}
              maxLength={998}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-body`}>{t('send.body')}</Label>
            <Textarea
              id={`${id}-body`}
              rows={9}
              maxLength={50_000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {c?.attachment === null || c === undefined ? null : (
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`${id}-attach`}
                checked={attach}
                onCheckedChange={(on) => setAttach(on === true)}
              />
              <label htmlFor={`${id}-attach`} className="flex items-center gap-1">
                <Paperclip aria-hidden className="size-4" />
                {c.attachment}
              </label>
            </div>
          )}
          {send.error === null ? null : (
            <p role="alert" className="text-sm text-danger">
              {send.error instanceof ApiError ? send.error.message : String(send.error)}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
