/**
 * Node components of the reporting module (placed in forms by view extensions):
 * - `reporting.Documents`: a "Print" menu with the record's templates, downloading the PDF.
 * - `reporting.ScheduleOutputs`: on a schedule's form, "Run now" and the outputs to download.
 */
import {
  Alert,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  type NodeComponentProps,
  useKosh,
} from '@isahaq/kosh-ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Play, Printer } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { saveDownload } from './shared.js';

export function Documents({ record, model, api }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('reporting');
  const [error, setError] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ['documents', model],
    queryFn: () =>
      api.call<{ templates: { id: number; name: string; scope: string }[] }>(
        'GET',
        `/api/v1/models/${model}/documents`,
      ),
  });
  const list = (templates.data?.templates ?? []).filter((tpl) => tpl.scope === 'record');
  if (record === null || list.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm">
            <Printer aria-hidden />
            {t('print')}
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuLabel>{t('print')}</MenuLabel>
          {list.map((tpl) => (
            <MenuItem
              key={tpl.id}
              onSelect={() =>
                void saveDownload(api, `/api/v1/models/${model}/documents/${tpl.id}`, {
                  ids: [record.id],
                }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              }
            >
              {tpl.name}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {error === null ? null : <Alert>{error}</Alert>}
    </div>
  );
}

export function ScheduleOutputs({ record, api }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('reporting');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const outputs = useQuery({
    queryKey: ['list', 'report.output', record?.id],
    queryFn: () =>
      api.list('report.output', {
        filter: { schedule: record?.id },
        fields: ['filename', 'size', 'createdAt'],
        order: ['id desc'],
        limit: 20,
      }),
    enabled: record !== null,
  });
  const run = useMutation({
    mutationFn: () =>
      api.call<{ output: number }>('POST', `/api/v1/reports/schedules/${record?.id}/run`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['list', 'report.output', record?.id] }),
  });
  if (record === null) return null;
  return (
    <section
      aria-labelledby="outputs-title"
      className="grid gap-2 rounded-lg border bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="outputs-title" className="text-sm font-semibold">
          {t('outputs')}
        </h2>
        <Button size="sm" variant="primary" busy={run.isPending} onClick={() => run.mutate()}>
          <Play aria-hidden />
          {t('runNow')}
        </Button>
      </div>
      {run.error === null ? null : <Alert>{run.error.message}</Alert>}
      <ul className="grid gap-1 text-sm">
        {(outputs.data?.items ?? []).map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-2">
            <span>
              {String(o['filename'])}{' '}
              <span className="text-muted-foreground">
                · {format.number(Math.round(Number(o['size']) / 1024))} KB ·{' '}
                {format.datetime(String(o['createdAt']))}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void saveDownload(api, `/api/v1/reports/outputs/${o.id}/download`, undefined, 'GET')
              }
            >
              <Download aria-hidden />
              {t('download')}
            </Button>
          </li>
        ))}
        {outputs.data !== undefined && outputs.data.items.length === 0 ? (
          <li className="text-muted-foreground">{t('noOutputs')}</li>
        ) : null}
      </ul>
    </section>
  );
}
