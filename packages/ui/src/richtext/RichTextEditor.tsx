/**
 * The rich-text editor (RFC 0034 §2.4): Tiptap on ProseMirror, with a toolbar of labelled buttons — headings,
 * emphasis, lists, a quote, a link, a table — that the keyboard reaches and a screen reader names. It gives back
 * HTML; the server rebuilds it from its allow-list when it is saved, so nothing here is a security boundary.
 * Loaded on demand (`RichText.tsx`): a list or a form without rich text never downloads it.
 */
import { Image } from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { type Editor, EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  type LucideIcon,
  Quote,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Underline,
  Undo2,
} from 'lucide-react';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../components/primitives.js';
import { cn } from '../lib/cn.js';
import { isEmptyRichText, sanitizeForDisplay } from './sanitize.js';

export interface RichTextEditorProps {
  readonly id: string;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly invalid?: boolean;
  /** The field's label: what a screen reader calls the text box. */
  readonly label?: string;
}

function Tool({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      // The selection stays in the text: the button acts on it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-40',
        active === true && 'bg-muted text-foreground',
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

function Toolbar({ editor }: { readonly editor: Editor }) {
  const { t } = useTranslation();
  const id = useId();
  const [linking, setLinking] = useState<string | null>(null);
  // What is on at the cursor: read with the editor's state, so the buttons follow the selection.
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      code: e.isActive('codeBlock'),
      link: e.isActive('link'),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const applyLink = () => {
    const href = (linking ?? '').trim();
    if (href === '') chain().extendMarkRange('link').unsetLink().run();
    else
      chain()
        .extendMarkRange('link')
        .setLink({
          href: /^(https?:\/\/|mailto:|tel:|\/|#)/i.test(href) ? href : `https://${href}`,
        })
        .run();
    setLinking(null);
  };
  return (
    <div className="border-b">
      <div
        role="toolbar"
        aria-label={t('richtext.toolbar')}
        className="flex flex-wrap items-center gap-0.5 p-1"
      >
        <Tool
          icon={Bold}
          label={t('richtext.bold')}
          active={on.bold}
          onClick={() => chain().toggleBold().run()}
        />
        <Tool
          icon={Italic}
          label={t('richtext.italic')}
          active={on.italic}
          onClick={() => chain().toggleItalic().run()}
        />
        <Tool
          icon={Underline}
          label={t('richtext.underline')}
          active={on.underline}
          onClick={() => chain().toggleUnderline().run()}
        />
        <Tool
          icon={Strikethrough}
          label={t('richtext.strike')}
          active={on.strike}
          onClick={() => chain().toggleStrike().run()}
        />
        <Tool
          icon={Heading2}
          label={t('richtext.heading')}
          active={on.h2}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        />
        <Tool
          icon={Heading3}
          label={t('richtext.subheading')}
          active={on.h3}
          onClick={() => chain().toggleHeading({ level: 3 }).run()}
        />
        <Tool
          icon={List}
          label={t('richtext.bullets')}
          active={on.bullet}
          onClick={() => chain().toggleBulletList().run()}
        />
        <Tool
          icon={ListOrdered}
          label={t('richtext.numbers')}
          active={on.ordered}
          onClick={() => chain().toggleOrderedList().run()}
        />
        <Tool
          icon={Quote}
          label={t('richtext.quote')}
          active={on.quote}
          onClick={() => chain().toggleBlockquote().run()}
        />
        <Tool
          icon={Code}
          label={t('richtext.code')}
          active={on.code}
          onClick={() => chain().toggleCodeBlock().run()}
        />
        <Tool
          icon={LinkIcon}
          label={t('richtext.link')}
          active={on.link}
          onClick={() => setLinking(String(editor.getAttributes('link')['href'] ?? ''))}
        />
        <Tool
          icon={TableIcon}
          label={t('richtext.table')}
          onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        />
        <Tool
          icon={Undo2}
          label={t('richtext.undo')}
          disabled={!on.undo}
          onClick={() => chain().undo().run()}
        />
        <Tool
          icon={Redo2}
          label={t('richtext.redo')}
          disabled={!on.redo}
          onClick={() => chain().redo().run()}
        />
      </div>
      {linking === null ? null : (
        <form
          className="flex flex-wrap items-center gap-2 border-t p-2"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation(); // not the record's form
            applyLink();
          }}
        >
          <label htmlFor={`${id}-href`} className="text-sm">
            {t('richtext.linkAddress')}
          </label>
          <Input
            id={`${id}-href`}
            autoFocus
            className="min-w-48 flex-1"
            value={linking}
            placeholder="https://"
            onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setLinking(null);
              }
            }}
          />
          <Button type="submit" variant="primary">
            {t('richtext.linkApply')}
          </Button>
          <Button onClick={() => setLinking(null)}>{t('richtext.linkCancel')}</Button>
        </form>
      )}
    </div>
  );
}

export default function RichTextEditor({
  id,
  value,
  onChange,
  invalid,
  label,
}: RichTextEditorProps): ReactElement {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto', 'tel'] },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: false, allowBase64: false }),
    ],
    // What is loaded is what may be shown: older plain text becomes paragraphs.
    content: sanitizeForDisplay(value ?? ''),
    editorProps: {
      attributes: {
        id,
        role: 'textbox',
        'aria-multiline': 'true',
        ...(label === undefined ? {} : { 'aria-label': label }),
        class: 'kosh-richtext min-h-32 px-3 py-2 outline-none',
        ...(invalid === true ? { 'aria-invalid': 'true' } : {}),
      },
    },
    onUpdate: ({ editor: e }) => {
      // The editor keeps an empty paragraph at the end to type into: it is not part of the text.
      const html = e.getHTML().replace(/(<p><\/p>)+$/, '');
      onChange(isEmptyRichText(html) ? null : html);
    },
  });
  // The record changed under the editor (a reload, Discard, someone else's save): show what it has now.
  useEffect(() => {
    if (editor === null || editor.isFocused) return;
    const next = sanitizeForDisplay(value ?? '');
    const current = editor.getHTML();
    if ((isEmptyRichText(current) ? '' : current) !== next)
      editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, value]);
  return (
    <div
      className={cn(
        'rounded-md border bg-background focus-within:outline-2 focus-within:outline-offset-1',
        invalid === true && 'border-danger',
      )}
    >
      {editor === null ? null : <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}
