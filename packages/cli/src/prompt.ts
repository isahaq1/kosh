/**
 * Terminal questions for `kosh init`, on `node:readline` (no dependency). Answers can be scripted for tests and
 * non-interactive installs (`--yes` with flags): every question goes through {@link Prompter}.
 */
import { createInterface, type Interface } from 'node:readline';

export interface Question {
  readonly message: string;
  /** Shown in brackets and used for an empty answer. */
  readonly default?: string;
  /** Not echoed (passwords, secret keys). */
  readonly secret?: boolean;
  /** An error message for an invalid answer (asked again), or `null`. */
  readonly validate?: (value: string) => string | null;
}

/** One option of a choice: what is answered, what is shown, an optional hint beside it. */
export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface SelectQuestion {
  readonly message: string;
  readonly choices: readonly Choice[];
  /** The value chosen when Enter is pressed at once. */
  readonly default?: string;
}

export interface MultiQuestion {
  readonly message: string;
  readonly choices: readonly Choice[];
  /** The values ticked to begin with. */
  readonly defaults?: readonly string[];
  /** At least one. */
  readonly required?: boolean;
}

export interface Prompter {
  ask(question: Question): Promise<string>;
  confirm(message: string, fallback: boolean): Promise<boolean>;
  /** One of several (a list chosen with the keyboard); without it, {@link choose} asks a question instead. */
  select?(question: SelectQuestion): Promise<string>;
  /** Several of several; without it, {@link chooseMany} asks for a comma-separated list. */
  multiselect?(question: MultiQuestion): Promise<string[]>;
  close(): void;
}

/**
 * One of `choices`: the prompter's list when it has one, otherwise the question `fallback` (pipes, scripts, tests),
 * answered with an option's number, value or label.
 */
export async function choose(
  prompter: Prompter,
  q: SelectQuestion & { readonly fallback: string },
): Promise<string> {
  if (prompter.select !== undefined) return prompter.select(q);
  const find = (answer: string) => {
    const a = answer.trim().toLowerCase();
    if (/^\d+$/.test(a)) return q.choices[Number(a) - 1];
    return q.choices.find((c) => c.value.toLowerCase() === a || c.label.toLowerCase() === a);
  };
  const answer = await prompter.ask({
    message: q.fallback,
    ...(q.default === undefined ? {} : { default: q.default }),
    validate: (v) =>
      find(v) === undefined ? `One of ${q.choices.map((c) => c.value).join(', ')}` : null,
  });
  return (find(answer) as Choice).value;
}

/** Several of `choices`: the prompter's list, or a comma-separated answer to `fallback`. */
export async function chooseMany(
  prompter: Prompter,
  q: MultiQuestion & { readonly fallback: string },
): Promise<string[]> {
  if (prompter.multiselect !== undefined) return prompter.multiselect(q);
  const known = new Set(q.choices.map((c) => c.value));
  const answer = await prompter.ask({
    message: q.fallback,
    default: (q.defaults ?? []).join(','),
    validate: (v) => {
      const items = v
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== '');
      const unknown = items.filter((x) => !known.has(x));
      if (unknown.length > 0) return `Unknown: ${unknown.join(', ')}`;
      return q.required === true && items.length === 0 ? 'Choose at least one.' : null;
    },
  });
  return [
    ...new Set(
      answer
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== ''),
    ),
  ];
}

/** Thrown when the input ends before every question is answered (piped answers ran out, Ctrl+D). */
export class InputEndedError extends Error {
  constructor(question: string) {
    super(`The input ended before "${question}" was answered.`);
    this.name = 'InputEndedError';
  }
}

/** How questions look: a marker before each one and a style for the default in brackets. */
export interface PromptLook {
  /** E.g. a cyan "? ", after the question's own indentation. */
  readonly marker: string;
  readonly fallback: (text: string) => string;
  /** The style of a validation message. */
  readonly problem: (text: string) => string;
}

const PLAIN_LOOK: PromptLook = { marker: '', fallback: (t) => t, problem: (t) => t };

/**
 * The terminal: secret answers masked with `*`. Lines are queued as they arrive, so answers piped in (or typed
 * ahead) are never lost between questions.
 */
export function terminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
  look: PromptLook = PLAIN_LOOK,
): Prompter {
  let muted = false;
  const terminal = input.isTTY === true;
  const rl: Interface & { _writeToOutput?: (text: string) => void } = createInterface({
    input,
    output,
    terminal,
  });
  const echo = rl._writeToOutput?.bind(rl);
  let current = '';
  // Readline echoes what is typed through this hook, and redraws the whole line (prompt + text) on edits such as
  // backspace: while a secret is asked, the text shows as one * per character, the question stays readable.
  rl._writeToOutput = (text: string) => {
    if (!muted) echo?.(text);
    else if (current !== '' && text.startsWith(current))
      echo?.(current + '*'.repeat((rl as unknown as { line: string }).line.length));
    else if (text.includes('\n') || text.includes('\r')) echo?.('\n');
    else if (text.length > 0) echo?.('*');
  };
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next === undefined) lines.push(line);
    else next(line);
  });
  rl.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next(null);
  });
  const nextLine = (): Promise<string | null> => {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };
  const ask = async (q: Question): Promise<string> => {
    for (;;) {
      const indent = /^\s*/.exec(q.message)?.[0] ?? '';
      const fallback =
        q.default === undefined || q.secret === true ? '' : ` ${look.fallback(`[${q.default}]`)}`;
      const prompt = `${indent}${look.marker}${q.message.slice(indent.length)}${fallback}: `;
      // Readline's own prompt, so redraws show this question (not its default "> "); written before masking.
      current = prompt;
      if (terminal) {
        rl.setPrompt(prompt);
        rl.prompt();
      } else output.write(prompt);
      muted = q.secret === true && terminal;
      const received = await nextLine();
      muted = false;
      if (received === null) throw new InputEndedError(q.message);
      if (!terminal) output.write(q.secret === true ? '\n' : `${received}\n`);
      const answer = received.trim();
      const value = answer === '' ? (q.default ?? '') : answer;
      const problem = q.validate?.(value) ?? null;
      if (problem === null) return value;
      output.write(`  ${look.problem(problem)}\n`);
    }
  };
  return {
    ask,
    async confirm(message, fallback) {
      const answer = (await ask({ message: `${message} (${fallback ? 'Y/n' : 'y/N'})` }))
        .trim()
        .toLowerCase();
      return answer === '' ? fallback : answer.startsWith('y');
    },
    close: () => rl.close(),
  };
}

/** Defaults only (`--yes`): a question without a default and without a flag is an error. */
export function defaultsPrompter(): Prompter {
  return {
    async ask(q) {
      if (q.default === undefined)
        throw new Error(`"${q.message}" has no default: pass it as a flag (kosh init --help).`);
      const problem = q.validate?.(q.default) ?? null;
      if (problem !== null) throw new Error(`${q.message}: ${problem}`);
      return q.default;
    },
    async confirm(_message, fallback) {
      return fallback;
    },
    close() {},
  };
}
