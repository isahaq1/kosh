/**
 * iCalendar text (RFC 0034 §2.4), without a database: an invitation with its organizer and attendees, a
 * cancellation, an all-day event, a published calendar; text escaped, long lines folded without cutting a
 * character, CRLF line ends, and nothing a title or an address can inject.
 */
import { expect, test } from 'vitest';
import { foldLine, toIcs } from '../src/ics.js';

const NOW = new Date('2026-11-19T06:00:00Z');
const meeting = {
  uid: 'event-42@erp.example.test',
  start: new Date('2030-01-07T04:00:00Z'),
  stop: new Date('2030-01-07T05:00:00Z'),
  title: 'Weekly review',
  organizer: { email: 'rahim@padma.test', name: 'Rahim Uddin' },
  attendees: [
    { email: 'sumi@padma.test', name: 'Sumi Akter', response: 'needs_action' },
    { email: 'buyer@meghna.example', name: 'Meghna Traders, Ltd.', response: 'accepted' },
  ],
};
/** The unfolded lines of an iCalendar text. */
const linesOf = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

test('an invitation: the event in UTC, its organizer, each attendee with their answer', () => {
  const ics = toIcs(
    [{ ...meeting, sequence: 2, location: 'Board room', url: 'https://meet.example/abc' }],
    {
      method: 'REQUEST',
      now: NOW,
    },
  );
  expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  expect(ics.includes('\n') && !/[^\r]\n/.test(ics)).toBe(true); // every line ends CRLF
  expect(linesOf(ics)).toEqual([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Shutro ERP//Agenda//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:event-42@erp.example.test',
    'DTSTAMP:20261119T060000Z',
    'DTSTART:20300107T040000Z',
    'DTEND:20300107T050000Z',
    'SUMMARY:Weekly review',
    'LOCATION:Board room',
    'URL:https://meet.example/abc',
    'STATUS:CONFIRMED',
    'SEQUENCE:2',
    'ORGANIZER;CN=Rahim Uddin:mailto:rahim@padma.test',
    'ATTENDEE;CN=Sumi Akter;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sumi@padma.test',
    // A name with a comma is quoted, or it would end the parameter.
    'ATTENDEE;CN="Meghna Traders, Ltd.";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:buyer@meghna.example',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]);
});

test('a cancellation; an all-day event; a published calendar names no attendee', () => {
  const cancel = linesOf(toIcs([{ ...meeting, sequence: 3 }], { method: 'CANCEL', now: NOW }));
  expect(cancel).toContain('METHOD:CANCEL');
  expect(cancel).toContain('STATUS:CANCELLED');
  expect(cancel).toContain('SEQUENCE:3');

  // Two days, both included: the end is the day after the last.
  const allDay = linesOf(
    toIcs([{ ...meeting, allDay: { startDate: '2030-02-28', stopDate: '2030-03-01' } }], {
      method: 'PUBLISH',
      name: 'Rahim — Agenda',
      now: NOW,
    }),
  );
  expect(allDay).toContain('DTSTART;VALUE=DATE:20300228');
  expect(allDay).toContain('DTEND;VALUE=DATE:20300302');
  expect(allDay).toContain('X-WR-CALNAME:Rahim — Agenda');
  expect(allDay.some((l) => l.startsWith('ATTENDEE'))).toBe(false);
  expect(allDay.some((l) => l.startsWith('ORGANIZER'))).toBe(true);
  // A cancelled event of a feed says so.
  expect(
    linesOf(toIcs([{ ...meeting, cancelled: true }], { method: 'PUBLISH', now: NOW })),
  ).toContain('STATUS:CANCELLED');
});

test('text is escaped; a title or an address cannot add a line or a property', () => {
  const ics = toIcs(
    [
      {
        ...meeting,
        title: 'Budget; Q1, final\r\nATTENDEE:mailto:intruder@evil.example',
        description: 'Line one\nLine two \\ done',
        url: 'javascript:alert(1)',
        organizer: { email: 'rahim@padma.test\r\nX-EVIL:1', name: 'Rahim "the boss"\r\nX-EVIL:2' },
        attendees: [{ email: 'a b@padma.test>\r\nSTATUS:CANCELLED', name: null }],
      },
    ],
    { method: 'REQUEST', now: NOW },
  );
  const lines = linesOf(ics);
  expect(lines).toContain('SUMMARY:Budget\\; Q1\\, final\\nATTENDEE:mailto:intruder@evil.example');
  expect(lines).toContain('DESCRIPTION:Line one\\nLine two \\\\ done');
  // Nothing injected became a line of its own, and the odd URL is left out.
  expect(lines.filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(1);
  expect(lines.some((l) => l.startsWith('X-EVIL'))).toBe(false);
  expect(lines.filter((l) => l.startsWith('STATUS:'))).toEqual(['STATUS:CONFIRMED']);
  expect(lines.some((l) => l.startsWith('URL:'))).toBe(false);
  expect(lines).toContain(
    'ORGANIZER;CN=Rahim  the boss   X-EVIL:2:mailto:rahim@padma.testX-EVIL:1'.replace(
      'CN=Rahim  the boss   X-EVIL:2',
      'CN="Rahim  the boss   X-EVIL:2"',
    ),
  );
});

test('long lines fold at 75 bytes, never inside a character', () => {
  expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  const long = `SUMMARY:${'a'.repeat(200)}`;
  const folded = foldLine(long);
  const parts = folded.split('\r\n');
  expect(parts[0]).toHaveLength(75);
  expect(parts.slice(1).every((p) => p.startsWith(' ') && Buffer.byteLength(p) <= 75)).toBe(true);
  expect(folded.replace(/\r\n /g, '')).toBe(long);
  // Bangla: three bytes a letter. Every piece is whole text, and they join back to the line.
  const bangla = `SUMMARY:${'সাপ্তাহিক পর্যালোচনা সভা '.repeat(8)}`;
  const pieces = foldLine(bangla).split('\r\n');
  expect(pieces.every((p) => Buffer.byteLength(p, 'utf8') <= 75)).toBe(true);
  expect(pieces.every((p) => !p.includes('�'))).toBe(true);
  expect(pieces.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(bangla);
});
