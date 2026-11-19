/**
 * Rich text rebuilt from an allow-list (RFC 0034 §2.4): what a note needs comes through as written; scripts, styles,
 * frames, handlers and odd addresses never do, however the markup is malformed or disguised; what is not understood
 * becomes text; the result is stable when sanitized again.
 */
import { expect, test } from 'vitest';
import { decodeEntities, HTML_LIMIT, htmlToText, sanitizeHtml } from '../src/html.js';

test('what a note needs comes through', () => {
  const note =
    '<h2>Minutes</h2><p>We <strong>agreed</strong> on <em>three</em> <u>points</u>, <s>not four</s>:</p>' +
    '<ul><li>Price</li><li>Delivery</li></ul><ol start="3"><li>Terms</li></ol>' +
    '<blockquote><p>As said</p></blockquote><pre><code>x = 1</code></pre><hr>' +
    '<table><thead><tr><th colspan="2">Item</th></tr></thead><tbody><tr><td>A</td><td rowspan="2">B</td></tr></tbody></table>';
  expect(sanitizeHtml(note)).toBe(note);
  // A line break and plain text with the characters that mean something in HTML.
  expect(sanitizeHtml('<p>1 &lt; 2 &amp; 3 &gt; 2<br>next</p>')).toBe(
    '<p>1 &lt; 2 &amp; 3 &gt; 2<br>next</p>',
  );
  expect(sanitizeHtml('just text, 1 < 2')).toBe('just text, 1 &lt; 2');
  expect(sanitizeHtml('')).toBe('');
});

test('links and images: only addresses that are what they look like', () => {
  expect(sanitizeHtml('<a href="https://example.com/a?b=1&amp;c=2" onclick="x()">site</a>')).toBe(
    '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">site</a>',
  );
  for (const ok of ['mailto:a@b.test', 'tel:+8801711000001', '/sales/a/x/42', '#top'])
    expect(sanitizeHtml(`<a href="${ok}">x</a>`)).toContain(`href="${ok}"`);
  // Anything else: the link goes, its text stays.
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' java\tscript:alert(1)',
    'java&#x73;cript:alert(1)',
    '&#106;avascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    '//evil.example/x',
    'file:///etc/passwd',
  ])
    expect(sanitizeHtml(`<a href="${bad}">x</a>`), bad).toBe('x');
  expect(sanitizeHtml('<a>no address</a>')).toBe('no address');

  expect(
    sanitizeHtml(
      '<img src="https://cdn.example/a.png" alt="A &quot;chart&quot;" width="320" height="200" onerror="x()">',
    ),
  ).toBe(
    '<img src="https://cdn.example/a.png" alt="A &quot;chart&quot;" width="320" height="200">',
  );
  expect(sanitizeHtml('<img src="/api/v1/files/12">')).toBe('<img src="/api/v1/files/12">');
  for (const bad of [
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'http://plain.example/a.png',
    'x',
  ])
    expect(sanitizeHtml(`<p>a<img src="${bad}">b</p>`), bad).toBe('<p>ab</p>');
  expect(sanitizeHtml('<img src="https://x.example/a.png" width="99999999" height="-1">')).toBe(
    '<img src="https://x.example/a.png">',
  );
});

test('mentions and links to records keep what identifies them, and nothing else', () => {
  expect(
    sanitizeHtml(
      '<span data-type="mention" data-id="7" data-label="Dina Rahman" class="x" style="color:red">@Dina Rahman</span>',
    ),
  ).toBe('<span data-type="mention" data-id="7" data-label="Dina Rahman">@Dina Rahman</span>');
  expect(
    sanitizeHtml(
      '<span data-type="record" data-model="sale.order" data-id="42" data-label="SO/2026/00042">SO</span>',
    ),
  ).toBe(
    '<span data-type="record" data-model="sale.order" data-id="42" data-label="SO/2026/00042">SO</span>',
  );
  // A span that is nothing of the kind is only its text; an odd model or id is left out.
  expect(sanitizeHtml('<span style="position:fixed">x</span>')).toBe('x');
  expect(sanitizeHtml('<span data-type="evil" data-id="1">x</span>')).toBe('x');
  expect(
    sanitizeHtml('<span data-type="record" data-model="../etc" data-id="1 OR 1=1">x</span>'),
  ).toBe('<span data-type="record">x</span>');
});

