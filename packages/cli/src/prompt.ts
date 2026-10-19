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

export interface Prompter {
  ask(question: Question): Promise<string>;
  confirm(message: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

/** Thrown when the input ends before every question is answered (piped answers ran out, Ctrl+D). */
export class InputEndedError extends Error {
  constructor(question: string) {
    super(`The input ended before "${question}" was answered.`);
    this.name = 'InputEndedError';
  }
}

/**
 * The terminal: secret answers masked with `*`. Lines are queued as they arrive, so answers piped in (or typed
 * ahead) are never lost between questions.
 */
export function terminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter {
  let muted = false;
  const terminal = input.isTTY === true;
  const rl: Interface & { _writeToOutput?: (text: string) => void } = createInterface({
    input,
    output,
    terminal,
  });
  const echo = rl._writeToOutput?.bind(rl);
  // Readline echoes what is typed through this hook: while a secret is asked, each keystroke shows as *.
  rl._writeToOutput = (text: string) => {
    if (!muted) echo?.(text);
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
      const prompt = `${q.message}${q.default === undefined || q.secret === true ? '' : ` [${q.default}]`}: `;
      output.write(prompt); // before masking: the question itself is always readable
      muted = q.secret === true && terminal;
      const received = await nextLine();
      muted = false;
      if (received === null) throw new InputEndedError(q.message);
      if (!terminal) output.write(q.secret === true ? '\n' : `${received}\n`);
      const answer = received.trim();
      const value = answer === '' ? (q.default ?? '') : answer;
      const problem = q.validate?.(value) ?? null;
      if (problem === null) return value;
      output.write(`  ${problem}\n`);
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
