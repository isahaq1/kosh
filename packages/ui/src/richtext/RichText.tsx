/**
 * Rich text on a form, a card or a list (RFC 0034 §2.4): shown as formatted text rebuilt from the allow-list, and
 * edited in the editor, which is downloaded only when a field is first edited.
 */
import { lazy, type ReactElement, Suspense, useMemo } from 'react';
import { cn } from '../lib/cn.js';
import type { RichTextEditorProps } from './RichTextEditor.js';
import { sanitizeForDisplay } from './sanitize.js';

const Editor = lazy(() => import('./RichTextEditor.js'));

/** Formatted text, read only. */
export function RichTextView({
  value,
  className,
}: {
  readonly value: string | null | undefined;
  readonly className?: string;
}): ReactElement | null {
  const html = useMemo(() => sanitizeForDisplay(value ?? ''), [value]);
  if (html === '') return null;
  return (
    <div
      className={cn('kosh-richtext', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: rebuilt from an allow-list by sanitizeForDisplay
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** The editor, with the text shown plainly while it loads. */
export function RichTextInput(props: RichTextEditorProps): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="min-h-32 rounded-md border px-3 py-2">
          <RichTextView value={props.value} />
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}
