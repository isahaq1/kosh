/**
 * Counting from a phone (a node component of the count form): while the count is counting, a barcode box — a
 * scanner or the keyboard types into it, Enter adds — and, where the browser can read barcodes, the camera. Each scan
 * goes to `POST /api/v1/stockroom/counts/:id/scan` and the form reloads its lines; the last result is announced.
 */
import { Alert, Button, Input, Label, type NodeComponentProps } from '@kosh/ui';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The browser's barcode reader (Chrome on Android, among others); not in TypeScript's DOM library yet. */
interface BarcodeReader {
  detect(source: HTMLVideoElement): Promise<readonly { readonly rawValue: string }[]>;
}
type ReaderClass = new () => BarcodeReader;
const readerClass = (): ReaderClass | undefined =>
  (globalThis as { BarcodeDetector?: ReaderClass }).BarcodeDetector;

export function ScanBox({ api, record, reload }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('stock');
  const id = useId();
  const [barcode, setBarcode] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const last = useRef<{ code: string; at: number } | null>(null);

  const send = async (code: string): Promise<void> => {
    if (record === null || code.trim() === '') return;
    try {
      const answer = await api.call<{ product: string; lot?: string; counted: string }>(
        'POST',
        `/api/v1/stockroom/counts/${String(record.id)}/scan`,
        { barcode: code.trim(), quantity },
      );
      setError(null);
      setResult(
        t('scan.counted', {
          product: answer.lot === undefined ? answer.product : `${answer.product} ${answer.lot}`,
          counted: answer.counted,
        }),
      );
      setBarcode('');
      reload();
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The camera: a frame read every half second; the same code is taken once every two seconds.
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
            const code = codes[0]?.rawValue;
            if (code === undefined) return;
            const now = Date.now();
            if (last.current?.code === code && now - last.current.at < 2000) return;
            last.current = { code, at: now };
            void send(code);
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

  if (record === null || record['state'] !== 'counting') return null;
  return (
    <section className="grid gap-2 rounded-md border p-3" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="text-sm font-medium">
        {t('scan.title')}
      </h3>
      {/* Not a <form>: it sits inside the record's form. Enter in the barcode box adds, as a scanner sends it. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-40 flex-1 gap-1">
          <Label htmlFor={`${id}-barcode`}>{t('scan.barcode')}</Label>
          <Input
            id={`${id}-barcode`}
            value={barcode}
            autoComplete="off"
            inputMode="numeric"
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              void send(barcode);
            }}
          />
        </div>
        <div className="grid w-24 gap-1">
          <Label htmlFor={`${id}-quantity`}>{t('scan.quantity')}</Label>
          <Input
            id={`${id}-quantity`}
            value={quantity}
            inputMode="decimal"
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <Button type="button" variant="primary" onClick={() => void send(barcode)}>
          {t('scan.add')}
        </Button>
        {readerClass() === undefined ? null : (
          <Button type="button" variant="secondary" onClick={() => setCamera((c) => !c)}>
            {camera ? t('scan.stop') : t('scan.camera')}
          </Button>
        )}
      </div>
      {camera ? (
        // biome-ignore lint/a11y/useMediaCaption: a live camera preview has no captions
        <video ref={video} className="max-h-64 w-full rounded-md bg-black" playsInline muted />
      ) : null}
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {result}
      </p>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
    </section>
  );
}
