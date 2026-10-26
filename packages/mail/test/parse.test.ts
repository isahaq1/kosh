/**
 * Inbound parsing (RFC 0006 §7.1): reply addresses round-trip and refuse tampering; a raw message yields its
 * sender, recipients, text and attachments; HTML from outside is reduced to the allow-list; quoted history is
 * cut; auto-replies and bounces are recognised; Postmark's JSON maps to the same shape.
 */
import { expect, test } from 'vitest';
import {
  cleanHtml,
  cutQuotes,
  fromPostmark,
  htmlToText,
  parseMail,
  parseReplyAddress,
  replyAddress,
} from '../src/index.js';

const config = { secret: 'top secret', domain: 'mail.example.com', alias: 'reply' };

test('reply addresses: made and read back; a tampered token, another domain or alias is nobody', () => {
  const target = { model: 'sale.order', id: 12, uid: 7 };
  const address = replyAddress(config, target);
  expect(address).toMatch(/^reply\+sale\.order-12-7-[a-z2-7]{20}@mail\.example\.com$/);
  expect(parseReplyAddress(config, address)).toEqual(target);
  expect(parseReplyAddress(config, address.toUpperCase())).toEqual(target);
  expect(parseReplyAddress(config, address.replace('-7-', '-8-'))).toBeNull(); // another recipient
  expect(
    parseReplyAddress(config, address.replace('@mail.example.com', '@other.example.com')),
  ).toBeNull();
  expect(parseReplyAddress(config, address.replace('reply+', 'bounce+'))).toBeNull();
  expect(parseReplyAddress({ ...config, secret: 'other' }, address)).toBeNull();
  expect(parseReplyAddress(config, 'sales@mail.example.com')).toBeNull();
});

