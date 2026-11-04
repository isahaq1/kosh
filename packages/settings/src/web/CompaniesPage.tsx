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
  Checkbox,
  Dialog,
  Input,
  imageUrl,
  Label,
  type PageProps,
  Select,
  Textarea,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCircle2, Info, Plus } from 'lucide-react';
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
  /** The details a new company may be given (the installed apps' company fields). */
  readonly fields?: readonly NewField[];
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

/** The details of a new company, grouped as people expect them; anything else an app adds goes under "More". */
const ADDRESS = ['street', 'street2', 'city', 'state', 'zip', 'country', 'countryCode'];
const CONTACT = ['email', 'phone', 'mobile', 'website'];
const REGISTRATION = /tax|vat|bin|tin|gst|pan|registration|trade|licen|fiscal|year/i;

interface NewField {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly help: string | null;
  readonly options: readonly { readonly value: string; readonly label: string }[] | null;
}

function DetailInput({
  id,
  field,
  value,
  onChange,
}: {
  readonly id: string;
  readonly field: NewField;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}): ReactElement {
  if (field.kind === 'boolean')
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={value === true}
          onCheckedChange={(c) => onChange(c === true)}
          aria-describedby={field.help === null ? undefined : `${id}-help`}
        />
        <Label htmlFor={id}>{field.label}</Label>
      </div>
    );
  if (field.kind === 'selection' && field.options !== null)
    return (
      <Select
        id={id}
        label={field.label}
        value={typeof value === 'string' ? value : null}
        options={field.options}
        onChange={onChange}
      />
    );
  if (field.kind === 'text')
    return (
      <Textarea
        id={id}
        rows={2}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={field.help === null ? undefined : `${id}-help`}
      />
    );
  return (
    <Input
      id={id}
      type={
        field.kind === 'integer'
          ? 'number'
          : field.key === 'email'
            ? 'email'
            : field.key === 'website'
              ? 'url'
              : field.key.toLowerCase().includes('phone') || field.key === 'mobile'
                ? 'tel'
                : 'text'
      }
      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
      onChange={(e) =>
        onChange(
          field.kind === 'integer'
            ? e.target.value === ''
              ? null
              : Number(e.target.value)
            : e.target.value,
        )
      }
      aria-describedby={field.help === null ? undefined : `${id}-help`}
    />
  );
}

