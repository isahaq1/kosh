/**
 * On a draft invoice or bill (RFC 0029 §3.5): what posting will do — the fiscal position and why it applies, each
 * line's taxes after the mapping and its account with where it came from (the line, the product, its category, the
 * journal), and the receivable or payable account. The server decides; this only shows it.
 */
import type { NodeComponentProps } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

interface Preview {
  readonly position: { readonly name: string } | null;
  readonly why: string;
  readonly lines: readonly {
    readonly id: number;
    readonly name: string;
    readonly taxesBefore: readonly string[];
    readonly taxesAfter: readonly string[];
    readonly account: string | null;
    readonly source: string;
    readonly mapped: boolean;
  }[];
  readonly counterpart: {
    readonly account: string | null;
    readonly source: string;
    readonly mapped: boolean;
  };
}

export function PostingPreview({ record, api, version }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('accounting');
  const id = useId();
  const draft = record !== null && record['state'] === 'draft' && record['kind'] !== 'entry';
  const preview = useQuery({
    queryKey: ['accounting', 'preview', record?.id, version],
    queryFn: () => api.call<Preview>('GET', `/api/v1/accounting/moves/${record?.id}/preview`),
    enabled: draft,
  });
  const p = preview.data;
  if (!draft || p === undefined || p.lines.length === 0) return null;
  const source = (s: string) => t(`preview.source.${s}`, { defaultValue: s });
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2 rounded-md border p-3 text-sm">
      <h3 id={`${id}-title`} className="font-medium">
        {t('preview.title')}
      </h3>
      <p className="text-muted-foreground">
        {p.position === null
          ? t('preview.noPosition')
          : t('preview.position', { name: p.position.name, why: p.why })}
      </p>
      <ul className="grid gap-1">
        {p.lines.map((l) => (
          <li key={l.id}>
            <span className="font-medium">{l.name}</span>
            {' · '}
            {l.taxesBefore.join(', ') === l.taxesAfter.join(', ')
              ? l.taxesAfter.join(', ') || t('preview.noTax')
              : `${l.taxesBefore.join(', ') || t('preview.noTax')} → ${l.taxesAfter.join(', ') || t('preview.noTax')}`}
            {' · '}
            {l.account ?? t('preview.noAccount')}{' '}
            <span className="text-muted-foreground">
              ({source(l.source)}
              {l.mapped ? `, ${t('preview.mapped')}` : ''})
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        {t('preview.counterpart', {
          account: p.counterpart.account ?? t('preview.noAccount'),
          source: source(p.counterpart.source),
        })}
        {p.counterpart.mapped ? `, ${t('preview.mapped')}` : ''}
      </p>
    </section>
  );
}
