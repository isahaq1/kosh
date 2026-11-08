/**
 * "Return" on a done delivery or receipt (RFC 0030 §3.2): the lines with what can still come back, a quantity for
 * each, the reason and a note; the server makes the linked return, confirmed, and refuses more than was done.
 */
import {
  Alert,
  ApiError,
  Button,
  Dialog,
  Input,
  Label,
  type NodeComponentProps,
  Select,
} from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Line {
  readonly move: number;
  readonly name: string;
  readonly done: string;
  readonly returnable: string;
}

export function ReturnButton({ record, api, reload }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('stock');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const eligible =
    record !== null &&
    record['state'] === 'done' &&
    (record['kind'] === 'delivery' || record['kind'] === 'receipt');
  const lines = useQuery({
    queryKey: ['stock', 'returnable', record?.id],
    queryFn: () =>
      api.call<{ lines: Line[] }>('GET', `/api/v1/stockroom/pickings/${record?.id}/returnable`),
    enabled: eligible && open,
  });
  const reasons = useQuery({
    queryKey: ['stock', 'return-reasons'],
    queryFn: () =>
      api.list('stock.return.reason', {
        fields: ['id', 'name'],
        order: ['sequence asc'],
        limit: 50,
      }),
    enabled: eligible && open,
  });
  const send = useMutation({
    mutationFn: () =>
      api.call<{ picking: number; name: string }>(
        'POST',
        `/api/v1/stockroom/pickings/${record?.id}/return`,
        {
          lines: Object.entries(quantities)
            .filter(([, q]) => q !== '' && Number(q) > 0)
            .map(([move, quantity]) => ({ move: Number(move), quantity })),
          reason: Number(reason),
          note,
        },
      ),
    onSuccess: (r) => {
      setOpen(false);
      setMade(r.name);
      reload?.();
    },
  });
  if (!eligible) return null;
  const rows = lines.data?.lines ?? [];
  const any = Object.values(quantities).some((q) => q !== '' && Number(q) > 0);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        onClick={() => {
          setQuantities({});
          setReason(null);
          setNote('');
          setOpen(true);
        }}
      >
        {t('returns.button')}
      </Button>
      {made === null ? null : (
        <span role="status" className="text-xs text-muted-foreground">
          {t('returns.made', { name: made })}
        </span>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('returns.title')}
        description={t('returns.intro')}
        footer={
          <Button
            variant="primary"
            disabled={!any || reason === null}
            busy={send.isPending}
            onClick={() => send.mutate()}
          >
            {t('returns.confirm')}
          </Button>
        }
      >
        <div className="space-y-3">
          {rows.map((l) => (
            <div key={l.move} className="grid grid-cols-[1fr_8rem] items-end gap-2">
              <Label htmlFor={`${id}-q-${l.move}`}>
                {l.name}
                <span className="block text-xs text-muted-foreground">
                  {t('returns.left', { done: l.done, left: l.returnable })}
                </span>
              </Label>
              <Input
                id={`${id}-q-${l.move}`}
                inputMode="decimal"
                disabled={Number(l.returnable) <= 0}
                value={quantities[l.move] ?? ''}
                onChange={(e) => setQuantities({ ...quantities, [l.move]: e.target.value })}
              />
            </div>
          ))}
          <Select
            id={`${id}-reason`}
            label={t('returns.reason')}
            value={reason}
            options={((reasons.data?.items ?? []) as { id: number; name: string }[]).map((r) => ({
              value: String(r.id),
              label: r.name,
            }))}
            onChange={setReason}
          />
          <div className="space-y-1">
            <Label htmlFor={`${id}-note`}>{t('returns.note')}</Label>
            <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {send.error === null ? null : (
            <Alert>
              {send.error instanceof ApiError ? send.error.message : String(send.error)}
            </Alert>
          )}
        </div>
      </Dialog>
    </div>
  );
}
