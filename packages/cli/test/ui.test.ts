import { expect, test } from 'vitest';
import { createUi, detectTerminal, PLAIN_TERMINAL, width } from '../src/ui.js';

const capture = () => {
  const out: string[] = [];
  return { out, write: (t: string) => out.push(t), text: () => out.join('') };
};

test('plain output: icons and words, no escape codes', async () => {
  const c = capture();
  const ui = createUi(c.write, PLAIN_TERMINAL, { steps: 3 });
  await ui.banner('subtitle');
  ui.step('database', 'Database', 'a hint');
  ui.ok('connected (PostgreSQL 18.1)');
  ui.warn('careful');
  ui.fail('broken');
  ui.detail('kept    .env');
  const value = await ui.task('Creating the tables', async (t) => {
    t.update('applying');
    t.finish('Tables ready');
    return 42;
  });
  ui.card('Kosh is set up', [
    ['Company', 'Padma Traders (BDT)'],
    ['API', 'http://localhost:3000'],
  ]);
  const text = c.text();
  expect(value).toBe(42);
  expect(text).not.toContain('\u001b[');
  expect(text).toContain('◆  Step 1/3 · Database');
  expect(text).toContain('  ✔ connected (PostgreSQL 18.1)\n');
  expect(text).toContain('  ▲ careful\n');
  expect(text).toContain('  ✖ broken\n');
  expect(text).toContain('    • kept    .env\n');
  expect(text).toContain('  ✔ Tables ready\n');
  expect(text).not.toContain('applying'); // spinner text only on a terminal
  expect(text).toMatch(/╭─+╮\n {2}│ Kosh is set up +│\n/);
  // Every card row has the same width.
  const rows = text.split('\n').filter((l) => l.includes('│'));
  expect(new Set(rows.map((r) => width(r))).size).toBe(1);
});

test('a failing task prints ✖ and rethrows', async () => {
  const c = capture();
  const ui = createUi(c.write);
  await expect(
    ui.task('Connecting', async () => {
      throw new Error('refused');
    }),
  ).rejects.toThrow('refused');
  expect(c.text()).toBe('  ✖ Connecting\n');
});

test('ASCII terminals get ASCII marks', () => {
  const c = capture();
  const ui = createUi(c.write, { ...PLAIN_TERMINAL, unicode: false });
  ui.ok('done');
  ui.card('Title', [['A', 'b']]);
  expect(c.text()).toContain('  [ok] done\n');
  expect(c.text()).toContain('+-');
  expect(ui.progress(1, 2, 'x')).toBe('##########.......... 1/2 x');
});

test('on a terminal: colours, a spinner, and lines above it', async () => {
  const c = capture();
  const ui = createUi(c.write, { ...PLAIN_TERMINAL, color: true, animate: true }, { frameMs: 5 });
  await ui.task('Working', async (t) => {
    ui.detail('a line while spinning');
    t.update('half way');
    await new Promise((r) => setTimeout(r, 20));
  });
  const text = c.text();
  expect(text).toContain('\u001b[2K'); // the spinner line is cleared
  expect(text).toContain('half way');
  expect(text).toContain('a line while spinning');
  expect(text).toContain('\u001b[32m✔\u001b[39m Working');
});

test('detectTerminal', () => {
  const tty = { isTTY: true, columns: 200 };
  expect(detectTerminal(tty, {}, 'linux')).toMatchObject({
    color: true,
    unicode: true,
    emoji: true,
    animate: true,
    columns: 120,
  });
  expect(detectTerminal(tty, { NO_COLOR: '1' }, 'linux').color).toBe(false);
  expect(detectTerminal(tty, { CI: 'true' }, 'linux').animate).toBe(false);
  expect(detectTerminal({}, { FORCE_COLOR: '1' }, 'linux')).toMatchObject({
    color: true,
    animate: false,
    emoji: false,
  });
  expect(detectTerminal(tty, {}, 'win32').unicode).toBe(false); // the old console host
  expect(detectTerminal(tty, { WT_SESSION: 'x' }, 'win32').unicode).toBe(true);
  expect(detectTerminal(tty, { KOSH_ASCII: '1' }, 'linux').unicode).toBe(false);
});

test('width counts columns', () => {
  expect(width('abc')).toBe(3);
  expect(width('\u001b[32m✔\u001b[39m ok')).toBe(4);
  expect(width('🚀 go')).toBe(5);
});
