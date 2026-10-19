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

/** The terminal: one readline interface, secret answers masked. */
export function terminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter {
  let muted = false;
  const rl: Interface & { _writeToOutput?: (text: string) => void } = createInterface({
    input,
    output,
    terminal: input.isTTY === true,
  });
  const write = rl._writeToOutput?.bind(rl);
  // Masks what is typed while a secret is asked (readline echoes through this hook).
  rl._writeToOutput = (text: string) => {
    if (!muted || text.includes('\n') || text.includes('\r')) write?.(muted ? '\n' : text);
    else write?.('*'.repeat(text.length === 0 ? 0 : 1));
  };
  const line = (prompt: string) =>
    new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  const ask = async (q: Question): Promise<string> => {
    for (;;) {
      const prompt = `${q.message}${q.default === undefined || q.secret === true ? '' : ` [${q.default}]`}: `;
      muted = q.secret === true;
      const answer = (await line(prompt)).trim();
      muted = false;
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
