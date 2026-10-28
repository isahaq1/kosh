/**
 * On a posted customer invoice or note (RFC 0016 step 5, part 4): its e-invoice (status, IRN, acknowledgement; register,
 * cancel within 24 hours) and, on invoices, its e-way bill (the transport, then generate; cancel within 24 hours). The
 * server checks and decides; the panel shows what it answers, refusals included.
 */
import { Alert, ApiError, Button, Input, Label, type NodeComponentProps, Select } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface State {
  readonly applicable: boolean;
  readonly provider: string | null;
  readonly status: 'registered' | 'failed' | 'cancelled' | null;
  readonly irn: string | null;
  readonly ackNo: string | null;
  readonly ackDate: string | null;
  readonly error: string | null;
  readonly ewayBill: {
    readonly status: 'generated' | 'failed' | 'cancelled' | null;
    readonly number: string | null;
    readonly validUntil: string | null;
    readonly vehicleNo: string | null;
    readonly distanceKm: number | null;
    readonly error: string | null;
  };
}

const CUSTOMER_DOCUMENTS = ['out_invoice', 'out_refund', 'out_debit'];

export function EInvoicePanel({
  api,
  record,
  version,
  reload,
}: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('l10n_in');
  const id = useId();
  const moveId = record?.['id'];
  const shown =
    record !== null &&
    record['state'] === 'posted' &&
    CUSTOMER_DOCUMENTS.includes(String(record['kind']));
  const state = useQuery({
    queryKey: ['l10n_in', 'einvoice', moveId, version],
    queryFn: () => api.call<State>('GET', `/api/v1/l10n_in/einvoice/${moveId}`),
    enabled: shown,
  });
  const [reason, setReason] = useState<string | null>('2');
  const [mode, setMode] = useState<string | null>('road');
  const [distance, setDistance] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [transporter, setTransporter] = useState('');
  const act = useMutation({
    mutationFn: (request: { path: string; body?: unknown }) =>
      api.call<State>('POST', `/api/v1/l10n_in/${request.path}`, request.body ?? {}),
    onSettled: async () => {
      await state.refetch();
      reload();
    },
  });
  if (!shown || state.data === undefined || !state.data.applicable) return null;
  const s = state.data;
  const error =
    act.error instanceof ApiError
      ? act.error.message
      : act.error === null
        ? null
        : String(act.error);
  return (
    <section className="grid gap-3 rounded-lg border p-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="font-medium">
        {t('einvoice.title')}
      </h2>
      {s.provider === null ? (
        <p className="text-sm text-muted-foreground">{t('einvoice.noProvider')}</p>
      ) : null}
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('einvoice.status')}</dt>
        <dd>{t(`einvoice.states.${s.status ?? 'none'}`)}</dd>
        {s.irn === null ? null : (
          <>
            <dt className="text-muted-foreground">IRN</dt>
            <dd className="break-all font-mono text-xs">{s.irn}</dd>
            <dt className="text-muted-foreground">{t('einvoice.ack')}</dt>
            <dd>
              {s.ackNo} · {s.ackDate}
            </dd>
          </>
        )}
      </dl>
      {s.status === 'failed' && s.error !== null ? <Alert tone="warning">{s.error}</Alert> : null}
      {s.provider === null ? null : (
        <div className="flex flex-wrap items-end gap-2">
          {s.status !== 'registered' && s.status !== 'cancelled' ? (
            <Button
              variant="primary"
              busy={act.isPending}
              onClick={() => act.mutate({ path: `einvoice/${moveId}` })}
            >
              {t('einvoice.register')}
            </Button>
          ) : null}
          {s.status === 'registered' ? (
            <>
              <Select
                id={`${id}-reason`}
                label={t('einvoice.reason')}
                className="w-56"
                value={reason}
                options={['1', '2', '3', '4'].map((r) => ({
                  value: r,
                  label: t(`einvoice.reasons.${r}`),
                }))}
                onChange={setReason}
              />
              <Button
                variant="secondary"
                busy={act.isPending}
                onClick={() => act.mutate({ path: `einvoice/${moveId}/cancel`, body: { reason } })}
              >
                {t('einvoice.cancel')}
              </Button>
            </>
          ) : null}
        </div>
      )}
      {s.provider === null || record?.['kind'] !== 'out_invoice' ? null : (
        <div className="grid gap-2 border-t pt-3">
          <h3 className="text-sm font-medium">{t('einvoice.ewayBill')}</h3>
          {s.ewayBill.status === 'generated' ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span>
                {t('einvoice.ewbNumber', {
                  number: s.ewayBill.number,
                  until: s.ewayBill.validUntil,
                  vehicle: s.ewayBill.vehicleNo,
                })}
              </span>
              <Button
                variant="secondary"
                busy={act.isPending}
                onClick={() =>
                  act.mutate({ path: `ewaybill/${moveId}/cancel`, body: { reason: '2' } })
                }
              >
                {t('einvoice.ewbCancel')}
              </Button>
            </div>
          ) : (
            <>
              {s.ewayBill.status === 'failed' && s.ewayBill.error !== null ? (
                <Alert tone="warning">{s.ewayBill.error}</Alert>
              ) : null}
              {s.ewayBill.status === 'cancelled' ? (
                <p className="text-sm text-muted-foreground">{t('einvoice.ewbCancelled')}</p>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <Select
                  id={`${id}-mode`}
                  label={t('einvoice.mode')}
                  className="w-32"
                  value={mode}
                  options={['road', 'rail', 'air', 'ship'].map((m) => ({
                    value: m,
                    label: t(`einvoice.modes.${m}`),
                  }))}
                  onChange={setMode}
                />
                <div className="grid gap-1">
                  <Label htmlFor={`${id}-distance`}>{t('einvoice.distance')}</Label>
                  <Input
                    id={`${id}-distance`}
                    inputMode="numeric"
                    className="w-24"
                    value={distance}
                    onChange={(e) => setDistance(e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${id}-vehicle`}>{t('einvoice.vehicle')}</Label>
                  <Input
                    id={`${id}-vehicle`}
                    className="w-36"
                    value={vehicle}
                    onChange={(e) => setVehicle(e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${id}-transporter`}>{t('einvoice.transporter')}</Label>
                  <Input
                    id={`${id}-transporter`}
                    className="w-40"
                    value={transporter}
                    onChange={(e) => setTransporter(e.target.value)}
                  />
                </div>
                <Button
                  variant="primary"
                  busy={act.isPending}
                  onClick={() =>
                    act.mutate({
                      path: `ewaybill/${moveId}`,
                      body: {
                        mode,
                        distanceKm: Number(distance),
                        vehicleNo: vehicle,
                        transporterId: transporter,
                      },
                    })
                  }
                >
                  {t('einvoice.ewbGenerate')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
