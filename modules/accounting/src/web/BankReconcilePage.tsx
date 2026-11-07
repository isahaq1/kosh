/**
 * Accounting › Reconcile bank (RFC 0029 §3.1): statements imported (CSV with its columns, OFX, CAMT.053), then the
 * open lines one by one — the documents each may pay, proposed by the server with why, matched in one click; a line
 * that pays nothing written off to an account. J / K move between lines. The server proposes, matches and refuses.
 */
import { Alert, Button, Checkbox, Input, Label, type PageProps, Select, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Line {
  readonly id: number;
  readonly date: string;
  readonly label: string;
  readonly reference: string | null;
  readonly amount: string;
}
interface Proposal {
  readonly move: number;
  readonly name: string;
  readonly partner: string | null;
  readonly residual: string;
  readonly reasons: readonly string[];
}

export function BankReconcilePage({ api, label }: PageProps): ReactElement {
  const { t } = useTranslation('accounting');
  const { format } = useKosh();
  const id = useId();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(0);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [account, setAccount] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Import
  const [journal, setJournal] = useState<string | null>(null);
  const [fileFormat, setFileFormat] = useState('csv');
  const [columns, setColumns] = useState({ date: 'Date', label: 'Details', amount: 'Amount' });

  const journals = useQuery({
    queryKey: ['accounting', 'journals', 'bank'],
    queryFn: () =>
      api.list('account.journal', {
        filter: { type: { in: ['bank', 'cash'] } },
        fields: ['id', 'code', 'name'],
        limit: 50,
      }),
  });
  const accounts = useQuery({
    queryKey: ['accounting', 'accounts', 'all'],
    queryFn: () =>
      api.list('account.account', {
        fields: ['id', 'code', 'name'],
        order: ['code asc'],
        limit: 500,
      }),
  });
  const lines = useQuery({
    queryKey: ['accounting', 'statement-lines', 'open'],
    queryFn: () =>
      api.list('account.bank.statement.line', {
        filter: { state: 'open' },
        fields: ['id', 'date', 'label', 'reference', 'amount'],
        order: ['date asc', 'id asc'],
        limit: 200,
      }),
  });
  const open = (lines.data?.items ?? []) as unknown as Line[];
  const line = open[Math.min(current, Math.max(0, open.length - 1))];
  const proposals = useQuery({
    queryKey: ['accounting', 'proposals', line?.id],
    queryFn: () =>
      api.call<{ proposals: Proposal[] }>(
        'GET',
        `/api/v1/accounting/statement-lines/${line?.id}/proposals`,
      ),
    enabled: line !== undefined,
  });
  // A new line: the best proposal chosen, the rest not.
  useEffect(() => {
    const best = proposals.data?.proposals[0];
    setChosen(new Set(best === undefined ? [] : [best.move]));
  }, [proposals.data]);
  // J / K: the next and the previous line.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      if (e.key === 'j') setCurrent((c) => Math.min(c + 1, Math.max(0, open.length - 1)));
      if (e.key === 'k') setCurrent((c) => Math.max(c - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open.length]);

  const done = async (text: string) => {
    setMessage(text);
    await queryClient.invalidateQueries({ queryKey: ['accounting'] });
  };
  const match = useMutation({
    mutationFn: () =>
      api.call('POST', `/api/v1/accounting/statement-lines/${line?.id}/match`, {
        moves: [...chosen],
      }),
    onSuccess: () => done(t('bank.matched')),
  });
  const writeOff = useMutation({
    mutationFn: () =>
      api.call('POST', `/api/v1/accounting/statement-lines/${line?.id}/write-off`, {
        account: Number(account),
      }),
    onSuccess: () => done(t('bank.writtenOff')),
  });
  const importFile = useMutation({
    mutationFn: async (file: File) =>
      api.call<{ created: number; skipped: number }>(
        'POST',
        '/api/v1/accounting/statements/import',
        {
          journal: Number(journal),
          format: fileFormat,
          content: await file.text(),
          ...(fileFormat === 'csv' ? { mapping: columns } : {}),
        },
      ),
    onSuccess: (r) => done(t('bank.imported', { created: r.created, skipped: r.skipped })),
  });
  const error = match.error ?? writeOff.error ?? importFile.error;

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4">
      <h1 id={`${id}-title`} className="text-lg font-semibold">
        {label ?? t('bank.title')}
      </h1>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-medium">{t('bank.import')}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Select
            id={`${id}-journal`}
            label={t('bank.journal')}
            value={journal}
            options={(
              (journals.data?.items ?? []) as { id: number; code: string; name: string }[]
            ).map((j) => ({ value: String(j.id), label: `${j.code} ${j.name}` }))}
            onChange={setJournal}
          />
          <Select
            id={`${id}-format`}
            label={t('bank.format')}
            value={fileFormat}
            options={[
              { value: 'csv', label: 'CSV' },
              { value: 'ofx', label: 'OFX' },
              { value: 'camt', label: 'CAMT.053' },
            ]}
            onChange={setFileFormat}
          />
          {fileFormat === 'csv'
            ? (['date', 'label', 'amount'] as const).map((key) => (
                <div key={key} className="grid gap-1">
                  <Label htmlFor={`${id}-${key}`}>{t(`bank.column.${key}`)}</Label>
                  <Input
                    id={`${id}-${key}`}
                    value={columns[key]}
                    onChange={(e) => setColumns({ ...columns, [key]: e.target.value })}
                  />
                </div>
              ))
            : null}
          <div className="grid gap-1">
            <Label htmlFor={`${id}-file`}>{t('bank.file')}</Label>
            <input
              id={`${id}-file`}
              type="file"
              disabled={journal === null || importFile.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) importFile.mutate(file);
              }}
            />
          </div>
        </div>
      </details>
      {message === null ? null : <Alert tone="info">{message}</Alert>}
      {error === null ? null : <Alert>{error.message}</Alert>}
      {line === undefined ? (
        <p className="text-sm text-muted-foreground">{t('bank.nothingOpen')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <ol aria-label={t('bank.lines')} className="grid content-start gap-1">
            {open.map((l, i) => (
              <li key={l.id}>
                <button
                  type="button"
                  aria-current={l.id === line.id}
                  className={`w-full rounded-md px-2 py-1 text-start text-sm ${l.id === line.id ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
                  onClick={() => setCurrent(i)}
                >
                  <span className="block truncate">{l.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {format.date(l.date)} · {l.amount}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className="grid content-start gap-3">
            <div className="rounded-md border p-3">
              <p className="font-medium">{line.label}</p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {format.date(line.date)} · {line.reference ?? ''} · {line.amount}
              </p>
            </div>
            <fieldset className="grid gap-2">
              <legend className="font-medium">{t('bank.proposals')}</legend>
              {(proposals.data?.proposals ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('bank.noProposal')}</p>
              ) : (
                (proposals.data?.proposals ?? []).map((p) => (
                  <div
                    key={p.move}
                    className="flex items-start gap-2 rounded-md border p-2 text-sm"
                  >
                    <Checkbox
                      id={`${id}-proposal-${p.move}`}
                      checked={chosen.has(p.move)}
                      onCheckedChange={(on) => {
                        const next = new Set(chosen);
                        if (on === true) next.add(p.move);
                        else next.delete(p.move);
                        setChosen(next);
                      }}
                    />
                    <label htmlFor={`${id}-proposal-${p.move}`} className="grid gap-0.5">
                      <span className="font-medium">
                        {p.name} · {p.partner ?? ''} ·{' '}
                        <span className="tabular-nums">{p.residual}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t('bank.because', { reasons: p.reasons.join(', ') })}
                      </span>
                    </label>
                  </div>
                ))
              )}
              <div>
                <Button
                  variant="primary"
                  disabled={chosen.size === 0}
                  busy={match.isPending}
                  onClick={() => match.mutate()}
                >
                  {t('bank.match')}
                </Button>
              </div>
            </fieldset>
            <fieldset className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <legend className="font-medium">{t('bank.writeOff')}</legend>
              <Select
                id={`${id}-account`}
                label={t('bank.account')}
                value={account}
                options={(
                  (accounts.data?.items ?? []) as { id: number; code: string; name: string }[]
                ).map((a) => ({ value: String(a.id), label: `${a.code} ${a.name}` }))}
                onChange={setAccount}
              />
              <Button
                disabled={account === null}
                busy={writeOff.isPending}
                onClick={() => writeOff.mutate()}
              >
                {t('bank.writeOffConfirm')}
              </Button>
            </fieldset>
            <p className="text-xs text-muted-foreground">{t('bank.keys')}</p>
          </div>
        </div>
      )}
    </section>
  );
}
