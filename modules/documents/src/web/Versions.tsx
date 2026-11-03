/**
 * The versions of a document on its form (RFC 0024 §2.8): each upload a new version, the latest the current one;
 * every version can be downloaded. The server stores the file and keeps the count; this only shows and sends it.
 */
import { Alert, Button, type NodeComponentProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface Version {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly at: string;
}

export function Versions({ record, api }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('documents');
  const { format } = useKosh();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const doc = typeof record?.['id'] === 'number' ? record['id'] : null;
  const versions = useQuery({
    queryKey: ['documents', 'versions', doc],
    queryFn: () =>
      api.call<{ versions: Version[] }>('GET', `/api/v1/documents/${String(doc)}/versions`),
    enabled: doc !== null,
  });
  const upload = useMutation({
    mutationFn: (file: File) =>
      api.upload<{ versions: number }>(
        `/api/v1/documents/${String(doc)}/versions`,
        file,
        file.name,
      ),
    onSuccess: async () => {
      if (input.current !== null) input.current.value = '';
      await versions.refetch();
    },
  });
  if (doc === null) return <p className="text-sm text-muted-foreground">{t('saveFirst')}</p>;
  const rows = versions.data?.versions ?? [];
  return (
    <section aria-labelledby={`${id}-title`} className="col-span-full grid gap-2">
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {t('versions')}
      </h3>
      <div className="flex items-center gap-2">
        <input
          ref={input}
          id={`${id}-file`}
          type="file"
          aria-label={t('newVersion')}
          className="text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) upload.mutate(file);
          }}
        />
        {upload.isPending ? <span className="text-sm">{t('uploading')}</span> : null}
      </div>
      {upload.error === null ? null : <Alert tone="danger">{upload.error.message}</Alert>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noVersion')}</p>
      ) : (
        <ul className="grid gap-1 text-sm">
          {rows.map((v, i) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t('version', { n: rows.length - i })}</span>
              <span>{v.name}</span>
              <span className="text-muted-foreground">
                {format.decimal(String(Math.ceil(v.size / 1024)))} KB · {format.date(v.at)}
              </span>
              <Button
                variant="secondary"
                onClick={async () => {
                  const { blob, filename } = await api.download(
                    `/api/v1/attachments/${v.id}/download`,
                    undefined,
                    'GET',
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = filename;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                {t('download')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
