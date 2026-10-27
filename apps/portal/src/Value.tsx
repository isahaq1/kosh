/** A field's value as the portal shows it: dates and amounts in the user's language, choices by their label. */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { type FieldMeta, usePortal } from './portal.js';

export function Value({
  field,
  value,
}: {
  readonly field: FieldMeta;
  readonly value: unknown;
}): ReactElement {
  const { format } = usePortal();
  const { t } = useTranslation('portal');
  if (value === null || value === undefined || value === '')
    return <span className="text-muted-foreground">—</span>;
  switch (field.kind) {
    case 'date':
      return <>{format.date(String(value))}</>;
    case 'datetime':
      return <>{format.datetime(String(value))}</>;
    case 'monetary': {
      const money = value as { readonly amount?: string; readonly currency?: string };
      return (
        <span className="tabular-nums">
          {format.decimal(money.amount ?? String(value))} {money.currency ?? ''}
        </span>
      );
    }
    case 'decimal':
    case 'quantity':
      return <span className="tabular-nums">{format.decimal(String(value))}</span>;
    case 'integer':
    case 'float':
      return <span className="tabular-nums">{format.number(Number(value))}</span>;
    case 'boolean':
      return <>{value === true ? t('yes') : t('no')}</>;
    case 'selection':
    case 'state':
      return <>{field.options?.find((o) => o.value === value)?.label ?? String(value)}</>;
    case 'many2one':
      return <>{(value as { readonly name?: string }).name ?? ''}</>;
    case 'many2many':
      return <>{(value as readonly { readonly name: string }[]).map((v) => v.name).join(', ')}</>;
    case 'text':
      return <span className="whitespace-pre-line">{String(value)}</span>;
    default:
      return <>{String(value)}</>;
  }
}