function NewCompanyDialog({
  api,
  currencies,
  fields,
  open,
  onOpenChange,
}: PageProps & {
  readonly currencies: Companies['currencies'];
  readonly fields: readonly NewField[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const { switchCompany } = useKosh();
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<'international' | 'lakh'>('international');
  const [accent, setAccent] = useState('');
  const [details, setDetails] = useState<Record<string, unknown>>({});
  const create = useMutation({
    mutationFn: () =>
      api.call<{ id: number; name: string; defaults: { module: string; summary: string }[] }>(
        'POST',
        '/api/v1/settings/companies',
        {
          name,
          currency: Number(currency),
          numberGrouping: grouping,
          ...(accent === '' ? {} : { accentColor: accent }),
          details: Object.fromEntries(
            Object.entries(details).filter(([, v]) => v !== '' && v !== null && v !== undefined),
          ),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'companies'] });
      // The switcher lists the user's companies from their details.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  useEffect(() => {
    if (!open) {
      setName('');
      setCurrency(null);
      setGrouping('international');
      setAccent('');
      setDetails({});
      create.reset();
    }
  }, [open, create.reset]);
  // The lakh and crore grouping suits taka and rupees: suggested when one is chosen (still the person's choice).
  const chooseCurrency = (value: string) => {
    setCurrency(value);
    const code = currencies.find((c) => String(c.id) === value)?.name ?? '';
    setGrouping(['BDT', 'INR', 'NPR', 'PKR', 'LKR'].includes(code) ? 'lakh' : 'international');
  };
  const set = (key: string) => (value: unknown) => setDetails((d) => ({ ...d, [key]: value }));
  const groups: {
    readonly key: string;
    readonly title: string;
    readonly hint: string;
    readonly fields: NewField[];
  }[] = [
    {
      key: 'address',
      title: t('companies.address'),
      hint: t('companies.addressHint'),
      fields: ADDRESS.flatMap((k) => fields.filter((f) => f.key === k)),
    },
    {
      key: 'contact',
      title: t('companies.contact'),
      hint: t('companies.contactHint'),
      fields: CONTACT.flatMap((k) => fields.filter((f) => f.key === k)),
    },
    {
      key: 'registration',
      title: t('companies.registration'),
      hint: t('companies.registrationHint'),
      fields: fields.filter(
        (f) =>
          !ADDRESS.includes(f.key) &&
          !CONTACT.includes(f.key) &&
          REGISTRATION.test(`${f.key} ${f.label}`),
      ),
    },
    {
      key: 'more',
      title: t('companies.more'),
      hint: t('companies.moreHint'),
      fields: fields.filter(
        (f) =>
          !ADDRESS.includes(f.key) &&
          !CONTACT.includes(f.key) &&
          !REGISTRATION.test(`${f.key} ${f.label}`),
      ),
    },
  ].filter((g) => g.fields.length > 0);
  const done = create.data;
  const field = (f: NewField) => {
    const fid = `${id}-${f.key}`;
    return (
      <div
        key={f.key}
        className={f.kind === 'text' ? 'grid gap-1.5 sm:col-span-2' : 'grid gap-1.5'}
      >
        {f.kind === 'boolean' ? null : <Label htmlFor={fid}>{f.label}</Label>}
        <DetailInput id={fid} field={f} value={details[f.key]} onChange={set(f.key)} />
        {f.help === null ? null : (
          <p id={`${fid}-help`} className="text-xs text-muted-foreground">
            {f.help}
          </p>
        )}
      </div>
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={
        done === undefined
          ? t('companies.newTitle')
          : t('companies.readyTitle', { name: done.name })
      }
      description={done === undefined ? t('companies.newHint') : t('companies.readyHint')}
      footer={
        done === undefined ? (
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
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>{t('companies.close')}</Button>
            {switchCompany === undefined ? null : (
              <Button variant="primary" onClick={() => switchCompany(done.id)}>
                {t('companies.switchNow')}
              </Button>
            )}
          </>
        )
      }
    >
      {done !== undefined ? (
        <div className="grid gap-3">
          <p className="flex items-center gap-2 text-sm font-medium text-success">
            <CheckCircle2 className="size-4" aria-hidden />
            {t('companies.created', { name: done.name })}
          </p>
          {done.defaults.length === 0 ? null : (
            <section aria-label={t('companies.setUp')} className="rounded-md border p-3">
              <h3 className="mb-2 text-sm font-semibold">{t('companies.setUp')}</h3>
              <ul className="grid gap-1 text-sm">
                {done.defaults.map((d) => (
                  <li key={d.module} className="flex gap-2">
                    <span className="min-w-28 font-medium">{d.module}</span>
                    <span className="text-muted-foreground">{d.summary}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="text-sm text-muted-foreground">{t('companies.nextSteps')}</p>
        </div>
      ) : (
        <form
          className="grid gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() !== '' && currency !== null) create.mutate();
          }}
        >
          <fieldset className="grid gap-4">
            <legend className="mb-1 text-sm font-semibold">{t('companies.identity')}</legend>
            <p className="-mt-2 text-xs text-muted-foreground">{t('companies.identityHint')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor={`${id}-name`}>
                  {t('company.name')}{' '}
                  <span aria-hidden className="text-danger">
                    *
                  </span>
                </Label>
                <Input
                  id={`${id}-name`}
                  required
                  aria-required
                  autoFocus
                  value={name}
                  placeholder={t('companies.namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-currency`}>
                  {t('companies.currency')}{' '}
                  <span aria-hidden className="text-danger">
                    *
                  </span>
                </Label>
                <Select
                  id={`${id}-currency`}
                  label={t('companies.currency')}
                  value={currency}
                  placeholder={t('companies.chooseCurrency')}
                  options={currencies.map((c) => ({ value: String(c.id), label: c.name }))}
                  onChange={chooseCurrency}
                />
                <p className="text-xs text-muted-foreground">{t('companies.currencyHint')}</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-grouping`}>{t('company.grouping')}</Label>
                <Select
                  id={`${id}-grouping`}
                  label={t('company.grouping')}
                  value={grouping}
                  options={[
                    { value: 'international', label: t('company.international') },
                    { value: 'lakh', label: t('company.lakh') },
                  ]}
                  onChange={(v) => setGrouping(v === 'lakh' ? 'lakh' : 'international')}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-accent`}>{t('company.brand')}</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('company.picker')}
                    className="h-9 w-12 cursor-pointer rounded border bg-surface"
                    value={accent === '' ? '#4f46e5' : accent}
                    onChange={(e) => setAccent(e.target.value)}
                  />
                  <Input
                    id={`${id}-accent`}
                    value={accent}
                    placeholder="#4f46e5"
                    onChange={(e) => setAccent(e.target.value.trim())}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t('companies.brandHint')}</p>
              </div>
            </div>
          </fieldset>
          {groups.map((g) => (
            <fieldset key={g.key} className="grid gap-4 border-t pt-4">
              <legend className="mb-1 text-sm font-semibold">{g.title}</legend>
              <p className="-mt-2 text-xs text-muted-foreground">{g.hint}</p>
              <div className="grid gap-4 sm:grid-cols-2">{g.fields.map(field)}</div>
            </fieldset>
          ))}
          <div className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{t('companies.whatHappens')}</p>
          </div>
          {create.error === null ? null : <Alert tone="danger">{message(create.error)}</Alert>}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
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
          fields={data.fields ?? []}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
    </div>
  );
}
