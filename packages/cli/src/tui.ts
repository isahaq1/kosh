/**
 * The installer's questions on a terminal (no dependency): one question at a time on the rail of `ui.ts`, answered
 * with the keyboard — text with the default shown until typed over, secrets masked, choices with ↑ ↓ and Enter,
 * several choices with Space, Yes / No with ← →. An answered question collapses to one dimmed line; a refused
 * answer shows why under the input. Ctrl+C stops the installer. Not a terminal (pipes, tests): `prompt.ts` asks
 * line by line instead.
 */
import { emitKeypressEvents } from 'node:readline';
import type { Choice, MultiQuestion, Prompter, Question, SelectQuestion } from './prompt.js';
import { ESC, RAIL, stylerFor, type Terminal, width } from './ui.js';

/** Thrown when the user stops the installer (Ctrl+C) during a question. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledError';
  }
}

interface Key {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly sequence?: string;
}

type Status = 'active' | 'error' | 'done' | 'cancel';

/** One question's behaviour: its frame for a status, what a key does, its answer. */
interface Widget<T> {
  frame(status: Status, error: string | null): string;
  /** `submit` when Enter is accepted (the answer is validated first), otherwise the state changed or nothing. */
  key(text: string | undefined, key: Key): 'submit' | undefined;
  value(): T;
  validate?(value: T): string | null;
}

