/**
 * The company's GST settings (RFC 0016 step 5, part 4), on the GST returns page: GSTIN, PAN, the address and PIN code
 * the IRP needs, and e-invoicing on or off. Managers change them; the server checks the GSTIN against the company's
 * state.
 */
import { Alert, ApiError, Button, Input, type KoshApi, Label } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Settings {
  readonly provider: string | null;
  readonly gstin: string | null;
  readonly pan: string | null;
  readonly street: string | null;
  readonly city: string | null;
  readonly zip: string | null;
  readonly einvoiceEnabled: boolean;
}

const FIELDS = ['gstin', 'pan', 'street', 'city', 'zip'] as const;

export function GstSettings({ api }: { readonly api: KoshApi }): ReactElement {
  const { t } = useTranslation('l10n_in');
  const id = useId();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['l10n_in', 'settings'],
    queryFn: () => api.call<Settings>('GET', '/api/v1/l10n_in/settings'),
  });
  const [edits, setEdits] = useState<
    Partial<Record<(typeof FIELDS)[number] | 'einvoiceEnabled', string | boolean>>
  >({});
  const save = useMutation({
    mutationFn: () => api.call<Settings>('PUT', '/api/v1/l10n_in/settings', edits),
    onSuccess: async () => {
      setEdits({});
      await queryClient.invalidateQueries({ queryKey: ['l10n_in'] });
    },
  });
  const current = settings.data;
  if (current === undefined) return <></>;
  const value = (key: (typeof FIELDS)[number]) => String(edits[key] ?? current[key] ?? '');
  const einvoice = Boolean(edits.einvoiceEnabled ?? current.einvoiceEnabled);
  return (
    <section className="grid max-w-3xl gap-3 rounded-lg border p-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="font-medium">
        {t('settings.title')}
      </h2>
      <p className="text-sm text-muted-foreground">
        {current.provider === null
          ? t('settings.noProvider')
          : t('settings.provider', { provider: current.provider })}
      </p>
      {save.error === null ? null : (
        <Alert tone="danger">
          {save.error instanceof ApiError ? save.error.message : String(save.error)}
        </Alert>
      )}
      {save.isSuccess ? <Alert tone="info">{t('settings.saved')}</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((key) => (
          <div key={key} className="grid gap-1">
            <Label htmlFor={`${id}-${key}`}>{t(`settings.${key}`)}</Label>
            <Input
              id={`${id}-${key}`}
              value={value(key)}
              onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={einvoice}
          onChange={(e) => setEdits({ ...edits, einvoiceEnabled: e.target.checked })}
        />
        {t('settings.einvoice')}
      </label>
      <div>
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          {t('settings.save')}
        </Button>
      </div>
    </section>
  );
}
