/**
 * iCalendar (RFC 5545) as text (RFC 0034 §2.4): what a mail client reads from an invitation and a calendar reads
 * from a feed. Events are written in UTC — every client shows them in its own time zone — or as dates when they
 * last all day. Text is escaped, lines are folded at 75 bytes without cutting a character, and end with CRLF.
 */

export interface IcsPerson {
  readonly email: string;
  readonly name?: string | null;
}
export interface IcsAttendee extends IcsPerson {
  /** `needs_action`, `accepted`, `tentative` or `declined`. */
  readonly response?: string | null;
}
export interface IcsEvent {
  /** Stable for the event's life: the same id updates and cancels it in the client. */
  readonly uid: string;
  readonly start: Date;
  readonly stop: Date;
  /** All day: `startDate` to `stopDate` (both included, local dates). */
  readonly allDay?: { readonly startDate: string; readonly stopDate: string } | null;
  readonly title: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly url?: string | null;
  readonly cancelled?: boolean;
  /** Raised at each change sent: a client keeps the highest. */
  readonly sequence?: number;
  readonly organizer?: IcsPerson | null;
  readonly attendees?: readonly IcsAttendee[];
  readonly updatedAt?: Date | null;
}

/** `REQUEST`: an invitation to answer; `CANCEL`: it is off; `PUBLISH`: a calendar to read. */
export type IcsMethod = 'REQUEST' | 'CANCEL' | 'PUBLISH';

const text = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
/** A parameter value: quoted when it has a character that would end it; never with a quote or a line break. */
const param = (value: string): string => {
  const clean = value.replace(/["\r\n]/g, ' ').trim();
  return /[,;:]/.test(clean) ? `"${clean}"` : clean;
};
const stamp = (at: Date): string => `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
const dateOnly = (date: string): string => date.slice(0, 10).replace(/-/g, '');
const nextDay = (date: string): string =>
  new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** An address that cannot break out of its line. */
const mailto = (email: string): string => `mailto:${email.replace(/[\s<>"]/g, '')}`;

/** Folds a line at 75 bytes (RFC 5545 §3.1): continuation lines start with a space; no character is cut. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    // The first line holds 75 bytes; the others 74 after their leading space.
    if (bytes + size > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const PARTSTAT: Readonly<Record<string, string>> = {
  accepted: 'ACCEPTED',
  tentative: 'TENTATIVE',
  declined: 'DECLINED',
};

function eventLines(event: IcsEvent, method: IcsMethod, now: Date): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${text(event.uid)}`, `DTSTAMP:${stamp(now)}`];
  if (event.allDay != null) {
    // The end of an all-day event is the day after its last day.
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(event.allDay.startDate)}`);
    lines.push(`DTEND;VALUE=DATE:${dateOnly(nextDay(event.allDay.stopDate))}`);
  } else {
    lines.push(`DTSTART:${stamp(event.start)}`, `DTEND:${stamp(event.stop)}`);
  }
  lines.push(`SUMMARY:${text(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${text(event.description)}`);
  if (event.location) lines.push(`LOCATION:${text(event.location)}`);
  if (event.url && /^https?:\/\/\S+$/.test(event.url)) lines.push(`URL:${event.url}`);
  lines.push(
    `STATUS:${event.cancelled === true || method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
  );
  lines.push(`SEQUENCE:${Math.max(0, Math.trunc(event.sequence ?? 0))}`);
  if (event.updatedAt != null) lines.push(`LAST-MODIFIED:${stamp(event.updatedAt)}`);
  if (event.organizer != null) {
    const cn = event.organizer.name ? `;CN=${param(event.organizer.name)}` : '';
    lines.push(`ORGANIZER${cn}:${mailto(event.organizer.email)}`);
  }
  // A published calendar names nobody: it is read, not answered.
  if (method !== 'PUBLISH')
    for (const a of event.attendees ?? []) {
      const cn = a.name ? `;CN=${param(a.name)}` : '';
      const answer = PARTSTAT[a.response ?? ''] ?? 'NEEDS-ACTION';
      lines.push(
        `ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=${answer};RSVP=${answer === 'NEEDS-ACTION' ? 'TRUE' : 'FALSE'}:${mailto(a.email)}`,
      );
    }
  lines.push('END:VEVENT');
  return lines;
}

/** A calendar of events as iCalendar text. */
export function toIcs(
  events: readonly IcsEvent[],
  options: { readonly method: IcsMethod; readonly name?: string; readonly now?: Date },
): string {
  const now = options.now ?? new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Shutro ERP//Agenda//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${options.method}`,
    ...(options.name === undefined ? [] : [`X-WR-CALNAME:${text(options.name)}`]),
    ...events.flatMap((e) => eventLines(e, options.method, now)),
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