export function interactivePrompter(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  terminal: Terminal,
): Prompter {
  const s = stylerFor(terminal);
  const columns = () => Math.max(40, output.columns ?? terminal.columns);
  /** Terminal rows `text` takes (long lines wrap). */
  const rows = (text: string) =>
    text
      .split('\n')
      .slice(0, -1)
      .reduce((n, line) => n + Math.max(1, Math.ceil(width(line) / columns())), 0);

  const bar = (status: Status) =>
    status === 'error'
      ? s('yellow', RAIL.bar)
      : status === 'active'
        ? s('cyan', RAIL.bar)
        : s('gray', RAIL.bar);
  const head = (status: Status, message: string) => {
    const mark =
      status === 'active'
        ? s('cyan', RAIL.active)
        : status === 'error'
          ? s('yellow', RAIL.error)
          : status === 'cancel'
            ? s('red', RAIL.cancel)
            : s('green', RAIL.done);
    return `${s('gray', RAIL.bar)}\n${mark}  ${status === 'done' ? message : s('bold', message)}\n`;
  };
  const foot = (status: Status, error: string | null) =>
    status === 'error'
      ? `${s('yellow', RAIL.end)}  ${s('yellow', error ?? '')}\n`
      : status === 'active'
        ? `${s('cyan', RAIL.end)}\n`
        : '';
  const cursor = s('inverse', ' ');

  function run<T>(widget: Widget<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let drawn = 0;
      let error: string | null = null;
      const draw = (status: Status) => {
        const text = widget.frame(status, error);
        if (drawn > 0) output.write(`${ESC}${drawn}A\r`);
        output.write(`${ESC}J${text}`);
        drawn = rows(text);
      };
      const finish = () => {
        input.off('keypress', onKey);
        if (input.isTTY) input.setRawMode(false);
        input.pause();
        output.write(`${ESC}?25h`);
      };
      const onKey = (text: string | undefined, key: Key = {}) => {
        if (key.ctrl === true && (key.name === 'c' || key.name === 'd')) {
          draw('cancel');
          finish();
          reject(new CancelledError());
          return;
        }
        const action = widget.key(text, key);
        if (action === 'submit') {
          const value = widget.value();
          const problem = widget.validate?.(value) ?? null;
          if (problem === null) {
            error = null;
            draw('done');
            finish();
            resolve(value);
            return;
          }
          error = problem;
          draw('error');
          return;
        }
        draw(error === null ? 'active' : 'error');
      };
      emitKeypressEvents(input);
      if (input.isTTY) input.setRawMode(true);
      input.resume();
      output.write(`${ESC}?25l`);
      input.on('keypress', onKey);
      draw('active');
    });
  }

  /** The question without the indentation of sub-questions (the rail aligns them). */
  const label = (message: string) => message.trim();

  function text(q: Question): Promise<string> {
    let value = '';
    return run<string>({
      frame(status, error) {
        const shown = q.secret === true ? '•'.repeat(value.length) : value;
        if (status === 'done' || status === 'cancel') {
          const answer =
            q.secret === true
              ? s('gray', '•'.repeat(Math.min(12, (value || q.default || '').length)))
              : s('gray', value === '' ? (q.default ?? '') : value);
          return `${head(status, label(q.message))}${bar(status)}  ${status === 'cancel' ? s('gray', 'cancelled') : answer}\n`;
        }
        const placeholder =
          value === '' && q.default !== undefined && q.default !== '' && q.secret !== true
            ? s('gray', q.default)
            : '';
        return `${head(status, label(q.message))}${bar(status)}  ${shown}${cursor}${placeholder}\n${foot(status, error)}`;
      },
      key(input, key) {
        if (key.name === 'return' || key.name === 'enter') return 'submit';
        if (key.name === 'backspace') value = value.slice(0, -1);
        else if (key.ctrl === true && key.name === 'u') value = '';
        else if (key.name === 'tab' && value === '' && q.default !== undefined) value = q.default;
        else if (
          input !== undefined &&
          key.ctrl !== true &&
          key.meta !== true &&
          [...input].every((ch) => ch >= ' ' && ch !== '\x7f')
        )
          value += input;
        return undefined;
      },
      value: () => (value.trim() === '' ? (q.default ?? '') : value.trim()),
      validate: (v) => q.validate?.(v) ?? null,
    });
  }

  const labelWidth = (choices: readonly Choice[]) =>
    Math.max(...choices.map((c) => width(c.label)));
  /** An option: its mark, its label (bright when focused, with a ❯ pointer), its hint aligned after it. */
  const optionLine = (c: Choice, mark: string, focused: boolean, pad: number) => {
    const name = focused ? s('bold', c.label) : c.label;
    const gap = ' '.repeat(Math.max(0, pad - width(c.label)) + 2);
    const hint = c.hint === undefined ? '' : `${gap}${s('gray', c.hint)}`;
    return `${focused ? s('cyan', '❯') : ' '} ${mark} ${name}${hint}`;
  };

  function select(q: SelectQuestion): Promise<string> {
    let at = Math.max(
      0,
      q.choices.findIndex((c) => c.value === q.default),
    );
    return run<string>({
      frame(status) {
        const chosen = q.choices[at];
        if (status === 'done' || status === 'cancel')
          return `${head(status, q.message)}${bar(status)}  ${s('gray', status === 'cancel' ? 'cancelled' : (chosen?.label ?? ''))}\n`;
        const list = q.choices
          .map(
            (c, i) =>
              `${bar(status)} ${optionLine(c, i === at ? s('cyan', '●') : s('gray', '○'), i === at, labelWidth(q.choices))}`,
          )
          .join('\n');
        return `${head(status, q.message)}${list}\n${foot(status, null)}`;
      },
      key(_text, key) {
        if (key.name === 'return' || key.name === 'enter') return 'submit';
        if (key.name === 'up' || key.name === 'k')
          at = (at - 1 + q.choices.length) % q.choices.length;
        if (key.name === 'down' || key.name === 'j' || key.name === 'tab')
          at = (at + 1) % q.choices.length;
        return undefined;
      },
      value: () => q.choices[at]?.value ?? '',
    });
  }

  function multiselect(q: MultiQuestion): Promise<string[]> {
    let at = 0;
    const picked = new Set(q.defaults ?? []);
    const values = () => q.choices.filter((c) => picked.has(c.value)).map((c) => c.value);
    return run<string[]>({
      frame(status, error) {
        if (status === 'done' || status === 'cancel') {
          const names = q.choices.filter((c) => picked.has(c.value)).map((c) => c.label);
          return `${head(status, q.message)}${bar(status)}  ${s('gray', status === 'cancel' ? 'cancelled' : names.length === 0 ? 'none' : names.join(', '))}\n`;
        }
        const list = q.choices
          .map((c, i) => {
            const mark = picked.has(c.value) ? s('green', '◼') : s('gray', '◻');
            return `${bar(status)} ${optionLine(c, mark, i === at, labelWidth(q.choices))}`;
          })
          .join('\n');
        const help = s('gray', '↑↓ move · Space toggle · a all · Enter confirm');
        return `${head(status, q.message)}${list}\n${bar(status)}  ${help}\n${foot(status, error)}`;
      },
      key(text, key) {
        if (key.name === 'return' || key.name === 'enter') return 'submit';
        if (key.name === 'up' || key.name === 'k')
          at = (at - 1 + q.choices.length) % q.choices.length;
        else if (key.name === 'down' || key.name === 'j' || key.name === 'tab')
          at = (at + 1) % q.choices.length;
        else if (key.name === 'space' || text === ' ') {
          const c = q.choices[at];
          if (c !== undefined) {
            if (picked.has(c.value)) picked.delete(c.value);
            else picked.add(c.value);
          }
        } else if (key.name === 'a') {
          if (picked.size === q.choices.length) picked.clear();
          else for (const c of q.choices) picked.add(c.value);
        }
        return undefined;
      },
      value: values,
      validate: (v) => (q.required === true && v.length === 0 ? 'Choose at least one.' : null),
    });
  }

  function confirm(message: string, fallback: boolean): Promise<boolean> {
    let yes = fallback;
    return run<boolean>({
      frame(status) {
        if (status === 'done' || status === 'cancel')
          return `${head(status, label(message))}${bar(status)}  ${s('gray', status === 'cancel' ? 'cancelled' : yes ? 'Yes' : 'No')}\n`;
        const option = (on: boolean, name: string) =>
          on ? `${s('cyan', '●')} ${name}` : `${s('gray', '○')} ${s('gray', name)}`;
        return `${head(status, label(message))}${bar(status)}  ${option(yes, 'Yes')} ${s('gray', '/')} ${option(!yes, 'No')}\n${foot(status, null)}`;
      },
      key(text, key) {
        if (key.name === 'return' || key.name === 'enter') return 'submit';
        if (
          key.name === 'left' ||
          key.name === 'right' ||
          key.name === 'tab' ||
          key.name === 'h' ||
          key.name === 'l'
        )
          yes = !yes;
        else if (text?.toLowerCase() === 'y') yes = true;
        else if (text?.toLowerCase() === 'n') yes = false;
        return undefined;
      },
      value: () => yes,
    });
  }

  return {
    ask: text,
    confirm,
    select,
    multiselect,
    close() {
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write(`${ESC}?25h`);
    },
  };
}
