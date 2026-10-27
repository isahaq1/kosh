/**
 * "Fill from a document" next to "New" (RFC 0013 §5.5): paste a text or drop a PDF, an image or a text file; the
 * assistant proposes the new record's values, the form opens with them marked as proposals, and the user checks and
 * saves. What could not be used is said before the form opens. Hidden when the assistant is off.
 */
import { ApiError, Button, type CreateAssistProps, Dialog, Label, Textarea } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileScan } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantStatus } from './AskButton.js';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain';
const MAX_BYTES = 10_000_000;

interface Answer {
  readonly values?: Readonly<Record<string, unknown>>;
  readonly proposed?: readonly string[];
  readonly skipped?: readonly string[];
  readonly notes?: string;
  readonly refused?: boolean;
}

/** The file as base64 (without the data URL's prefix). */
const base64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export function FillButton({ api, model, onCreate }: CreateAssistProps): ReactElement | null {
  const { t } = useTranslation('assistant');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const status = useQuery({
    queryKey: ['assistant', 'status'],
    queryFn: () => api.call<AssistantStatus>('GET', '/api/v1/assistant'),
    retry: false,
    staleTime: 60_000,
  });
  const read = useMutation({
    mutationFn: async () =>
      api.call<Answer>('POST', '/api/v1/assistant/form', {
        model,
        text,
        ...(file === null
          ? {}
          : { file: { name: file.name, mediaType: file.type, data: await base64(file) } }),
      }),
    onSuccess: (result) => {
      setAnswer(result);
      const nothingToSay =
        (result.skipped ?? []).length === 0 &&
        (result.notes ?? '') === '' &&
        result.refused !== true;
      if (nothingToSay && (result.proposed ?? []).length > 0) finish(result);
    },
  });
  if (status.data === undefined || !status.data.available || !status.data.enabled) return null;
  const finish = (result: Answer) => {
    setOpen(false);
    setAnswer(null);
    setText('');
    setFile(null);
    onCreate(result.values ?? {}, result.proposed ?? []);
  };
  const tooBig = file !== null && file.size > MAX_BYTES;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <FileScan aria-hidden />
        {t('fill')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setAnswer(null);
        }}
        title={t('fillTitle')}
        description={t('fillIntro')}
        footer={
          answer !== null && answer.refused !== true && (answer.proposed ?? []).length > 0 ? (
            <Button variant="primary" onClick={() => finish(answer)}>
              {t('openProposal', { count: (answer.proposed ?? []).length })}
            </Button>
          ) : (
            <Button
              variant="primary"
              busy={read.isPending}
              disabled={(text.trim() === '' && file === null) || tooBig}
              onClick={() => read.mutate()}
            >
              {t('read')}
            </Button>
          )
        }
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-text`}>{t('paste')}</Label>
            <Textarea
              id={`${id}-text`}
              rows={6}
              maxLength={50_000}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setAnswer(null);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-file`}>{t('orFile')}</Label>
            <input
              id={`${id}-file`}
              type="file"
              accept={ACCEPT}
              className="block w-full text-sm"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setAnswer(null);
              }}
            />
            {tooBig ? <p className="text-xs text-danger">{t('tooBig')}</p> : null}
          </div>
          {read.isError ? (
            <p role="alert" className="text-sm text-danger">
              {read.error instanceof ApiError ? read.error.message : String(read.error)}
            </p>
          ) : null}
          {answer === null ? null : answer.refused === true ? (
            <p role="alert" className="text-sm text-danger">
              {t('refusedDocument')}
            </p>
          ) : (
            <div role="status" className="space-y-1 text-sm">
              <p>
                {(answer.proposed ?? []).length === 0
                  ? t('nothingFound')
                  : t('found', { count: (answer.proposed ?? []).length })}
              </p>
              {(answer.skipped ?? []).length === 0 ? null : (
                <ul className="list-disc ps-5 text-muted-foreground">
                  {(answer.skipped ?? []).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
              {(answer.notes ?? '') === '' ? null : (
                <p className="text-muted-foreground">{t('notes', { notes: answer.notes })}</p>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('fillGenerated')}</p>
        </div>
      </Dialog>
    </>
  );
}
