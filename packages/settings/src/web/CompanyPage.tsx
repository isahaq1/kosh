/**
 * Settings › Company (RFC 0018): the current company's name, number grouping and brand colour — the back-office's
 * accent for everyone in the company. The preview shows the colour as buttons, links and selections take it, in
 * light and dark; the themes keep text readable whatever colour is chosen.
 */
import {
  Alert,
  ApiError,
  accentVariables,
  Badge,
  Button,
  Input,
  Label,
  type PageProps,
  Select,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { type CSSProperties, type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Company {
  readonly id: number;
  readonly name: string;
  readonly numberGrouping: 'international' | 'lakh';
  readonly accentColor: string | null;
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
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const company = useQuery({
    queryKey: ['settings', 'company'],
    queryFn: () => api.call<Company>('GET', '/api/v1/settings/company'),
  });
  const [name, setName] = useState('');
  const [grouping, setGrouping] = useState<Company['numberGrouping']>('international');
  const [color, setColor] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (company.data === undefined) return;
    setName(company.data.name);
    setGrouping(company.data.numberGrouping);
    setColor(company.data.accentColor);
    setTyped(company.data.accentColor ?? '');
  }, [company.data]);
  const save = useMutation({
    mutationFn: () =>
      api.call<Company>('PATCH', '/api/v1/settings/company', {
        name,
        numberGrouping: grouping,
        accentColor: color,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'company'] });
      // The shell takes the accent and the grouping from the user's details.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (company.error !== null)
    return (
      <Alert tone="danger">
        {company.error instanceof ApiError ? company.error.message : String(company.error)}
      </Alert>
    );
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
          <Button
            type="submit"
            variant="primary"
            busy={save.isPending}
            disabled={company.data === undefined}
          >
            {t('company.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
