/**
 * "Send by email" in a list's bar of selected rows (RFC 0029 §3.3): each selected document goes to its partner
 * with its own template, in the partner's language, with its PDF. Documents without an address or not ready are
 * skipped and said so. Hidden on lists of models that are not sendable.
 */
import { ApiError, Button, Dialog, type SelectionActionProps } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface BatchResult {
  readonly sent: number;
  readonly skipped: readonly { readonly id: number; readonly reason: string }[];
}

export function SendSelected({ api, model, ids, done }: SelectionActionProps): ReactElement | null {
  const { t } = useTranslation('mail');
  const [open, setOpen] = useState(false);
  const sendable = useQuery({
    queryKey: ['mail', 'sendable'],
    queryFn: () => api.call<{ models: string[] }>('GET', '/api/v1/mail/sendable'),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const send = useMutation({
    mutationFn: () => api.call<BatchResult>('POST', `/api/v1/mail/send-many/${model}`, { ids }),
    onSuccess: (r) => {
      setOpen(false);
      const skipped =
        r.skipped.length === 0
          ? ''
          : ` ${t('send.skipped', { count: r.skipped.length, reason: r.skipped[0]?.reason ?? '' })}`;
      done(`${t('send.sentMany', { count: r.sent })}${skipped}`, r.sent === 0 ? 'danger' : 'info');
    },
  });
  if (!(sendable.data?.models ?? []).includes(model)) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Mail aria-hidden />
        {t('send.many')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('send.manyTitle', { count: ids.length })}
        description={t('send.manyIntro')}
        footer={
          <Button variant="primary" busy={send.isPending} onClick={() => send.mutate()}>
            {t('send.confirm')}
          </Button>
        }
      >
        {send.error === null ? null : (
          <p role="alert" className="text-sm text-danger">
            {send.error instanceof ApiError ? send.error.message : String(send.error)}
          </p>
        )}
      </Dialog>
    </>
  );
}
