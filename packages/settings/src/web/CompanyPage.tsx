/**
 * Settings › Company (RFC 0018, RFC 0019 §3.4): the current company's name, number grouping and brand colour — the
 * back-office's accent for everyone in the company — and its details: address, contacts and whatever the installed
 * apps add (tax ids, fiscal year…), as the server offers them. The preview shows the colour as buttons, links and
 * selections take it, in light and dark; the themes keep text readable whatever colour is chosen.
 */
import {
  Alert,
  ApiError,
  accentVariables,
  Badge,
  Button,
  Checkbox,
  ImagePicker,
  Input,
  imageUrl,
  Label,
  type PageProps,
  Select,
  Textarea,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { type CSSProperties, type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Company {
  readonly id: number;
  readonly name: string;
  readonly numberGrouping: 'international' | 'lakh';
  readonly accentColor: string | null;
  readonly currency: string;
  readonly details: readonly Detail[];
}

type Value = string | number | boolean | null;
interface Detail {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly readonly: boolean;
  readonly options: readonly { readonly value: string; readonly label: string }[] | null;
  readonly value: Value;
}

/** One detail, by its kind: text, a long text, a number, yes / no, or a choice. */
function DetailField({
  detail,
  value,
  onChange,
}: {
  readonly detail: Detail;
  readonly value: Value;
  readonly onChange: (value: Value) => void;
}): ReactElement {
  const id = `company-${detail.key}`;
  const { t } = useTranslation('settings');
  if (detail.kind === 'boolean')
    return (
      <div className="flex items-center gap-2 sm:col-span-2">
        <Checkbox
          id={id}
          checked={value === true}
          disabled={detail.readonly}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <Label htmlFor={id}>{detail.label}</Label>
      </div>
    );
  return (
    <div className={`grid gap-1.5 ${detail.kind === 'text' ? 'sm:col-span-2' : ''}`}>
      <Label htmlFor={id}>{detail.label}</Label>
      {detail.kind === 'selection' ? (
        <Select
          id={id}
          label={detail.label}
          value={typeof value === 'string' ? value : 'none'}
          options={[{ value: 'none', label: t('company.notSet') }, ...(detail.options ?? [])]}
          disabled={detail.readonly}
          onChange={(v) => onChange(v === 'none' ? null : v)}
        />
      ) : detail.kind === 'text' ? (
        <Textarea
          id={id}
          rows={3}
          value={typeof value === 'string' ? value : ''}
          readOnly={detail.readonly}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={detail.kind === 'integer' ? 'number' : 'text'}
          value={value === null ? '' : String(value)}
          readOnly={detail.readonly}
          onChange={(e) =>
            onChange(
              detail.kind === 'integer'
                ? e.target.value === ''
                  ? null
                  : Number.parseInt(e.target.value, 10)
                : e.target.value,
            )
          }
        />
      )}
    </div>
  );
}

/** Suggested colours: indigo (the default), and a few that read well as an accent in both themes. */
const SWATCHES = [
  '#4f46e5',
  '#2563eb',
  '#0d9488',
  '#16a34a',
  '#ca8a04',
  '#ea580c',
  '#dc2626',
  '#db2777',
  '#7c3aed',
  '#475569',
];
const HEX = /^#[0-9a-fA-F]{6}$/;

function Preview({
  color,
  dark,
}: {
  readonly color: string | null;
  readonly dark: boolean;
}): ReactElement {
  const { t } = useTranslation('settings');
  return (
    <div
      className={`${dark ? 'dark' : 'light'} grid gap-3 rounded-lg border bg-background p-4 text-foreground`}
      style={accentVariables(color) as CSSProperties}
    >
      <p className="text-xs font-medium text-muted-foreground">
        {dark ? t('company.dark') : t('company.light')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" tabIndex={-1}>
          {t('company.sampleAction')}
        </Button>
        <Badge tone="info">{t('company.sampleBadge')}</Badge>
        <span className="text-sm text-primary underline underline-offset-4">
          {t('company.sampleLink')}
        </span>
      </div>
      <div className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground">
        {t('company.sampleSelected')}
      </div>
    </div>
  );
}

export function CompanyPage({ api }: PageProps): ReactElement {
  const company = useQuery({
    queryKey: ['settings', 'company'],
    queryFn: () => api.call<Company>('GET', '/api/v1/settings/company'),
  });
  if (company.error !== null)
    return (
      <Alert tone="danger">
        {company.error instanceof ApiError ? company.error.message : String(company.error)}
      </Alert>
    );
  // The form starts from the loaded company: nothing can be chosen before it is there and then overwritten.
  return company.data === undefined ? (
    <p className="text-sm text-muted-foreground">…</p>
  ) : (
    <CompanyForm api={api} company={company.data} />
  );
}

function CompanyForm({ api, company }: PageProps & { readonly company: Company }): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(company.name);
  const [grouping, setGrouping] = useState<Company['numberGrouping']>(company.numberGrouping);
  const [color, setColor] = useState<string | null>(company.accentColor);
  const [typed, setTyped] = useState(company.accentColor ?? '');
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.call<{ logos?: Record<string, string> }>('GET', '/api/v1/auth/me'),
  });
  const logo = useMutation({
    mutationFn: (image: string | null) =>
      image === null
        ? api.call('DELETE', `/api/v1/images/company/${company.id}`)
        : api.call('PUT', `/api/v1/images/company/${company.id}`, { image }),
    // The sidebar and the switcher show the logo from the user's details.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  // Only the details changed are sent.
  const [details, setDetails] = useState<Record<string, Value>>({});
  const save = useMutation({
    mutationFn: () =>
      api.call<Company>('PATCH', '/api/v1/settings/company', {
        name,
        numberGrouping: grouping,
        accentColor: color,
        ...(Object.keys(details).length === 0 ? {} : { details }),
      }),
    onSuccess: () => {
      setDetails({});
      void queryClient.invalidateQueries({ queryKey: ['settings', 'company'] });
      // The shell takes the accent and the grouping from the user's details.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const pick = (next: string | null) => {
    setColor(next);
    setTyped(next ?? '');
  };
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header>
        <h1 className="text-xl font-semibold">{t('company.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('company.intro')}</p>
      </header>
      <form
        className="grid gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <section className="grid gap-4 rounded-lg border bg-surface p-5">
          <h2 className="font-semibold">{t('company.identity')}</h2>
          <ImagePicker
            name={name}
            src={imageUrl('company', company.id, me.data?.logos?.[String(company.id)])}
            fit="logo"
            busy={logo.isPending}
            onChoose={(image) => logo.mutate(image)}
            onRemove={() => logo.mutate(null)}
          />
          {logo.error === null ? null : (
            <Alert tone="danger">
              {logo.error instanceof ApiError ? logo.error.message : String(logo.error)}
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('company.name')}</Label>
            <Input
              id={`${id}-name`}
              value={name}
              required
              onChange={(e) => setName(e.target.value)}
            />
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
        </section>

        {company.details.length === 0 ? null : (
          <section className="grid gap-4 rounded-lg border bg-surface p-5">
            <div>
              <h2 className="font-semibold">{t('company.details')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('company.detailsHint', { currency: company.currency })}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {company.details.map((d) => (
                <DetailField
                  key={d.key}
                  detail={d}
                  value={d.key in details ? (details[d.key] as Value) : d.value}
                  onChange={(v) => setDetails((all) => ({ ...all, [d.key]: v }))}
                />
              ))}
            </div>
          </section>
        )}

        <section className="grid gap-4 rounded-lg border bg-surface p-5">
          <div>
            <h2 className="font-semibold">{t('company.brand')}</h2>
            <p className="text-sm text-muted-foreground">{t('company.brandHint')}</p>
          </div>
          <fieldset className="grid gap-3">
            <legend className="sr-only">{t('company.brand')}</legend>
            <div className="flex flex-wrap gap-2">
              {SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={swatch}
                  aria-pressed={color === swatch}
                  onClick={() => pick(swatch)}
                  className="grid size-8 place-items-center rounded-full border-2 border-surface ring-1 ring-border"
                  style={{ background: swatch }}
                >
                  {color === swatch ? <Check className="size-4 text-white" aria-hidden /> : null}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-hex`}>{t('company.hex')}</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('company.picker')}
                    value={color ?? '#4f46e5'}
                    onChange={(e) => pick(e.target.value)}
                    className="size-9 cursor-pointer rounded-md border bg-surface p-1"
                  />
                  <Input
                    id={`${id}-hex`}
                    className="w-32 font-mono"
                    value={typed}
                    placeholder="#4f46e5"
                    aria-invalid={typed !== '' && !HEX.test(typed) ? true : undefined}
                    onChange={(e) => {
                      setTyped(e.target.value);
                      if (HEX.test(e.target.value)) setColor(e.target.value.toLowerCase());
                      if (e.target.value === '') setColor(null);
                    }}
                  />
                </div>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => pick(null)}>
                {t('company.default')}
              </Button>
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Preview color={color} dark={false} />
            <Preview color={color} dark />
          </div>
        </section>

        {save.error === null ? null : (
          <Alert tone="danger">
            {save.error instanceof ApiError ? save.error.message : String(save.error)}
          </Alert>
        )}
        {save.isSuccess ? <Alert tone="info">{t('company.saved')}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('company.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
