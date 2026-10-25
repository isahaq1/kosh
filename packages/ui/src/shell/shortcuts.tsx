/**
 * Keyboard shortcuts (RFC 0010 §3.2). The shell listens once; screens opt in by marking their controls, so no view
 * knows about keys:
 *
 * | Keys            | Does                                | Marked with             |
 * | --------------- | ----------------------------------- | ----------------------- |
 * | Ctrl/⌘ + K      | command palette                     | (the shell)             |
 * | ?               | this list                           | (the shell)             |
 * | /               | focus the search box                | `data-kosh-search`      |
 * | N               | new record                          | `data-kosh-new`         |
 * | Alt + 1…9       | switch view (list, kanban, …)       | `data-kosh-view="1…9"`  |
 * | Ctrl/⌘ + S      | save the form                       | `data-kosh-save`        |
 * | Esc             | back from a form (when not editing) | `data-kosh-back`        |
 * | Alt + ← / →     | previous / next record              | `data-kosh-prev/next`   |
 *
 * Single keys never fire while typing in a field; Ctrl/⌘ combinations do (save while editing).
 */
import { type ReactElement, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../components/primitives.js';

const typing = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

const click = (selector: string): boolean => {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null || (el as HTMLButtonElement).disabled) return false;
  el.click();
  return true;
};

/** Listens for the shortcuts while mounted. */
export function useShortcuts(handlers: {
  readonly palette: () => void;
  readonly help: () => void;
}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'k') {
        e.preventDefault();
        handlers.palette();
        return;
      }
      if (mod && key === 's') {
        // On a form, Ctrl+S saves (or does nothing when there is nothing to save): never the browser's dialog.
        if (click('[data-kosh-save]') || document.querySelector('[data-kosh-form]') !== null)
          e.preventDefault();
        return;
      }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const rtl = document.documentElement.dir === 'rtl';
        const forward = (e.key === 'ArrowRight') !== rtl;
        if (click(forward ? '[data-kosh-next]' : '[data-kosh-prev]')) e.preventDefault();
        return;
      }
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        if (click(`[data-kosh-view="${e.key}"]`)) e.preventDefault();
        return;
      }
      if (mod || e.altKey || typing(e.target)) return;
      if (document.querySelector('[role="dialog"]') !== null) return; // dialogs own their keys
      if (e.key === '?') {
        e.preventDefault();
        handlers.help();
      } else if (e.key === '/') {
        const search = document.querySelector<HTMLElement>('[data-kosh-search]');
        if (search !== null) {
          e.preventDefault();
          search.focus();
        }
      } else if (key === 'n') {
        if (click('[data-kosh-new]')) e.preventDefault();
      } else if (e.key === 'Escape') {
        if (click('[data-kosh-back]')) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The cheat sheet (`?`). */
export function ShortcutsHelp({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const mod = isMac ? '⌘' : 'Ctrl';
  const rows: [string, string[]][] = [
    ['palette', [mod, 'K']],
    ['search', ['/']],
    ['new', ['N']],
    ['views', ['Alt', '1…9']],
    ['save', [mod, 'S']],
    ['back', ['Esc']],
    ['records', ['Alt', '← →']],
    ['help', ['?']],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('shortcuts.title')}>
      <dl className="grid gap-2 text-sm">
        {rows.map(([what, keys]) => (
          <div key={what} className="flex items-center justify-between gap-4">
            <dt>{t(`shortcuts.${what}`)}</dt>
            <dd className="flex gap-1">
              {keys.map((k) => (
                <kbd
                  key={k}
                  className="min-w-6 rounded border bg-muted px-1.5 py-0.5 text-center text-xs"
                >
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
