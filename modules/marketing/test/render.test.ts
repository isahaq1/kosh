/**
 * A campaign's message without a database (RFC 0038, Campaigns): addresses as keys, placeholders, the links to
 * follow, the A/B halves, and the composed email with its way out.
 */
import { expect, test } from 'vitest';
import { compose, emailKey, linksOf, percent, personalize, variantOf } from '../src/render.js';

const who = { name: 'Nadia Karim', email: 'nadia@example.com' };
const tracking = {
  click: (n: number) => `https://erp.test/c/TOKEN/${n}`,
  open: 'https://erp.test/o/TOKEN.gif',
  unsubscribe: 'https://erp.test/u/TOKEN',
};

test('an address is compared trimmed and in lower case; what is not an address has no key', () => {
  expect(emailKey('  Nadia@Example.COM ')).toBe('nadia@example.com');
  for (const bad of ['', 'nadia', 'nadia@', '@example.com', 'a b@example.com', 'a@b', null])
    expect(emailKey(bad)).toBeNull();
});

test('placeholders are filled per person, with a fallback, and escaped in HTML', () => {
  expect(personalize('Hi {{first_name}} <{{email}}>', who, false)).toBe(
    'Hi Nadia <nadia@example.com>',
  );
  expect(personalize('Dear {{ name | customer }},', { name: ' ', email: 'x@y.z' }, false)).toBe(
    'Dear customer,',
  );
  expect(personalize('{{first_name|Hello}}!', { name: '', email: 'x@y.z' }, false)).toBe('Hello!');
  // A name is data: it cannot bring markup into the message.
  expect(personalize('<p>{{name}}</p>', { name: '<b>Eve</b>', email: 'e@y.z' }, true)).toBe(
    '<p>&lt;b&gt;Eve&lt;/b&gt;</p>',
  );
  expect(personalize('{{unknown}}x', who, false)).toBe('x');
});

test('the links to follow: web links, each once, in order', () => {
  const body =
    '<a href="https://a.test/?x=1&amp;y=2">A</a> <a href="mailto:x@y.z">M</a> <a href="https://b.test">B</a> <a href="https://a.test/?x=1&amp;y=2">again</a>';
  expect(linksOf(body)).toEqual(['https://a.test/?x=1&y=2', 'https://b.test']);
});

test('with a second subject, recipients alternate; without, all get A', () => {
  expect([0, 1, 2, 3].map((n) => variantOf(n, true))).toEqual(['a', 'b', 'a', 'b']);
  expect([0, 1, 2].map((n) => variantOf(n, false))).toEqual(['a', 'a', 'a']);
});

test('a composed message: links through the server, the open counted, the way out always there', () => {
  const body =
    '<p>Dear {{name}},</p><p><a href="https://shop.test/offers?a=1&amp;b=2">Offers</a></p>';
  const mail = compose({
    subject: '{{first_name}}, winter prices',
    preheader: 'Three days only',
    body,
    who,
    links: linksOf(body),
    tracking,
    language: 'en',
    sender: 'Padma Traders',
  });
  expect(mail.subject).toBe('Nadia, winter prices');
  expect(mail.html).toContain('Dear Nadia Karim,');
  expect(mail.html).toContain('href="https://erp.test/c/TOKEN/0"');
  expect(mail.html).not.toContain('shop.test');
  expect(mail.html).toContain('src="https://erp.test/o/TOKEN.gif"');
  expect(mail.html).toContain('href="https://erp.test/u/TOKEN"');
  expect(mail.html).toContain('Three days only');
  expect(mail.text).toContain('Unsubscribe: https://erp.test/u/TOKEN');
  expect(mail.headers).toEqual({
    'List-Unsubscribe': '<https://erp.test/u/TOKEN>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  // In Bangla for a recipient who reads Bangla.
  const bn = compose({
    ...{ subject: 's', preheader: null, body, who, links: [], tracking },
    language: 'bn',
    sender: 'পদ্মা',
  });
  expect(bn.html).toContain('তালিকা থেকে বাদ দিন');
});

test('a test send is the message as written: nothing counted, no way out needed', () => {
  const body = '<a href="https://shop.test">Shop</a>';
  const mail = compose({
    subject: 's',
    preheader: null,
    body,
    who,
    links: linksOf(body),
    tracking: null,
    language: 'en',
    sender: 'Padma',
  });
  expect(mail.html).toContain('href="https://shop.test"');
  expect(mail.html).not.toContain('<img');
  expect(mail.headers).toEqual({});
});

test('a share to one place, or nothing over nothing', () => {
  expect(percent(1, 8)).toBe('12.5');
  expect(percent(2, 3)).toBe('66.7');
  expect(percent(0, 0)).toBeNull();
});

test('a phone number is known in E.164; a local one takes the country code given', async () => {
  const { phoneKey } = await import('../src/render.js');
  expect(phoneKey('+880 1711-000001')).toBe('+8801711000001');
  expect(phoneKey('008801711000001')).toBe('+8801711000001');
  expect(phoneKey('01711 000001', '+880')).toBe('+8801711000001');
  // Without a country code a local number is nobody's.
  expect(phoneKey('01711000001')).toBeNull();
  for (const bad of ['', 'call me', '+12', null]) expect(phoneKey(bad, '+880')).toBeNull();
});

test('a text message: the text per person, and the way out when asked', async () => {
  const { composeText } = await import('../src/render.js');
  const who = { name: 'Nadia Karim', email: '' };
  expect(
    composeText({ text: 'Hi {{first_name}}, 15% off. ', who, unsubscribe: null, language: 'en' }),
  ).toBe('Hi Nadia, 15% off.');
  expect(
    composeText({ text: 'Hi', who, unsubscribe: 'https://erp.test/u/T', language: 'bn' }),
  ).toBe('Hi\nবন্ধ করুন: https://erp.test/u/T');
});
