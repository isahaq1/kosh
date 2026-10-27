/**
 * A signature drawn with a finger, a pen or a mouse (pointer events), exported as a PNG. People who cannot draw
 * (keyboard, screen reader) use their typed name instead: it is written onto the pad in a handwriting style.
 */
import { Button } from '@kosh/ui';
import { type ReactElement, useRef } from 'react';
import { useTranslation } from 'react-i18next';

const WIDTH = 480;
const HEIGHT = 160;

export function SignaturePad({
  name,
  onChange,
}: {
  /** The typed name, for "use my typed name". */
  readonly name: string;
  /** The PNG data URL, or null when empty. */
  readonly onChange: (image: string | null) => void;
}): ReactElement {
  const { t } = useTranslation('portal');
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const context = () => {
    const ctx = canvas.current?.getContext('2d') ?? null;
    if (ctx !== null) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#111827';
      ctx.fillStyle = '#111827';
    }
    return ctx;
  };
  const clear = () => {
    context()?.clearRect(0, 0, WIDTH, HEIGHT);
    onChange(null);
  };
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * WIDTH,
      y: ((e.clientY - box.top) / box.height) * HEIGHT,
    };
  };
  const done = () => {
    drawing.current = false;
    onChange(canvas.current?.toDataURL('image/png') ?? null);
  };
  return (
    <div className="grid gap-2">
      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        aria-label={t('drawHere')}
        role="img"
        className="h-40 w-full touch-none rounded-md border bg-white"
        onPointerDown={(e) => {
          const ctx = context();
          if (ctx === null) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const { x, y } = point(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = context();
          const { x, y } = point(e);
          ctx?.lineTo(x, y);
          ctx?.stroke();
        }}
        onPointerUp={done}
        onPointerCancel={done}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={clear}>
          {t('clear')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={name.trim() === ''}
          onClick={() => {
            const ctx = context();
            if (ctx === null) return;
            ctx.clearRect(0, 0, WIDTH, HEIGHT);
            ctx.font = 'italic 44px "Segoe Script", "Brush Script MT", cursive';
            ctx.textBaseline = 'middle';
            ctx.fillText(name.trim(), 16, HEIGHT / 2, WIDTH - 32);
            onChange(canvas.current?.toDataURL('image/png') ?? null);
          }}
        >
          {t('useName')}
        </Button>
      </div>
    </div>
  );
}
