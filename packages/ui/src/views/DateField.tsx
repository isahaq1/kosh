/**
 * The date field (RFC 0018 §4.2): the date as the user's language writes it (`28 Oct 2026`, `২৮ অক্টো, ২০২৬`), typed
 * (ISO `2026-10-28`, or day, month and year in the language's order) or picked on a calendar — arrows move by
 * day and week, Page Up / Page Down by month, Home / End to the week's ends, Enter picks. Values stay ISO dates.
 */
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../components/primitives.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (value: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m === null) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d: Date, n: number) => {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
};

/** The order of day, month and year in `lang`'s numeric dates (`dmy`, `mdy`, `ymd`). */
function orderOf(lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'numeric', year: 'numeric' })
      .formatToParts(new Date(2026, 9, 28))
      .map((p) => p.type[0])
      .filter((c) => c === 'd' || c === 'm' || c === 'y')
      .join('');
  } catch {
    return 'dmy';
  }
}

/** A typed date as ISO, or null: `2026-10-28`, or `28/10/2026` (`10/28/2026` where months come first). */
export function parseTypedDate(text: string, lang: string): string | null {
  const raw = text.trim();
  if (raw === '') return null;
  const isoDate = fromIso(raw);
  if (isoDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return iso(isoDate);
  // Any digits (Bengali ones too) separated by / . - or spaces.
  const digits = raw.replace(/[০-৯]/g, (c) => String(c.charCodeAt(0) - 0x09e6));
  const parts = digits.split(/[\s/.-]+/).filter((p) => p !== '');
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const order = orderOf(lang);
  const at = (c: string) => Number(parts[order.indexOf(c)]);
  let year = at('y');
  if (year < 100) year += 2000;
  const d = new Date(year, at('m') - 1, at('d'));
  return d.getMonth() === at('m') - 1 && d.getDate() === at('d') ? iso(d) : null;
}

/** The first day of the week in `lang` (0 Sunday … 6 Saturday). */
function weekStart(lang: string): number {
  try {
    const locale = new Intl.Locale(lang) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    return first === undefined ? 1 : first % 7;
  } catch {
    return 1;
  }
}

function Calendar({
  value,
  onPick,
  lang,
}: {
  readonly value: string | null;
  readonly onPick: (iso: string | null) => void;
  readonly lang: string;
}): ReactElement {
  const { t } = useTranslation();
  const { format } = useKosh();
  const today = useMemo(() => new Date(), []);
  const [focus, setFocus] = useState<Date>(() => (value === null ? null : fromIso(value)) ?? today);
  const grid = useRef<HTMLTableElement>(null);
  const first = weekStart(lang);
  const month = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const start = addDays(month, -((month.getDay() - first + 7) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weekday = new Intl.DateTimeFormat(lang, { weekday: 'narrow' });
  const title = new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }).format(month);
  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${iso(focus)}"]`)?.focus();
  }, [focus]);
  const onKey = (e: KeyboardEvent) => {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, document.dir === 'rtl' ? 1 : -1),
      ArrowRight: () => addDays(focus, document.dir === 'rtl' ? -1 : 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -((focus.getDay() - first + 7) % 7)),
      End: () => addDays(focus, 6 - ((focus.getDay() - first + 7) % 7)),
    };
    const move = moves[e.key];
    if (move === undefined) return;
    e.preventDefault();
    setFocus(move());
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('views.previousMonth')}
          onClick={() => setFocus(addMonths(focus, -1))}
        >
          <ChevronLeft className="rtl:rotate-180" aria-hidden />
        </Button>
        <p className="text-sm font-medium" aria-live="polite">
          {title}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('views.nextMonth')}
          onClick={() => setFocus(addMonths(focus, 1))}
        >
          <ChevronRight className="rtl:rotate-180" aria-hidden />
        </Button>
      </div>
      <table
        ref={grid}
        aria-label={title}
        className="border-separate border-spacing-0.5"
        onKeyDown={onKey}
      >
        <thead>
          <tr>
            {days.slice(0, 7).map((d) => (
              <th
                key={iso(d)}
                scope="col"
                className="py-1 text-center text-xs font-normal text-muted-foreground"
              >
                {weekday.format(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2, 3, 4, 5].map((week) => (
            <tr key={week}>
              {days.slice(week * 7, week * 7 + 7).map((d) => {
                const key = iso(d);
                const selected = key === value;
                const inMonth = d.getMonth() === month.getMonth();
                return (
                  <td key={key} className="p-0">
                    <button
                      type="button"
                      data-day={key}
                      tabIndex={key === iso(focus) ? 0 : -1}
                      aria-pressed={selected}
                      aria-label={format.date(key)}
                      onClick={() => onPick(key)}
                      className={cn(
                        'size-8 rounded-md text-sm tabular-nums hover:bg-muted',
                        !inMonth && 'text-muted-foreground/60',
                        key === iso(today) && 'font-semibold underline underline-offset-4',
                        selected && 'bg-primary text-primary-foreground hover:bg-primary',
                      )}
                    >
                      {new Intl.NumberFormat(lang).format(d.getDate())}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-between">
        <Button type="button" size="sm" variant="ghost" onClick={() => onPick(iso(today))}>
          {t('views.today')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onPick(null)}>
          {t('views.clear')}
        </Button>
      </div>
    </div>
  );
}

export function DateField({
  id,
  value,
  onChange,
  invalid,
  required,
}: {
  readonly id?: string;
  readonly value: string | null;
  readonly onChange: (iso: string | null) => void;
  readonly invalid?: boolean;
  readonly required?: boolean;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const { format } = useKosh();
  const lang = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const [typing, setTyping] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const shown = typing ?? (value === null ? '' : format.date(value));
  const bad = typing !== null && typing.trim() !== '' && parseTypedDate(typing, lang) === null;
  return (
    <div className="relative">
      <Input
        id={id}
        value={shown}
        required={required}
        placeholder={t('views.datePlaceholder')}
        aria-invalid={invalid === true || bad ? true : undefined}
        className="pe-10"
        onFocus={() => setTyping(value ?? '')}
        onChange={(e) => {
          setTyping(e.target.value);
          const parsed = parseTypedDate(e.target.value, lang);
          if (parsed !== null || e.target.value.trim() === '') onChange(parsed);
        }}
        onBlur={() => setTyping(null)}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute inset-y-0 end-0 h-full"
            aria-label={t('views.pickDate')}
          >
            <CalendarDays aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto">
          <Calendar
            value={value}
            lang={lang}
            onPick={(picked) => {
              onChange(picked);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
