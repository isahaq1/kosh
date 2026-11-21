/**
 * "Read the CV" on an applicant (a node component of the applicant form; RFC 0034 §2.6): the AI assistant reads
 * the CV attached to the applicant and proposes what it says — the name, the email, the phone, a summary with the
 * experience, the education and the skills. Nothing is written by the assistant: the recruiter ticks what to
 * keep, and that is saved like any change of theirs. The server decides who may ask, and what may be saved.
 */
import { Alert, Button, Dialog, type NodeComponentProps } from '@kosh/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Proposal {
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly summary: string | null;
  readonly skills: readonly string[];
  readonly experienceYears: number | null;
  readonly education: string | null;
}
interface Read {
  readonly refused?: boolean;
  readonly file?: { readonly id: number; readonly name: string };
  readonly proposal?: Proposal;
  readonly current?: {
    readonly name: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly notes: string | null;
  };
}
const SIMPLE = ['name', 'email', 'phone'] as const;

export function CvButton({
  api,
  record,
  model,
  served,
  version,
  reload,
}: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('recruitment');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  const read = useMutation({
    mutationFn: () =>
      api.call<Read>('POST', `/api/v1/hiring/applicants/${String(record?.id)}/cv`, {}),
    onSuccess: (r) => {
      setError(null);
      // What differs from the applicant is offered; the summary goes into the notes unless unticked.
      setKeep({
        ...Object.fromEntries(
          SIMPLE.map((k) => [
            k,
            (r.proposal?.[k] ?? null) !== null && r.current?.[k] !== r.proposal?.[k],
          ]),
        ),
        notes: r.proposal !== undefined,
      });
      setOpen(true);
    },
    onError: (e) => {
      setError(e.message);
      setOpen(true);
    },
  });
  const proposal = read.data?.proposal;
  const current = read.data?.current;
  const notes = (p: Proposal): string => {
    const lines = [t('cv.heading', { file: read.data?.file?.name ?? '' })];
    if (p.summary !== null) lines.push(p.summary);
    if (p.experienceYears !== null) lines.push(`${t('cv.experience')}: ${p.experienceYears}`);
    if (p.education !== null) lines.push(`${t('cv.education')}: ${p.education}`);
    if (p.skills.length > 0) lines.push(`${t('cv.skills')}: ${p.skills.join(', ')}`);
    const before = (current?.notes ?? '').trim();
    return `${before === '' ? '' : `${before}\n\n`}${lines.join('\n')}`;
  };
  const save = useMutation({
    mutationFn: async () => {
      if (proposal === undefined || record === null) return;
      const values: Record<string, unknown> = {};
      for (const k of SIMPLE) if (keep[k] === true && proposal[k] !== null) values[k] = proposal[k];
      if (keep['notes'] === true) values['notes'] = notes(proposal);
      if (Object.keys(values).length > 0)
        await api.update(model, Number(record.id), values, version);
    },
    onSuccess: () => {
      setOpen(false);
      reload();
    },
    onError: (e) => setError(e.message),
  });
  if (record === null || typeof record.id !== 'number') return null;
  if (record['status'] !== 'active') return null;
  // Whoever cannot change the applicant's notes has nothing to keep of a CV.
  if (served.fields[model]?.['notes'] === undefined) return null;
  const tick = (key: string, label: string, value: string): ReactElement => (
    <label key={key} className="flex items-start gap-2 text-sm" htmlFor={`${id}-${key}`}>
      <input
        id={`${id}-${key}`}
        type="checkbox"
        className="mt-1"
        checked={keep[key] === true}
        onChange={(e) => setKeep({ ...keep, [key]: e.target.checked })}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block whitespace-pre-wrap text-muted-foreground">{value}</span>
      </span>
    </label>
  );
  return (
    <>
      <Button variant="secondary" busy={read.isPending} onClick={() => read.mutate()}>
        {t('cv.button')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('cv.title', { name: String(record['name'] ?? '') })}
        footer={
          proposal === undefined || error !== null ? undefined : (
            <Button
              variant="primary"
              busy={save.isPending}
              disabled={!Object.values(keep).some(Boolean)}
              onClick={() => save.mutate()}
            >
              {t('cv.keep')}
            </Button>
          )
        }
      >
        <div className="grid gap-3">
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          {error !== null ? null : read.data?.refused === true || proposal === undefined ? (
            <p className="text-sm">{t('cv.nothing')}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t('cv.explain', { file: read.data?.file?.name ?? '' })}
              </p>
              {SIMPLE.filter((k) => proposal[k] !== null && current?.[k] !== proposal[k]).map((k) =>
                tick(k, t(`cv.fields.${k}`), String(proposal[k])),
              )}
              {tick('notes', t('cv.fields.notes'), notes(proposal))}
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
