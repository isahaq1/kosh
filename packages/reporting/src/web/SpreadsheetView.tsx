/**
 * The spreadsheet view: sheets are `report.spreadsheet` records (private, or shared). A grid of cells with values
 * and formulas (see `formula.ts`); `REPORT(model, measure, domain?)` cells are live report totals fetched within the
 * user's rules, so a sheet updates with the data. Keyboard: arrows move, Enter edits / commits, Escape cancels.
 */
import { Alert, Button, Input, Spinner, useKosh, type ViewProps } from '@kosh/ui';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Cells, columnName, evaluateSheet, reportCalls } from './formula.js';
import type { ReportResult } from './shared.js';

const COLS = 12;
const ROWS = 40;
const ROW_NUMBERS = Array.from({ length: ROWS }, (_, r) => r);

function Sheet({ id, onBack }: { readonly id: number; readonly onBack: () => void }): ReactElement {
  const { api, format } = useKosh();
  const { t } = useTranslation('reporting');
  const queryClient = useQueryClient();
  const record = useQuery({
    queryKey: ['record', 'report.spreadsheet', id],
    queryFn: () => api.get('report.spreadsheet', id, ['name', 'cells']),
  });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [active, setActive] = useState('A1');
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const cells: Cells = draft ?? (record.data?.record['cells'] as Cells | undefined) ?? {};
  const calls = reportCalls(cells);
  const totals = useQueries({
    queries: calls.map((c) => {
      const [op, field] = c.measure.split(':');
      const measure = op === 'count' || field === undefined ? 'count' : { [op as string]: field };
      return {
        queryKey: ['report', c.model, 'total', c.measure, c.domain],
        queryFn: () =>
          api.call<ReportResult>('POST', `/api/v1/models/${encodeURIComponent(c.model)}/report`, {
            rows: [],
            measures: { v: measure },
            ...(c.domain === undefined ? {} : { where: c.domain }),
          }),
      };
    }),
  });
  const callKeys = JSON.stringify(calls.map((c) => c.key));
  const data = totals.map((q) => q.data);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when any total arrives
  const reports = useMemo(() => {
    const m = new Map<string, number | string>();
    calls.forEach((c, i) => {
      const v = totals[i]?.data?.cells['[]']?.['[]']?.['v'];
      if (v === undefined || v === null) return;
      m.set(
        c.key,
        typeof v === 'number' ? v : typeof v === 'string' ? v : Number(v[0]?.amount ?? 0),
      );
    });
    return m;
  }, [callKeys, ...data]);
  const values = useMemo(() => evaluateSheet(cells, reports), [cells, reports]);
  const save = useMutation({
    mutationFn: () => api.update('report.spreadsheet', id, { cells }, record.data?.etag ?? null),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['record', 'report.spreadsheet', id] });
    },
  });
  if (record.isError) return <Alert>{record.error.message}</Alert>;
  if (record.data === undefined) return <Spinner label="…" />;

  const commit = (ref: string, value: string) => {
    const next = { ...cells };
    if (value === '') delete next[ref];
    else next[ref] = value;
    setDraft(next);
    setEditing(null);
  };
  const moveBy = (dc: number, dr: number) => {
    const m = /^([A-Z]+)(\d+)$/.exec(active);
    if (m === null) return;
    const c = Math.max(
      0,
      Math.min(
        COLS - 1,
        [...(m[1] as string)].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 + dc,
      ),
    );
    const r = Math.max(1, Math.min(ROWS, Number(m[2]) + dr));
    const ref = `${columnName(c)}${r}`;
    setActive(ref);
    document.getElementById(`cell-${ref}`)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, ref: string) => {
    if (editing === ref) {
      if (e.key === 'Enter') {
        commit(ref, text);
        moveBy(0, 1);
      } else if (e.key === 'Escape') setEditing(null);
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const move = moves[e.key];
    if (move !== undefined) {
      e.preventDefault();
      moveBy(...move);
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      setText(cells[ref] ?? '');
      setEditing(ref);
    } else if (e.key === 'Delete' || e.key === 'Backspace') commit(ref, '');
  };
  const show = (v: unknown) =>
    typeof v === 'number'
      ? format.number(Math.round(v * 100) / 100)
      : v === true
        ? 'TRUE'
        : v === false
          ? 'FALSE'
          : String(v ?? '');

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ←
        </Button>
        <h2 className="text-base font-semibold">{String(record.data.record['name'])}</h2>
        <span className="ms-2 font-mono text-xs text-muted-foreground" aria-live="polite">
          {active}: {cells[active] ?? ''}
        </span>
        <Button
          size="sm"
          variant="primary"
          className="ms-auto"
          disabled={draft === null}
          busy={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('save')}
        </Button>
      </div>
      {save.error === null ? null : <Alert>{save.error.message}</Alert>}
      <div className="max-h-[calc(100vh-16rem)] overflow-auto rounded-lg border bg-surface">
        <table aria-label={String(record.data.record['name'])} className="border-collapse text-sm">
          <thead className="sticky top-0 bg-muted">
            <tr>
              <th className="w-10 border-e border-b" aria-hidden />
              {Array.from({ length: COLS }, (_, c) => (
                <th
                  key={columnName(c)}
                  scope="col"
                  className="w-28 border-e border-b px-1 text-xs font-medium text-muted-foreground"
                >
                  {columnName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROW_NUMBERS.map((r) => (
              <tr key={r}>
                <th
                  scope="row"
                  className="border-e border-b bg-muted px-1 text-xs font-medium text-muted-foreground"
                >
                  {r + 1}
                </th>
                {Array.from({ length: COLS }, (_, c) => {
                  const ref = `${columnName(c)}${r + 1}`;
                  const value = values[ref];
                  const error = typeof value === 'string' && value.startsWith('#');
                  return (
                    <td
                      key={ref}
                      id={`cell-${ref}`}
                      tabIndex={ref === active ? 0 : -1}
                      aria-label={ref}
                      data-active={ref === active ? 'true' : undefined}
                      className={`h-7 w-28 border-e border-b px-1 text-end tabular-nums ${ref === active ? 'outline outline-2 -outline-offset-2 outline-ring' : ''} ${error ? 'text-danger' : ''}`}
                      onClick={() => setActive(ref)}
                      onDoubleClick={() => {
                        setText(cells[ref] ?? '');
                        setEditing(ref);
                      }}
                      onKeyDown={(e) => onKey(e, ref)}
                    >
                      {editing === ref ? (
                        <Input
                          autoFocus
                          aria-label={`${t('formula')} ${ref}`}
                          className="h-6 px-1 text-start font-mono"
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                          onBlur={() => commit(ref, text)}
                        />
                      ) : (
                        show(value)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SpreadsheetView(_props: ViewProps): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation('reporting');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [name, setName] = useState('');
  const sheets = useQuery({
    queryKey: ['list', 'report.spreadsheet'],
    queryFn: () => api.list('report.spreadsheet', { fields: ['name', 'shared'] }),
  });
  const create = useMutation({
    mutationFn: () => api.create('report.spreadsheet', { name, cells: {} }),
    onSuccess: async (r) => {
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['list', 'report.spreadsheet'] });
      setOpen(r.record.id);
    },
  });
  if (open !== null) return <Sheet id={open} onBack={() => setOpen(null)} />;
  return (
    <div className="grid gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== '') create.mutate();
        }}
      >
        <Input
          aria-label={t('name')}
          placeholder={t('newSheet')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" variant="primary" size="sm" busy={create.isPending}>
          <Plus aria-hidden />
          {t('newSheet')}
        </Button>
      </form>
      {sheets.isPending ? <Spinner label="…" /> : null}
      {(sheets.data?.items ?? []).length === 0 && !sheets.isPending ? (
        <p className="text-sm text-muted-foreground">{t('noSheets')}</p>
      ) : null}
      <ul className="grid gap-1">
        {(sheets.data?.items ?? []).map((s) => (
          <li key={s.id}>
            <Button variant="link" onClick={() => setOpen(s.id)}>
              {String(s['name'])}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
