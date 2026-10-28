/**
 * Design-system primitives (shadcn/ui style, owned code on Radix): buttons, inputs, badges, checkbox, select, menus,
 * dialogs, tabs, alerts. Tokens from `styles.css`; logical properties only (RTL); keyboard and screen-reader
 * support from Radix; every variant readable in light and dark themes.
 */
import { cva } from 'class-variance-authority';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import {
  Checkbox as RCheckbox,
  Dialog as RDialog,
  DropdownMenu as RMenu,
  Popover as RPopover,
  Select as RSelect,
  Tabs as RTabs,
  Slot,
} from 'radix-ui';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'border border-input bg-surface text-surface-foreground hover:bg-muted',
        ghost: 'text-foreground hover:bg-muted',
        danger: 'bg-danger text-danger-foreground hover:bg-danger/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: { sm: 'h-8 px-3', md: 'h-[var(--control-h)] px-4', icon: 'size-[var(--control-h)]' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> & {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
  readonly size?: 'sm' | 'md' | 'icon';
  readonly asChild?: boolean;
  readonly busy?: boolean;
};

export function Button({
  className,
  variant,
  size,
  asChild,
  busy,
  children,
  disabled,
  ...props
}: ButtonProps): ReactElement {
  const Comp = asChild === true ? Slot.Root : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled === true || busy === true}
      aria-busy={busy === true ? true : undefined}
      {...props}
    >
      {busy === true ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </Comp>
  );
}

const field =
  'w-full rounded-md border border-input bg-surface px-3 text-sm text-surface-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 read-only:bg-muted aria-invalid:border-danger';