test('nothing that runs or frames comes out, however it is written', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)><circle/></svg>',
    '<math><mtext><script>alert(1)</script></mtext></math>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object><embed src="x">',
    '<style>p{background:url(javascript:alert(1))}</style>',
    '<p style="background:url(javascript:alert(1))" onmouseover="alert(1)">x</p>',
    '<form action="https://evil.example"><input name="password"><button>go</button></form>',
    '<a href="https://ok.example" onclick="alert(1)" style="x" target="_top">x</a>',
    '<div onclick="alert(1)">x</div>',
    '<body onload=alert(1)>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<base href="https://evil.example/">',
    '<p>ok</p><script>unclosed, hiding the rest <p>hidden</p>',
    '<!--<script>alert(1)</script>-->',
    '<![CDATA[<script>alert(1)</script>]]>',
    '<?xml version="1.0"?><p>x</p>',
    '<img src="https://x.example/a.png"onerror="alert(1)">',
    '<a href="https://x.example"\nonclick="alert(1)">x</a>',
    '<p title="><script>alert(1)</script>">x</p>',
    '<textarea><script>alert(1)</script></textarea>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    '<template><script>alert(1)</script></template>',
  ];
  for (const attack of attacks) {
    const out = sanitizeHtml(attack);
    expect(out, attack).not.toMatch(
      /<\s*(script|style|iframe|object|embed|svg|math|form|input|button|meta|link|base|template|textarea|body|div)\b/i,
    );
    expect(out, attack).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out, attack).not.toMatch(/javascript:/i);
    expect(out, attack).not.toMatch(/\sstyle\s*=/i);
    // Every `<` that is left opens a tag of the allow-list.
    for (const tag of out.match(/<\/?([a-z0-9]+)/gi) ?? [])
      expect(
        [
          'p',
          'br',
          'hr',
          'strong',
          'b',
          'em',
          'i',
          'u',
          's',
          'code',
          'pre',
          'blockquote',
          'h1',
          'h2',
          'h3',
          'h4',
          'ul',
          'ol',
          'li',
          'a',
          'img',
          'table',
          'thead',
          'tbody',
          'tr',
          'th',
          'td',
          'span',
        ],
        `${attack} → ${out}`,
      ).toContain(tag.replace(/[</]/g, '').toLowerCase());
  }
  // The hidden paragraph after an unclosed script does not come back.
  expect(sanitizeHtml('<p>ok</p><script>unclosed <p>hidden</p>')).toBe('<p>ok</p>');
  // Text that looks like a tag after its references are read stays text.
  expect(sanitizeHtml('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
  expect(sanitizeHtml('&#60;img src=x onerror=alert(1)&#62;')).toBe(
    '&lt;img src=x onerror=alert(1)&gt;',
  );
});

test('what is not understood becomes text; what is left open is closed', () => {
  expect(
    sanitizeHtml(
      '<div class="x"><font color="red">Hello</font> <custom-tag>world</custom-tag></div>',
    ),
  ).toBe('Hello world');
  expect(sanitizeHtml('<p>one<p>two')).toBe('<p>one</p><p>two</p>');
  expect(sanitizeHtml('<ul><li>a<li>b')).toBe('<ul><li>a<li>b</li></li></ul>');
  expect(sanitizeHtml('<strong>bold <em>both</strong> tail</em>')).toBe(
    '<strong>bold <em>both</em></strong> tail',
  );
  expect(sanitizeHtml('</p></div>stray ends')).toBe('stray ends');
  expect(sanitizeHtml('a < b and c > d')).toBe('a &lt; b and c &gt; d');
  expect(sanitizeHtml('<p>a paragraph<h2>then a heading</h2>')).toBe(
    '<p>a paragraph</p><h2>then a heading</h2>',
  );
  // Nested too deep to be a document: the nesting stops, the text stays.
  const deep = sanitizeHtml(`${'<blockquote>'.repeat(200)}deep${'</blockquote>'.repeat(200)}`);
  expect(deep.match(/<blockquote>/g)).toHaveLength(40);
  expect(deep).toContain('deep');
  // Over the limit: cut, and still well formed.
  const long = sanitizeHtml(`<p>${'a'.repeat(HTML_LIMIT + 10)}</p>`);
  expect(long.length).toBeLessThanOrEqual(HTML_LIMIT + 10);
  expect(long.endsWith('</p>')).toBe(true);
});

test('sanitizing again changes nothing', () => {
  for (const input of [
    '<h2>Minutes</h2><p>We <strong>agreed</strong>: 1 &lt; 2 &amp; done</p><a href="https://x.example/?a=1&amp;b=2">x</a>',
    '<p>one<p>two<script>x</script><img src=x onerror=alert(1)>',
    '<table><tr><td colspan="2">a</td></tr></table>',
    'a &amp;lt; b',
  ]) {
    const once = sanitizeHtml(input);
    expect(sanitizeHtml(once), input).toBe(once);
  }
});

test('rich text as plain text; character references', () => {
  expect(
    htmlToText(
      '<h2>Minutes</h2><p>We <strong>agreed</strong>.<br>Twice.</p><ul><li>Price</li><li>Delivery &amp; terms</li></ul>',
    ),
  ).toBe('Minutes\nWe agreed.\nTwice.\n• Price\n• Delivery & terms');
  expect(
    htmlToText('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>'),
  ).toBe('A\tB\nC\tD');
  expect(htmlToText('<script>alert(1)</script><p>safe</p>')).toBe('safe');
  expect(
    decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &#65;&#x42; &nbsp;&unknown; &#0; &#x110000;'),
  ).toBe('<a> & "b" AB  &unknown;  ');
});