const RAW = [
  'From: Rahim Uddin <rahim@padma.test>',
  'To: reply+sale.order-12-7-abcdefghijklmnopqrst@mail.example.com',
  'Cc: Dina <dina@padma.test>',
  'Subject: Re: Rahim Uddin mentioned you on SO/2026/0001',
  'Message-ID: <reply-1@padma.test>',
  'In-Reply-To: <sent-1@kosh>',
  'References: <sent-0@kosh> <sent-1@kosh>',
  'Date: Mon, 26 Oct 2026 10:00:00 +0600',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Yes, the beams ship **Monday**.',
  '',
  'On Mon, 26 Oct 2026, Kosh <kosh@padma.test> wrote:',
  '> Rahim Uddin mentioned you on SO/2026/0001',
  '--b1',
  'Content-Type: text/plain; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('shipping note').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

test('a raw message: sender, recipients (to and cc, lowercase), text, threading headers, attachments', async () => {
  const mail = await parseMail(RAW);
  expect(mail.from).toEqual({ name: 'Rahim Uddin', address: 'rahim@padma.test' });
  expect(mail.to).toEqual([
    'reply+sale.order-12-7-abcdefghijklmnopqrst@mail.example.com',
    'dina@padma.test',
  ]);
  expect(mail.subject).toBe('Re: Rahim Uddin mentioned you on SO/2026/0001');
  expect(mail.messageId).toBe('<reply-1@padma.test>');
  expect(mail.inReplyTo).toBe('<sent-1@kosh>');
  expect(mail.references).toEqual(['<sent-0@kosh>', '<sent-1@kosh>']);
  expect(mail.text).toContain('Yes, the beams ship');
  expect(mail.html).toBeNull();
  expect(mail.attachments).toHaveLength(1);
  expect(mail.attachments[0]).toMatchObject({
    name: 'note.txt',
    mime: 'text/plain',
    inline: false,
  });
  expect(new TextDecoder().decode(mail.attachments[0]?.data)).toBe('shipping note');
  expect(mail.automatic).toBe(false);
  expect(cutQuotes(mail.text)).toBe('Yes, the beams ship **Monday**.');
});

test('quoted history is cut at the usual markers; the reply above it stays', () => {
  expect(cutQuotes('Agreed.\n\n-----Original Message-----\nFrom: x\nSent: y')).toBe('Agreed.');
  expect(cutQuotes('Agreed.\n\nFrom: Dina\nSent: Monday\nTo: Rahim')).toBe('Agreed.');
  expect(cutQuotes('Agreed.\n> old\n> older')).toBe('Agreed.');
  expect(cutQuotes('Agreed.\n\nLe 26 oct. 2026, Dina a écrit :\n> ...')).toBe('Agreed.');
  expect(cutQuotes('> a quote first\nthen text')).toBe('> a quote first\nthen text'); // nothing above it: kept
});

test('HTML from outside: the allow-list only, links made safe; text from HTML keeps the lines', () => {
  const html =
    '<div onclick="x()"><p>Hello <b>there</b><script>alert(1)</script></p><img src="x.png"><a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a><style>p{}</style></div>';
  const clean = cleanHtml(html);
  expect(clean).not.toContain('script');
  expect(clean).not.toContain('onclick');
  expect(clean).not.toContain('<img');
  expect(clean).not.toContain('javascript:');
  expect(clean).toContain(
    '<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">ok</a>',
  );
  expect(htmlToText('<p>First</p><p>Second<br>line</p><ul><li>a</li><li>b</li></ul>')).toBe(
    'First\nSecond\nline\na\nb',
  );
});

test('auto-replies and bounces never post', async () => {
  const auto = await parseMail(
    'From: Dina <dina@padma.test>\r\nTo: reply+x-1-1-aaaaaaaaaaaaaaaaaaaa@mail.example.com\r\nSubject: Out of office\r\nAuto-Submitted: auto-replied\r\nMessage-ID: <a@b>\r\n\r\nI am away.',
  );
  expect(auto).toMatchObject({ automatic: true, bounce: false });
  const bounce = await parseMail(
    'From: Mail Delivery System <MAILER-DAEMON@padma.test>\r\nTo: kosh@padma.test\r\nSubject: Undelivered\r\nIn-Reply-To: <sent-9@kosh>\r\nMessage-ID: <b@b>\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="r"\r\n\r\n--r\r\nContent-Type: text/plain\r\n\r\nfailed\r\n--r--\r\n',
  );
  expect(bounce).toMatchObject({ automatic: true, bounce: true, inReplyTo: '<sent-9@kosh>' });
  const bulk = await parseMail(
    'From: a@b\r\nTo: c@d\r\nPrecedence: bulk\r\nMessage-ID: <c@b>\r\n\r\nnews',
  );
  expect(bulk.automatic).toBe(true);
  const normal = await parseMail('From: a@b\r\nTo: c@d\r\nMessage-ID: <d@b>\r\n\r\nhello');
  expect(normal.automatic).toBe(false);
});

test("Postmark's JSON maps to the same shape (attachments from base64, headers for threading)", () => {
  const mail = fromPostmark({
    FromFull: { Email: 'Vendor@Example.com', Name: 'Vendor' },
    ToFull: [{ Email: 'reply+account.move-5-3-aaaaaaaaaaaaaaaaaaaa@mail.example.com' }],
    CcFull: [],
    Subject: 'Re: Bill',
    MessageID: 'pm-123',
    TextBody: 'Paid today.\n\nOn x wrote:\n> y',
    HtmlBody: '<p>Paid <b>today</b>.</p>',
    Headers: [
      { Name: 'In-Reply-To', Value: '<sent-2@kosh>' },
      { Name: 'References', Value: '<sent-2@kosh>' },
    ],
    Attachments: [
      {
        Name: 'receipt.pdf',
        Content: Buffer.from('%PDF').toString('base64'),
        ContentType: 'application/pdf',
        ContentID: '',
      },
    ],
  });
  expect(mail.from).toEqual({ name: 'Vendor', address: 'vendor@example.com' });
  expect(mail.to).toEqual(['reply+account.move-5-3-aaaaaaaaaaaaaaaaaaaa@mail.example.com']);
  expect(mail.messageId).toBe('<pm-123>');
  expect(mail.inReplyTo).toBe('<sent-2@kosh>');
  expect(mail.html).toBe('<p>Paid <b>today</b>.</p>');
  expect(cutQuotes(mail.text)).toBe('Paid today.');
  expect(mail.attachments[0]).toMatchObject({
    name: 'receipt.pdf',
    mime: 'application/pdf',
    inline: false,
  });
  expect(new TextDecoder().decode(mail.attachments[0]?.data)).toBe('%PDF');
});