export function Input({ className, ...props }: ComponentProps<'input'>): ReactElement {
  return <input className={cn(field, 'h-[var(--control-h)]', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>): ReactElement {
  return <textarea className={cn(field, 'min-h-20 py-2', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>): ReactElement {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or wrap the control
    <label className={cn('text-sm font-medium text-muted-foreground', className)} {...props} />
  );
}

const badge = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-muted text-foreground',
      info: 'bg-accent text-accent-foreground',
      success: 'bg-success/15 text-success',
      warning: 'bg-warning/15 text-warning-text',
      danger: 'bg-danger/15 text-danger',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

/** The badge's classes, for elements that look like one (the status chip). */
export const badgeVariants: (props?: {
  readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | null;
}) => string = badge;

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & {
  readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | null;
}): ReactElement {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof RCheckbox.Root>): ReactElement {
  return (
    <RCheckbox.Root
      className={cn(
        'peer size-4 shrink-0 rounded-sm border border-input bg-surface data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground disabled:opacity-60',
        className,
      )}
      {...props}
    >
      <RCheckbox.Indicator className="flex items-center justify-center">
        <Check className="size-3.5" aria-hidden />
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

/** A select over `options` (`null` value: empty). */
export function Select({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  id,
  label,
  className,
}: {
  readonly value: string | null;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly id?: string;
  readonly label?: string;
  readonly className?: string;
}): ReactElement {
  return (
    <RSelect.Root
      {...(value === null ? {} : { value })}
      onValueChange={onChange}
      {...(disabled === true ? { disabled } : {})}
    >
      <RSelect.Trigger
        {...(id === undefined ? {} : { id })}
        aria-label={label}
        className={cn(
          field,
          'flex h-[var(--control-h)] items-center justify-between gap-2 text-start',
          className,
        )}
      >
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon>
          <ChevronDown className="size-4 opacity-60" aria-hidden />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border bg-surface text-surface-foreground shadow-lg"
        >
          <RSelect.Viewport className="p-1">
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default select-none items-center rounded-sm py-1.5 pe-2 ps-7 text-sm outline-none data-[highlighted]:bg-muted"
              >
                <RSelect.ItemIndicator className="absolute start-2">
                  <Check className="size-3.5" aria-hidden />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export const Menu: typeof RMenu.Root = RMenu.Root;
export const MenuTrigger: typeof RMenu.Trigger = RMenu.Trigger;

export function MenuContent({
  className,
  align = 'end',
  ...props
}: ComponentProps<typeof RMenu.Content>): ReactElement {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        sideOffset={4}
        className={cn(
          'z-50 min-w-48 rounded-md border bg-surface p-1 text-surface-foreground shadow-lg',
          className,
        )}
        {...props}
      />
    </RMenu.Portal>
  );
}

export function MenuItem({ className, ...props }: ComponentProps<typeof RMenu.Item>): ReactElement {
  return (
    <RMenu.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function MenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof RMenu.CheckboxItem>): ReactElement {
  return (
    <RMenu.CheckboxItem
      className={cn(
        'relative flex cursor-default select-none items-center rounded-sm py-1.5 pe-2 ps-7 text-sm outline-none data-[highlighted]:bg-muted',
        className,
      )}
      {...props}
    >
      <RMenu.ItemIndicator className="absolute start-2">
        <Check className="size-3.5" aria-hidden />
      </RMenu.ItemIndicator>
      {children}
    </RMenu.CheckboxItem>
  );
}

export function MenuLabel({
  className,
  ...props
}: ComponentProps<typeof RMenu.Label>): ReactElement {
  return (
    <RMenu.Label
      className={cn('px-2 py-1 text-xs font-semibold text-muted-foreground', className)}
      {...props}
    />
  );
}

export function MenuSeparator(): ReactElement {
  return <RMenu.Separator className="my-1 h-px bg-border" />;
}

/** A modal dialog with a title (required for screen readers) and a close button. */
/** A popover (Radix): focus moves in and back, Escape closes, positioned beside its trigger. */
export const Popover: typeof RPopover.Root = RPopover.Root;
export const PopoverTrigger: typeof RPopover.Trigger = RPopover.Trigger;
export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof RPopover.Content>): ReactElement {
  return (
    <RPopover.Portal>
      <RPopover.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-lg border bg-surface p-3 text-surface-foreground shadow-lg outline-none',
          className,
        )}
        {...props}
      />
    </RPopover.Portal>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  /** A wider dialog with its own scrolling (reviews, diffs). */
  readonly wide?: boolean;
}): ReactElement {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content
          className={cn(
            'fixed start-1/2 top-1/2 z-50 -translate-y-1/2 rtl:translate-x-1/2 ltr:-translate-x-1/2 rounded-lg border bg-surface p-5 text-surface-foreground shadow-xl',
            wide === true
              ? 'max-h-[calc(100vh-2rem)] w-[min(56rem,calc(100vw-2rem))] overflow-y-auto'
              : 'w-[min(32rem,calc(100vw-2rem))]',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <RDialog.Title className="text-base font-semibold">{title}</RDialog.Title>
              {description === undefined ? (
                <RDialog.Description className="sr-only">{title}</RDialog.Description>
              ) : (
                <RDialog.Description className="mt-1 text-sm text-muted-foreground">
                  {description}
                </RDialog.Description>
              )}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X aria-hidden />
              </Button>
            </RDialog.Close>
          </div>
          {children}
          {footer === undefined ? null : (
            <div className="mt-5 flex justify-end gap-2">{footer}</div>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const Tabs: typeof RTabs.Root = RTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof RTabs.List>): ReactElement {
  return <RTabs.List className={cn('flex gap-1 border-b', className)} {...props} />;
}

export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof RTabs.Trigger>): ReactElement {
  return (
    <RTabs.Trigger
      className={cn(
        '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground data-[state=active]:border-primary data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentProps<typeof RTabs.Content>): ReactElement {
  return <RTabs.Content className={cn('pt-4', className)} {...props} />;
}

export function Alert({
  tone = 'danger',
  children,
  action,
}: {
  readonly tone?: 'danger' | 'warning' | 'info';
  readonly children: ReactNode;
  readonly action?: ReactNode;
}): ReactElement {
  const tones = {
    danger: 'border-danger/40 bg-danger/10 text-danger',
    warning: 'border-warning/40 bg-warning/10 text-warning-text',
    info: 'border-primary/30 bg-accent text-accent-foreground',
  } as const;
  return (
    <div
      role={tone === 'info' ? 'status' : 'alert'}
      className={cn(
        'flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm',
        tones[tone],
      )}
    >
      <div>{children}</div>
      {action}
    </div>
  );
}

export function Spinner({ label }: { readonly label: string }): ReactElement {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Card({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      className={cn('rounded-lg border bg-surface text-surface-foreground', className)}
      {...props}
    />
  );
}

/** A placeholder shaped like the content that is loading (RFC 0010 §3.9). */
export function Skeleton({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />
  );
}

/** An empty list or board that says what it is and offers the next step. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon === undefined ? null : (
        <div className="mb-1 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">
          {icon}
        </div>
      )}
      <p className="font-medium">{title}</p>
      {description === undefined ? null : (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      )}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}
