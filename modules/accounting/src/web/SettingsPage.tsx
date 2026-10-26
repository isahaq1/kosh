/**
 * Accounting › Configuration › Settings: the chart of accounts (install one, once) and the lock dates. The server
 * decides who may (managers); the page shows what it answers.
 */
import { Alert, Button, Input, Label, type PageProps, Select } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Settings {
  readonly chartTemplate: string | null;
  readonly lockDate: string | null;
  readonly taxLockDate: string | null;
}

export function SettingsPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('accounting');
  const id = useId();
  const queryClient = useQueryClient();
  const charts = useQuery({
    queryKey: ['accounting', 'charts'],
    queryFn: () =>
      api.call<{ installed: string | null; templates: { code: string; label: string }[] }>(
        'GET',
        '/api/v1/accounting/charts',
      ),
  });
  const settings = useQuery({
    queryKey: ['accounting', 'settings'],
    queryFn: () => api.call<Settings>('GET', '/api/v1/accounting/settings'),
  });
  const [template, setTemplate] = useState<string | null>(null);
  const [lockDate, setLockDate] = useState<string | null>(null);
  const [taxLockDate, setTaxLockDate] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const install = useMutation({
    mutationFn: () =>
      api.call<{ accounts: number; journals: number }>(
        'POST',
        '/api/v1/accounting/charts/install',
        {
          template,
        },
      ),
    onSuccess: async (r) => {
      setError(null);
      setMessage(t('settings.installed_done', r));
      await queryClient.invalidateQueries({ queryKey: ['accounting'] });
    },
    onError: (e) => setError(e.message),
  });
  const save = useMutation({
    mutationFn: () =>
      api.call<Settings>('PUT', '/api/v1/accounting/settings', {
        lockDate: lockDate ?? settings.data?.lockDate ?? null,
        taxLockDate: taxLockDate ?? settings.data?.taxLockDate ?? null,
      }),
    onSuccess: async () => {
      setError(null);
      setMessage(t('settings.saved'));
      await queryClient.invalidateQueries({ queryKey: ['accounting', 'settings'] });
    },
    onError: (e) => setError(e.message),
  });
  const current = settings.data;
  return (
    <div className="mx-auto grid max-w-2xl gap-6 p-4">
      <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
      {message === null ? null : <Alert tone="info">{message}</Alert>}
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      <section className="grid gap-3 rounded-lg border p-4">
        <h2 className="font-medium">{t('settings.chart')}</h2>
        {charts.data?.installed ? (
          <p className="text-sm text-muted-foreground">
            {t('settings.installed', {
              template:
                charts.data.templates.find((c) => c.code === charts.data?.installed)?.label ??
                charts.data.installed,
            })}
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Select
              id={`${id}-chart`}
              label={t('settings.choose')}
              className="w-64"
              value={template}
              options={(charts.data?.templates ?? []).map((c) => ({
                value: c.code,
                label: c.label,
              }))}
              onChange={setTemplate}
            />
            <Button
              variant="primary"
              disabled={template === null}
              busy={install.isPending}
              onClick={() => install.mutate()}
            >
              {t('settings.install')}
            </Button>
          </div>
        )}
      </section>
      <section className="grid gap-3 rounded-lg border p-4">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-lock`}>{t('settings.lockDate')}</Label>
          <Input
            id={`${id}-lock`}
            type="date"
            value={lockDate ?? current?.lockDate ?? ''}
            onChange={(e) => setLockDate(e.target.value === '' ? null : e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('settings.lockDateHint')}</p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-taxlock`}>{t('settings.taxLockDate')}</Label>
          <Input
            id={`${id}-taxlock`}
            type="date"
            value={taxLockDate ?? current?.taxLockDate ?? ''}
            onChange={(e) => setTaxLockDate(e.target.value === '' ? null : e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('settings.taxLockDateHint')}</p>
        </div>
        <div>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            {t('settings.save')}
          </Button>
        </div>
      </section>
    </div>
  );
}
