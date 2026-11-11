/**
 * Motion and feedback (RFC 0033 §3.1): the few primitives that show a change — a value that flashes once when it
 * changes under the reader, a number that counts to its new value, a placeholder shaped like the form that is
 * loading. Durations come from the `--motion-*` tokens; with "reduce motion" nothing moves (the styles' media
 * query, and `CountUp` jumps to the value).
 */
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { Skeleton } from './components/primitives.js';
import { cn } from './lib/cn.js';

const serial = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
};

/**
 * Counts the times `value` changed while `identity` stayed the same: 0 on the first sight of a record (and when a
 * recycled row shows another record), then 1, 2, … — a key that restarts the flash animation.
 */
export function useChanged(value: unknown, identity: unknown): number {
  const seen = useRef<{ identity: unknown; value: string } | null>(null);
  const [changes, setChanges] = useState(0);
  const now = serial(value);
  useEffect(() => {
    const before = seen.current;
    seen.current = { identity, value: now };
    if (before === null || before.identity !== identity) setChanges(0);
    else if (before.value !== now) setChanges((n) => n + 1);
  }, [identity, now]);
  return changes;
}

/** Its children, flashing once whenever `watch` changes for the same `identity` (a record's id). */
export function Flash({
  watch,
  identity,
  className,
  children,
}: {
  readonly watch: unknown;
  readonly identity: unknown;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  const changes = useChanged(watch, identity);
  return (
    <span
      key={changes}
      data-changed={changes > 0 ? 'true' : undefined}
      className={cn('kosh-flash-host', changes > 0 && 'kosh-flash', className)}
    >
      {children}
    </span>
  );
}

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * An exact decimal (`'1250.50'`) shown through `format`, counting from the value it showed before to the new one
 * in about a quarter of a second. Only what is displayed moves: the final text is always the exact value.
 */
export function CountUp({
  value,
  format,
  className,
}: {
  readonly value: string;
  readonly format: (value: string) => string;
  readonly className?: string;
}): ReactElement {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = Number(from.current);
    const end = Number(value);
    from.current = value;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end || reducedMotion()) {
      setShown(value);
      return;
    }
    const scale = value.includes('.') ? value.length - value.indexOf('.') - 1 : 0;
    const began = performance.now();
    let frame = 0;
    const tick = (at: number): void => {
      const progress = Math.min(1, (at - began) / 260);
      const eased = 1 - (1 - progress) ** 3;
      if (progress >= 1) setShown(value);
      else {
        setShown((start + (end - start) * eased).toFixed(scale));
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return (
    <span className={className} data-value={value}>
      {format(shown)}
    </span>
  );
}

/** A placeholder shaped like a record page: a title, two columns of labelled fields, a table of lines. */
export function FormSkeleton({ label }: { readonly label: string }): ReactElement {
  return (
    <div role="status" aria-label={label} className="grid gap-6 p-4">
      <Skeleton className="h-7 w-1/3" />
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        {['a', 'b', 'c', 'd', 'e', 'f'].map((k) => (
          <div key={k} className="grid gap-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
      <div className="grid gap-2">
        {['a', 'b', 'c'].map((k) => (
          <Skeleton key={k} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}
