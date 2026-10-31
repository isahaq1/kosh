/**
 * The live preview of a page (a node component of the page form): the page as its visitors will see it, draft or
 * published, from `GET /api/v1/sites/pages/:id/preview` — in a frame that runs no scripts, refreshed after each save.
 */
import type { NodeComponentProps } from '@kosh/ui';
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function PagePreview({ api, record, version }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('website');
  const id = typeof record?.['id'] === 'number' ? record['id'] : null;
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetched when the record is saved (its version)
  useEffect(() => {
    if (id === null) return;
    let live = true;
    api
      .call<{ html: string }>('GET', `/api/v1/sites/pages/${id}/preview`)
      .then((answer) => {
        if (!live) return;
        setHtml(answer.html);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [id, version]);

  if (id === null) return <p className="text-sm text-muted-foreground">{t('preview.save')}</p>;
  return (
    <section aria-label={t('preview.title')} className="grid gap-2">
      <h3 className="text-sm font-semibold">{t('preview.title')}</h3>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <iframe
          title={t('preview.title')}
          sandbox=""
          srcDoc={html ?? ''}
          className="h-[480px] w-full rounded-md border bg-white"
        />
      )}
    </section>
  );
}
