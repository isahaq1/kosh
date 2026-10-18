import { describe, expect, test } from 'vitest';
import { mentionIds, plainText, renderBody } from '../src/body.js';

const users = new Map([
  [1, 'Mina <Manager>'],
  [2, 'Alice'],
]);

describe('message bodies', () => {
  test('everything typed is escaped; only our markup is emitted', () => {
    for (const attack of [
      '<img src=x onerror=alert(1)>',
      '"><svg onload=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      'javascript:alert(1)',
      '[x](javascript:alert(1))',
      '**<b>bold</b>**',
      '`<script>`',
      '@[<i>x</i>](user:2)',
      'https://example.com/"onmouseover="alert(1)',
      '\u0000 0 \u0000',
    ]) {
      const html = renderBody(attack, users);
      // Every tag is one we emit, with only the attributes we set.
      for (const [, tag, attrs] of html.matchAll(/<\/?([a-z]+)([^>]*)>/g)) {
        expect(['p', 'br', 'ul', 'li', 'strong', 'em', 'code', 'span', 'a'], attack).toContain(tag);
        const names = [...(attrs ?? '').matchAll(/\s([a-z-]+)="/g)].map((m) => m[1]);
        expect(
          names.every((n) => ['class', 'data-user', 'href', 'target', 'rel'].includes(n as string)),
          `${attack} -> ${html}`,
        ).toBe(true);
        for (const [, href] of (attrs ?? '').matchAll(/href="([^"]*)"/g))
          expect(href, attack).toMatch(/^https?:\/\//);
      }
    }
  });

  test('markup: paragraphs, breaks, lists, bold, italic, code, links, mentions with current names', () => {
    expect(renderBody('a\nb\n\nc', users)).toBe('<p>a<br>b</p><p>c</p>');
    expect(renderBody('intro\n- one\n* two\nafter', users)).toBe(
      '<p>intro</p><ul><li>one</li><li>two</li></ul><p>after</p>',
    );
    expect(renderBody('**b** _i_ `c **not bold**`', users)).toBe(
      '<p><strong>b</strong> <em>i</em> <code>c **not bold**</code></p>',
    );
    expect(renderBody('see https://kosh.dev/a_b_c.', users)).toBe(
      '<p>see <a href="https://kosh.dev/a_b_c" target="_blank" rel="noopener noreferrer nofollow">https://kosh.dev/a_b_c</a>.</p>',
    );
    expect(renderBody('@[old name](user:1) and @[x](user:9)', users)).toBe(
      '<p><span class="mention" data-user="1">@Mina &lt;Manager&gt;</span> and @x</p>',
    );
    expect(renderBody('snake_case_name', users)).toBe('<p>snake_case_name</p>');
  });

  test('mentions and plain text', () => {
    expect(mentionIds('@[a](user:2) @[b](user:1) @[a](user:2) @[c](user:0)')).toEqual([2, 1]);
    expect(plainText('Hi @[x](user:2), **now** `code`', users)).toBe('Hi @Alice, now code');
  });
});
