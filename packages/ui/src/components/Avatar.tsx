/**
 * Photos and logos: `Avatar` shows a person's photo or a company's logo (the server's image route, versioned so the
 * browser caches it), else the initials on a tint. `ImagePicker` chooses a file and makes it small in the browser —
 * a 256 px square, cropped to the centre for photos, fitted whole for logos — before anything is sent.
 */
import { ImageUp, Trash2 } from 'lucide-react';
import { type ReactElement, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn.js';
import { Button } from './primitives.js';

/** The URL of a photo (`user`) or logo (`company`), or null when there is none. */
export function imageUrl(
  kind: 'user' | 'company',
  id: number,
  version: string | null | undefined,
): string | null {
  return version === null || version === undefined
    ? null
    : `/api/v1/images/${kind}/${id}?v=${version}`;
}

/** Up to two initials of a name. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => w.slice(0, 1))
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function Avatar({
  name,
  src,
  shape = 'circle',
  className,
}: {
  readonly name: string;
  readonly src: string | null;
  /** People are round; companies square. */
  readonly shape?: 'circle' | 'square';
  readonly className?: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const round = shape === 'circle' ? 'rounded-full' : 'rounded-md';
  if (src !== null && !failed)
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        onError={() => setFailed(true)}
        className={cn(
          'size-7 shrink-0 bg-surface object-cover',
          shape === 'square' && 'object-contain',
          round,
          className,
        )}
      />
    );
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7 shrink-0 place-items-center bg-primary text-xs font-medium text-primary-foreground',
        round,
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

const SIZE = 256;

/** Draws `file` on a 256 px square: covered and centred (`photo`) or fitted whole (`logo`). */
async function shrink(file: File, fit: 'photo' | 'logo'): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('No canvas');
  const scale =
    fit === 'photo'
      ? Math.max(SIZE / bitmap.width, SIZE / bitmap.height)
      : Math.min(SIZE / bitmap.width, SIZE / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  bitmap.close();
  // Photos as WebP (small); logos as PNG (they keep transparency and sharp edges).
  return fit === 'photo' ? canvas.toDataURL('image/webp', 0.86) : canvas.toDataURL('image/png');
}

export function ImagePicker({
  name,
  src,
  fit,
  onChoose,
  onRemove,
  busy,
}: {
  readonly name: string;
  readonly src: string | null;
  readonly fit: 'photo' | 'logo';
  /** The image as a `data:` URL, already small. */
  readonly onChoose: (dataUrl: string) => void;
  readonly onRemove: () => void;
  readonly busy?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar
        name={name}
        src={src}
        shape={fit === 'photo' ? 'circle' : 'square'}
        className="size-16 text-lg"
      />
      <div className="grid gap-1.5">
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            id={id}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file === undefined) return;
              setError(null);
              shrink(file, fit)
                .then(onChoose)
                .catch(() => setError(t('image.unreadable')));
            }}
          />
          <Button size="sm" busy={busy === true} onClick={() => input.current?.click()}>
            <ImageUp aria-hidden />
            {fit === 'photo' ? t('image.choosePhoto') : t('image.chooseLogo')}
          </Button>
          {src === null ? null : (
            <Button size="sm" variant="ghost" onClick={onRemove}>
              <Trash2 aria-hidden />
              {t('image.remove')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{error ?? t('image.hint')}</p>
      </div>
    </div>
  );
}
