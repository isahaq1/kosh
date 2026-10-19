import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { InputEndedError, terminalPrompter } from '../src/prompt.js';

const streams = () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const out: string[] = [];
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  (output as unknown as PassThrough).on('data', (c: Buffer) => out.push(c.toString()));
  return { input, output, out };
};

test('answers piped in all at once are each kept for their question; defaults and validation apply', async () => {
  const { input, output, out } = streams();
  const p = terminalPrompter(input, output);
  (input as unknown as PassThrough).write('\nshort\na long enough secret\nbn\n');
  expect(await p.ask({ message: 'Port', default: '3000' })).toBe('3000');
  expect(
    await p.ask({
      message: 'Password',
      secret: true,
      validate: (v) => (v.length >= 12 ? null : 'At least 12.'),
    }),
  ).toBe('a long enough secret');
  expect(await p.ask({ message: 'Language', default: 'en' })).toBe('bn');
  const text = out.join('');
  expect(text).toContain('Port [3000]: ');
  expect(text).toContain('Password: ');
  expect(text).toContain('At least 12.');
  expect(text).not.toContain('a long enough secret'); // secrets are never echoed
  p.close();
});

test('the end of the input is an error, not a hang', async () => {
  const { input, output } = streams();
  const p = terminalPrompter(input, output);
  (input as unknown as PassThrough).end('admin\n');
  expect(await p.ask({ message: 'Login' })).toBe('admin');
  await expect(p.ask({ message: 'Name' })).rejects.toBeInstanceOf(InputEndedError);
});

test('a terminal: redraws keep the question (never readline\'s "> "), secrets show as *', async () => {
  // A terminal as readline sees one: isTTY and raw mode.
  const stream = new PassThrough();
  const input = Object.assign(stream, {
    isTTY: true,
    setRawMode: () => stream,
  }) as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
  };
  output.columns = 80;
  output.isTTY = true;
  const out: string[] = [];
  (output as unknown as PassThrough).on('data', (c: Buffer) => out.push(c.toString()));
  const p = terminalPrompter(input, output);
  const type = (text: string) => (input as unknown as PassThrough).write(text);
  const host = p.ask({ message: '  Host', default: 'localhost' });
  type('db.examplx');
  type('\x7f'); // backspace: readline redraws the whole line
  type('e\r');
  expect(await host).toBe('db.example');
  const password = p.ask({ message: '  Password', secret: true });
  type('s3cret!');
  type('\x7f');
  type('\r');
  expect(await password).toBe('s3cret');
  const ESC = String.fromCharCode(27);
  const text = out.join('').replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g'), ''); // without cursor moves
  expect(text).toContain('  Host [localhost]: ');
  expect(text).toContain('  Password: ');
  expect(text).not.toContain('> ');
  expect(text).not.toContain('s3cret');
  expect(text).toContain('******'); // the redraw after backspace: one * per remaining character
  p.close();
});
