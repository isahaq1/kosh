/**
 * Toasts (RFC 0010 §3.3): short confirmations ("Saved", "3 records archived") and errors, announced to screen
 * readers, with an optional action such as **Undo**. Radix Toast handles focus (F8 jumps to the region), swipe and
 * pause-on-hover; toasts stack at the bottom end of the screen, and in right-to-left too.
 */
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { Toast } from 'radix-ui';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn.js';

/** What a toast shows. */
export interface ToastInput {
  readonly title: string;
  readonly description?: string;
  readonly tone?: 'success' | 'info' | 'danger';
  /** A button in the toast, e.g. Undo. */
  readonly action?: { readonly label: string; readonly run: () => void };
  /** Milliseconds before it closes (default 5 s; 8 s with an action). */
  readonly duration?: number;
}

type Show = (toast: ToastInput) => void;
const ToastContext = createContext<Show | null>(null);

/** Shows a toast. Outside the provider (tests, custom shells), toasts are ignored. */
export function useToast(): Show {
  return useContext(ToastContext) ?? (() => {});
}

interface Live extends ToastInput {
  readonly key: number;
  open: boolean;
}

const ICONS = { success: CircleCheck, info: Info, danger: CircleAlert } as const;
const TONES = {
  success: 'text-success',
  info: 'text-primary',
  danger: 'text-danger',
} as const;

let next = 0;

/** Provides toasts to the app and renders their region. */
export function ToastProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Live[]>([]);
  const show = useCallback<Show>((toast) => {
    next += 1;
    const key = next;
    setToasts((all) => [...all.slice(-3), { ...toast, key, open: true }]);
  }, []);
  const close = (key: number) =>
    setToasts((all) => all.map((x) => (x.key === key ? { ...x, open: false } : x)));
  return (
    <ToastContext.Provider value={show}>
      <Toast.Provider swipeDirection="right" label={t('toast.region')}>
        {children}
        {toasts.map((toast) => {
          const tone = toast.tone ?? 'success';
          const Icon = ICONS[tone];
          return (
            <Toast.Root
              key={toast.key}
              open={toast.open}
              onOpenChange={(open) => {
                if (!open) {
                  close(toast.key);
                  setTimeout(() => setToasts((all) => all.filter((x) => x.key !== toast.key)), 300);
                }
              }}
              duration={toast.duration ?? (toast.action === undefined ? 5000 : 8000)}
              type={tone === 'danger' ? 'foreground' : 'background'}
              className="flex items-start gap-3 rounded-lg border bg-surface p-3 pe-2 text-sm text-surface-foreground shadow-lg transition-opacity data-[state=closed]:opacity-0"
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', TONES[tone])} aria-hidden />
              <div className="grid flex-1 gap-0.5">
                <Toast.Title className="font-medium">{toast.title}</Toast.Title>
                {toast.description === undefined ? null : (
                  <Toast.Description className="text-muted-foreground">
                    {toast.description}
                  </Toast.Description>
                )}
              </div>
              {toast.action === undefined ? null : (
                <Toast.Action asChild altText={toast.action.label}>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 font-medium text-primary hover:bg-muted focus-visible:outline-2"
                    onClick={toast.action.run}
                  >
                    {toast.action.label}
                  </button>
                </Toast.Action>
              )}
              <Toast.Close
                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                aria-label={t('toast.close')}
              >
                <X className="size-4" aria-hidden />
              </Toast.Close>
            </Toast.Root>
          );
        })}
        <Toast.Viewport className="fixed bottom-0 end-0 z-[60] m-0 flex w-[min(24rem,100vw)] list-none flex-col gap-2 p-4 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}
