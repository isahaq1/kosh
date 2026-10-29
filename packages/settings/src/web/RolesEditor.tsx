/**
 * A person's roles as people think of them (RFC 0019 §3.2): per app, one access level (*No access · User · Manager*),
 * per company when there are several; other roles (runtime roles, Administrator) as checkboxes. It edits the
 * assignments `{ group, company }` the server stores; the server checks every one.
 */
import { Checkbox, Label, Select } from '@kosh/ui';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface Assignment {
  readonly group: string;
  readonly company: number | null;
}
export interface Catalogue {
  readonly apps: readonly {
    readonly module: string;
    readonly label: string;
    /** A real app (in the sidebar), or a technical module (storage, notifications…). */
    readonly app: boolean;
    readonly levels: readonly {
      readonly key: string;
      readonly label: string;
      readonly groups: readonly string[];
    }[];
  }[];
  readonly roles: readonly {
    readonly code: string;
    readonly label: string;
    readonly administrator: boolean;
  }[];
  readonly companies: readonly { readonly id: number; readonly name: string }[];
  readonly manager: { readonly administrator: boolean };
}

/** "No access" (the select takes no empty value). */
const NONE = 'none';

export function RolesEditor({
  catalogue,
  value,
  onChange,
}: {
  readonly catalogue: Catalogue;
  readonly value: readonly Assignment[];
  readonly onChange: (next: Assignment[]) => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const several = catalogue.companies.length > 1;
  const [company, setCompany] = useState<number | null>(null);
  const here = value.filter((a) => a.company === company);
  const has = (group: string) => here.some((a) => a.group === group);
  const levelGroups = new Set(catalogue.apps.flatMap((a) => a.levels.flatMap((l) => l.groups)));
  /** The app's level: the last declared whose groups the person all holds (levels go up). */
  const levelOf = (app: Catalogue['apps'][number]) =>
    [...app.levels].reverse().find((l) => l.groups.every(has))?.key ?? NONE;
  const setLevel = (app: Catalogue['apps'][number], key: string) => {
    const appGroups = new Set(app.levels.flatMap((l) => l.groups));
    const kept = value.filter((a) => a.company !== company || !appGroups.has(a.group));
    const level = app.levels.find((l) => l.key === key);
    onChange([...kept, ...(level?.groups ?? []).map((group) => ({ group, company }))]);
  };
  const toggle = (group: string, on: boolean) =>
    onChange(
      on
        ? [...value, { group, company }]
        : value.filter((a) => !(a.company === company && a.group === group)),
    );
  const others = catalogue.roles.filter(
    (r) => !levelGroups.has(r.code) && r.code !== 'base.user' && !r.code.startsWith('base.'),
  );
  const admins = catalogue.roles.filter((r) => r.administrator);
  return (
    <div className="grid gap-4">
      {several ? (
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor={`${id}-company`}>{t('people.rolesIn')}</Label>
          <Select
            id={`${id}-company`}
            label={t('people.rolesIn')}
            value={company === null ? 'all' : String(company)}
            options={[
              { value: 'all', label: t('people.everyCompany') },
              ...catalogue.companies.map((c) => ({ value: String(c.id), label: c.name })),
            ]}
            onChange={(v) => setCompany(v === 'all' ? null : Number(v))}
          />
        </div>
      ) : null}
      {[
        { key: 'apps', list: catalogue.apps.filter((a) => a.app) },
        { key: 'technical', list: catalogue.apps.filter((a) => !a.app) },
      ].map(({ key, list }) =>
        list.length === 0 ? null : key === 'apps' ? (
          <ul key={key} className="divide-y rounded-md border">
            {list.map((app) => (
              <li
                key={app.module}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <Label htmlFor={`${id}-${app.module}`} className="font-medium">
                  {app.label}
                </Label>
                <Select
                  id={`${id}-${app.module}`}
                  label={app.label}
                  className="w-48"
                  value={levelOf(app)}
                  options={[
                    { value: NONE, label: t('people.noAccess') },
                    ...app.levels.map((l) => ({ value: l.key, label: l.label })),
                  ]}
                  onChange={(v) => setLevel(app, v)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <details key={key} className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-sm">{t('people.technical')}</summary>
            <ul className="divide-y border-t">
              {list.map((app) => (
                <li
                  key={app.module}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                >
                  <Label htmlFor={`${id}-${app.module}`} className="font-medium">
                    {app.label}
                  </Label>
                  <Select
                    id={`${id}-${app.module}`}
                    label={app.label}
                    className="w-48"
                    value={levelOf(app)}
                    options={[
                      { value: NONE, label: t('people.noAccess') },
                      ...app.levels.map((l) => ({ value: l.key, label: l.label })),
                    ]}
                    onChange={(v) => setLevel(app, v)}
                  />
                </li>
              ))}
            </ul>
          </details>
        ),
      )}
      {[...admins, ...others.filter((r) => !r.administrator)].length === 0 ? null : (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t('people.otherRoles')}</legend>
          {[...admins, ...others.filter((r) => !r.administrator)].map((r) => {
            const locked = r.administrator && !catalogue.manager.administrator;
            return (
              <div key={r.code} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`${id}-role-${r.code}`}
                  checked={has(r.code)}
                  disabled={locked}
                  onCheckedChange={(c) => toggle(r.code, c === true)}
                />
                <Label htmlFor={`${id}-role-${r.code}`}>{r.label}</Label>
                {r.administrator ? (
                  <span className="text-xs text-muted-foreground">
                    {t('people.administratorHint')}
                  </span>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
