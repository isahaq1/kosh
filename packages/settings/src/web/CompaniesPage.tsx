/**
 * Settings › Companies (RFC 0019 §3.4): every company of the installation with its currency and the people who work
 * in it; switching to one; and, for administrators, a new company — its apps' defaults (journals, sequences, taxes…)
 * are installed with it, and the administrators can switch to it at once.
 */
import {
  Alert,
  ApiError,
  Avatar,
  Badge,
  Button,
  Dialog,
  Input,
  imageUrl,
  Label,
  type PageProps,
  Select,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Companies {
  readonly canCreate: boolean;
  readonly companies: readonly {
    readonly id: number;
    readonly name: string;
    readonly currency: string;
    readonly people: number;
    readonly current: boolean;
    readonly member: boolean;
    readonly logo: string | null;
  }[];
  readonly currencies: readonly { readonly id: number; readonly name: string }[];
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

function NewCompanyDialog({
  api,
  currencies,
  open,
  onOpenChange,
}: PageProps & {
  readonly currencies: Companies['currencies'];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.call<{ id: number }>('POST', '/api/v1/settings/companies', {
        name,
        currency: Number(currency),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'companies'] });
      // The switcher lists the user's companies from their details.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      onOpenChange(false);
    },
  });
  useEffect(() => {
    if (!open) {
      setName('');
      setCurrency(null);
      create.reset();
    }
  }, [open, create.reset]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('companies.newTitle')}
      description={t('companies.newHint')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('profile.cancel')}</Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={name.trim() === '' || currency === null}
            onClick={() => create.mutate()}
          >
            {t('companies.create')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('company.name')}</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-currency`}>{t('companies.currency')}</Label>
          <Select
            id={`${id}-currency`}
            label={t('companies.currency')}
            value={currency}
            placeholder={t('companies.chooseCurrency')}
            options={currencies.map((c) => ({ value: String(c.id), label: c.name }))}
            onChange={setCurrency}
          />
        </div>
        {create.error === null ? null : <Alert tone="danger">{message(create.error)}</Alert>}
      </div>
    </Dialog>
  );
}

export function CompaniesPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { switchCompany } = useKosh();
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['settings', 'companies'],
    queryFn: () => api.call<Companies>('GET', '/api/v1/settings/companies'),
  });
  if (list.error !== null) return <Alert tone="danger">{message(list.error)}</Alert>;
  const data = list.data;
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('companies.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('companies.intro')}</p>
        </div>
        {data?.canCreate === true ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            {t('companies.new')}
          </Button>
        ) : null}
      </header>
      {data === undefined ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-surface">
          {data.companies.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {c.logo === null ? (
                <span
                  aria-hidden
                  className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
                >
                  <Building2 className="size-4" />
                </span>
              ) : (
                <Avatar
                  name={c.name}
                  src={imageUrl('company', c.id, c.logo)}
                  shape="square"
                  className="size-9 border"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  <span className="truncate">{c.name}</span>
                  {c.current ? <Badge tone="info">{t('companies.current')}</Badge> : null}
                </p>
                <p className="text-sm text-muted-foreground">
                  {c.currency} · {t('companies.people', { count: c.people })}
                </p>
              </div>
              {c.current || !c.member || switchCompany === undefined ? null : (
                <Button
                  size="sm"
                  aria-label={t('companies.switchTo', { name: c.name })}
                  onClick={() => switchCompany(c.id)}
                >
                  {t('companies.switch')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data === undefined ? null : (
        <NewCompanyDialog
          api={api}
          currencies={data.currencies}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
    </div>
  );
}
