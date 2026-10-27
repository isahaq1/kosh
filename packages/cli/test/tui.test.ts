/**
 * The installer's interactive questions (`tui.ts`), driven by keypresses on a fake terminal: what the screen shows
 * after each answer (a small emulator replays the cursor moves), the answers, validation, Ctrl+C.
 */
import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { CancelledError, interactivePrompter } from '../src/tui.js';
import { PLAIN_TERMINAL } from '../src/ui.js';

/** A fake TTY: keypresses in, and the screen the written escape codes leave (colours ignored). */
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => input,
  }) as unknown as NodeJS.ReadStream & PassThrough;
  const screen: string[] = [''];
  let row = 0;
  let col = 0;
  const output = {
    columns: 80,
    write(chunk: string) {
      const text = chunk
        // biome-ignore lint/suspicious/noControlCharactersInRegex: escape codes are what is removed
        .replace(/\u001b\[[0-9;]*m/g, '')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: escape codes are what is removed
        .replace(/\u001b\[\?25[hl]/g, '');
      for (let i = 0; i < text.length; i++) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the cursor moves are what is replayed
        const esc = /^\u001b\[(\d*)([AJ])/.exec(text.slice(i));
        if (esc !== null) {
          if (esc[2] === 'A') row = Math.max(0, row - Number(esc[1] || 1));
          else {
            screen.splice(row + 1);
            screen[row] = (screen[row] ?? '').slice(0, col);
          }
          i += esc[0].length - 1;
          continue;
        }
        const ch = text[i] as string;
        if (ch === '\r') col = 0;
        else if (ch === '\n') {
          row += 1;
          col = 0;
          screen[row] ??= '';
        } else {
          const line = (screen[row] ?? '').padEnd(col);
          screen[row] = line.slice(0, col) + ch + line.slice(col + 1);
          col += 1;
        }
      }
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const press = (text: string | undefined, key: Record<string, unknown> = {}) =>
    new Promise<void>((done) =>
      setImmediate(() => {
        input.emit('keypress', text, key);
        done();
      }),
    );
  const type = async (text: string) => {
    for (const ch of text) await press(ch, { name: ch === ' ' ? 'space' : ch.toLowerCase() });
  };
  return {
    input,
    output,
    press,
    type,
    enter: () => press('\r', { name: 'return' }),
    shown: () => screen.join('\n').replace(/[ \t]+$/gm, ''),
  };
}

const unicodeTty = { ...PLAIN_TERMINAL, animate: true };

test('a text question: the default until typed over, collapsed to its answer', async () => {
  const t = fakeTerminal();
  const prompter = interactivePrompter(t.input, t.output, unicodeTty);
  const answer = prompter.ask({ message: 'Company name', default: 'My Company' });
  await t.press(undefined);
  expect(t.shown()).toContain('◆  Company name\n│   My Company\n└');
  await t.type('Padma');
  await t.press(undefined, { name: 'backspace' });
  await t.enter();
  expect(await answer).toBe('Padm');
  expect(t.shown()).toBe('│\n◇  Company name\n│  Padm\n');
});

test('a refused answer says why under the input; Enter on a default takes it', async () => {
  const t = fakeTerminal();
  const prompter = interactivePrompter(t.input, t.output, unicodeTty);
  const answer = prompter.ask({
    message: 'API port',
    default: '3000',
    validate: (v) => (/^\d+$/.test(v) ? null : 'A port number'),
  });
  await t.type('x');
  await t.enter();
  expect(t.shown()).toContain('▲  API port\n│  x\n└  A port number');
  await t.press(undefined, { name: 'backspace' });
  await t.enter();
  expect(await answer).toBe('3000');
});

test('a secret is masked, also once answered', async () => {
  const t = fakeTerminal();
  const prompter = interactivePrompter(t.input, t.output, unicodeTty);
  const answer = prompter.ask({ message: 'Password', secret: true });
  await t.type('hunter2');
  expect(t.shown()).toContain('│  •••••••\n');
  await t.enter();
  expect(await answer).toBe('hunter2');
  expect(t.shown()).not.toContain('hunter2');
});

test('one of several, with the arrows', async () => {
  const t = fakeTerminal();
  const prompter = interactivePrompter(t.input, t.output, unicodeTty);
  const answer = prompter.select?.({
    message: 'Which PostgreSQL?',
    choices: [
      { value: 'server', label: 'A server I already have', hint: 'host, port, user' },
      { value: 'docker', label: 'Start one in Docker for me', hint: 'PostgreSQL 18' },
    ],
    default: 'docker',
  });
  await t.press(undefined);
  expect(t.shown()).toContain('│   ○ A server I already have     host, port, user');
  expect(t.shown()).toContain('│ ❯ ● Start one in Docker for me  PostgreSQL 18');
  await t.press(undefined, { name: 'up' });
  await t.enter();
  expect(await answer).toBe('server');
  expect(t.shown()).toBe('│\n◇  Which PostgreSQL?\n│  A server I already have\n');
});

test('several of several: Space toggles, a toggles all, at least one when required', async () => {
  const t = fakeTerminal();
  const prompter = interactivePrompter(t.input, t.output, unicodeTty);
  const answer = prompter.multiselect?.({
    message: 'Apps to install',
    choices: [
      { value: 'sales', label: 'sales', hint: 'quotations and orders' },
      { value: 'purchase', label: 'purchase' },
      { value: 'accounting', label: 'accounting' },
    ],
    defaults: ['sales', 'purchase', 'accounting'],
    required: true,
  });
  await t.press('a', { name: 'a' }); // all ticked: untick all
  await t.enter();
  expect(t.shown()).toContain('└  Choose at least one.');
  await t.press(undefined, { name: 'down' });
  await t.press(' ', { name: 'space' });
  expect(t.shown()).toContain('│ ❯ ◼ purchase');
  expect(t.shown()).toContain('│   ◻ sales       quotations and orders');
  await t.enter();
  expect(await answer).toEqual(['purchase']);
  expect(t.shown()).toBe('│\n◇  Apps to install\n│  purchase\n');
});

test('Yes / No, and Ctrl+C cancels', async () => {
  const t = fakeTerminal();
  const prompter = interactivePrompter(t.input, t.output, unicodeTty);
  const yes = prompter.confirm('Load demo data?', false);
  await t.press(undefined, { name: 'right' });
  expect(t.shown()).toContain('│  ● Yes / ○ No');
  await t.enter();
  expect(await yes).toBe(true);
  const stopped = prompter.ask({ message: 'Company name' });
  await t.press('\u0003', { name: 'c', ctrl: true });
  await expect(stopped).rejects.toBeInstanceOf(CancelledError);
  expect(t.shown()).toContain('■  Company name\n│  cancelled');
});
