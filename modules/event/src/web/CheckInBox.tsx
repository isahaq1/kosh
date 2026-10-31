/**
 * Check-in at the door (a node component of the event form): while the event is open, a code box — a scanner or the
 * keyboard types into it, Enter checks in — and, where the browser reads codes, the phone's camera scanning the QR on
 * the ticket. Each code goes to `POST /api/v1/eventhub/checkin`; the result (who, which ticket, or why not) is
 * announced, and the form reloads its counts.
 */
import { Alert, Button, Input, Label, type NodeComponentProps } from '@kosh/ui';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The browser's barcode reader (QR included); not in TypeScript's DOM library yet. */
interface CodeReader {
  detect(source: HTMLVideoElement): Promise<readonly { readonly rawValue: string }[]>;
}
type ReaderClass = new () => CodeReader;
const readerClass = (): ReaderClass | undefined =>
  (globalThis as { BarcodeDetector?: ReaderClass }).BarcodeDetector;

export function CheckInBox({ api, record, reload }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('event');
  const id = useId();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const last = useRef<{ code: string; at: number } | null>(null);

  const send = async (value: string): Promise<void> => {
    if (value.trim() === '') return;
    try {
      const answer = await api.call<{ name: string; ticket: string | null }>(
        'POST',
        '/api/v1/eventhub/checkin',
        { code: value.trim() },
      );
      setError(null);
      setResult(t('checkin.done', { name: answer.name, ticket: answer.ticket ?? '' }));
      setCode('');
      reload();
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The camera: a frame read every half second; the same code is taken once every three seconds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts only when the camera is switched
  useEffect(() => {
    const Reader = readerClass();
    if (!camera || Reader === undefined) return;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const reader = new Reader();
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s;
        if (video.current === null) return;
        video.current.srcObject = s;
        void video.current.play();
        timer = setInterval(() => {
          if (video.current === null) return;
          void reader.detect(video.current).then((codes) => {
            const found = codes[0]?.rawValue;
            if (found === undefined) return;
            const now = Date.now();
            if (last.current?.code === found && now - last.current.at < 3000) return;
            last.current = { code: found, at: now };
            void send(found);
          });
        }, 500);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setCamera(false);
      });
    return () => {
      if (timer !== undefined) clearInterval(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [camera]);

  if (record === null || record['state'] !== 'published') return null;
  return (
    <section className="grid gap-2 rounded-md border p-3" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="text-sm font-medium">
        {t('checkin.title')}
      </h3>
      {/* Not a <form>: it sits inside the record's form. Enter checks in, as a scanner sends it. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-48 flex-1 gap-1">
          <Label htmlFor={`${id}-code`}>{t('checkin.code')}</Label>
          <Input
            id={`${id}-code`}
            value={code}
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              void send(code);
            }}
          />
        </div>
        <Button type="button" variant="primary" onClick={() => void send(code)}>
          {t('checkin.go')}
        </Button>
        {readerClass() === undefined ? null : (
          <Button type="button" variant="secondary" onClick={() => setCamera((c) => !c)}>
            {camera ? t('checkin.stop') : t('checkin.camera')}
          </Button>
        )}
      </div>
      {camera ? (
        <video ref={video} className="max-h-64 w-full rounded-md bg-black" playsInline muted />
      ) : null}
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {result}
      </p>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
    </section>
  );
}
