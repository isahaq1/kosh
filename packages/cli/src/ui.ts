/**
 * The installer's look in the terminal, without dependencies: a logo, numbered steps, spinners for long work,
 * status lines (✔ ▲ ✖) and a summary card. On a Unicode terminal everything hangs on one rail down the left (│),
 * the questions of the interactive prompter included (`tui.ts`). Colour, Unicode and animation are detected from
 * the terminal (NO_COLOR, FORCE_COLOR, KOSH_ASCII=1, TERM=dumb, Windows consoles without Unicode); output that is not
 * a terminal (tests, logs, CI) gets plain lines with the same words and no escape codes.
 */

/** What the terminal can show. */
export interface Terminal {
  readonly color: boolean;
  /** Box drawing, ✔ and braille spinners. */
  readonly unicode: boolean;
  /** Pictographs in step titles (🗄 🏢 👤 …). */
  readonly emoji: boolean;
  /** Spinners and redrawn lines (a TTY). */
  readonly animate: boolean;
  readonly columns: number;
}

/** Plain output: logs, tests, pipes. */
export const PLAIN_TERMINAL: Terminal = Object.freeze({
  color: false,
  unicode: true,
  emoji: false,
  animate: false,
  columns: 80,
});

type Env = Readonly<Record<string, string | undefined>>;

/** Detects what `stream` (process.stdout) can show. */
export function detectTerminal(
  stream: { readonly isTTY?: boolean; readonly columns?: number },
  env: Env = process.env,
  platform: string = process.platform,
): Terminal {
  const tty = stream.isTTY === true && env['TERM'] !== 'dumb' && env['CI'] === undefined;
  const forced = env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0';
  const color = env['NO_COLOR'] === undefined && (forced || tty);
  const modernWindows =
    env['WT_SESSION'] !== undefined ||
    env['TERM_PROGRAM'] === 'vscode' ||
    env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm' ||
    env['ConEmuTask'] === '{cmd::Cmder}' ||
    env['TERM'] === 'xterm-256color' ||
    env['TERM'] === 'alacritty';
  const unicode =
    env['KOSH_ASCII'] !== '1' && (platform === 'win32' ? modernWindows : env['TERM'] !== 'linux');
  return {
    color,
    unicode,
    emoji: unicode && tty,
    animate: tty,
    columns: Math.max(40, Math.min(stream.columns ?? 80, 120)),
  };
}

export const ESC = '\u001b[';
type Paint = (enabled: boolean) => (text: string) => string;
const paint =
  (open: string, close: string): Paint =>
  (enabled) =>
  (text) =>
    enabled ? `${ESC}${open}m${text}${ESC}${close}m` : text;

/** The colours and weights the installer uses. */
export type Style =
  | 'bold'
  | 'dim'
  | 'inverse'
  | 'underline'
  | 'green'
  | 'yellow'
  | 'red'
  | 'cyan'
  | 'magenta'
  | 'gray';
const styles: Readonly<Record<Style, Paint>> = {
  bold: paint('1', '22'),
  dim: paint('2', '22'),
  inverse: paint('7', '27'),
  underline: paint('4', '24'),
  green: paint('32', '39'),
  yellow: paint('33', '39'),
  red: paint('31', '39'),
  cyan: paint('36', '39'),
  magenta: paint('35', '39'),
  gray: paint('90', '39'),
};

/** Styles text for `terminal` (no escape codes without colour). */
export function stylerFor(terminal: Terminal): (name: Style, text: string) => string {
  return (name, text) => styles[name](terminal.color)(text);
}

/** The rail and its marks (Unicode terminals that animate), shared with the interactive prompter. */
export const RAIL = {
  bar: '│',
  start: '┌',
  end: '└',
  active: '◆',
  done: '◇',
  error: '▲',
  cancel: '■',
} as const;

/** Whether `terminal` gets the rail look (a TTY that shows Unicode). */
export const railed = (terminal: Terminal): boolean => terminal.unicode && terminal.animate;

/** Columns a string takes: escape codes take none, pictographs two. */
export function width(text: string): number {
  let n = 0;
  for (const ch of text
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.replace(/^[0-9;]*m/, '')))
    .join('')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0xfe0f || code === 0x200d) continue; // emoji presentation, joiners
    n += code >= 0x1f300 || (code >= 0x2600 && code <= 0x27bf && code !== 0x2714) ? 2 : 1;
  }
  return n;
}

/** The step icons: a pictograph where the terminal shows them, a symbol otherwise. */
export const ICONS = {
  database: ['🗄️', '◆'],
  company: ['🏢', '◆'],
  admin: ['👤', '◆'],
  apps: ['🧩', '◆'],
  storage: ['📁', '◆'],
  server: ['🌐', '◆'],
  files: ['📝', '◆'],
  install: ['⚙️', '◆'],
  security: ['🔐', '◆'],
  package: ['📦', '◆'],
  rocket: ['🚀', '◆'],
} as const;
export type IconName = keyof typeof ICONS;

const LOGO = [
  '██╗  ██╗ ██████╗ ███████╗██╗  ██╗',
  '██║ ██╔╝██╔═══██╗██╔════╝██║  ██║',
  '█████╔╝ ██║   ██║███████╗███████║',
  '██╔═██╗ ██║   ██║╚════██║██╔══██║',
  '██║  ██╗╚██████╔╝███████║██║  ██║',
  '╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝',
];
/** Cyan to violet, one 256-colour step per logo line. */
const GRADIENT = [51, 45, 39, 33, 63, 99];

const SPINNER_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_ASCII = ['|', '/', '-', '\\'];

/** A running spinner's controls. */
export interface TaskHandle {
  /** Replaces the text after the spinner (e.g. "3 of 7"). */
  update(text: string): void;
  /** The ✔ line printed when the work succeeds (default: the task's label). */
  finish(text: string): void;
}

/** One summary-card row: a label and its value. */
export type CardRow = readonly [label: string, value: string];

export interface Ui {
  readonly terminal: Terminal;
  /** Raw output (lines written while a spinner runs keep the spinner below them). */
  write(text: string): void;
  style(name: Style, text: string): string;
  icon(name: IconName): string;
  banner(subtitle: string): Promise<void>;
  /** Opens the rail (┌ title) under the banner, with a hint line. */
  intro(title: string, hint: string): void;
  /** Closes the rail (└ text). */
  outro(text: string): void;
  /** A numbered step title: "🗄️  Step 1/6 · Database". */
  step(icon: IconName, title: string, hint?: string): void;
  ok(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  fail(text: string): void;
  /** A dimmed detail line under the current step. */
  detail(text: string): void;
  /** Runs `work` under a spinner, then prints ✔ (with the time taken) or ✖. */
  task<T>(label: string, work: (handle: TaskHandle) => Promise<T>): Promise<T>;
  /** A progress bar line: "████████░░░░ 4/6 label". */
  progress(done: number, total: number, label: string): string;
  /** A framed card (title, then aligned rows). */
  card(title: string, rows: readonly CardRow[], tone?: 'green' | 'cyan' | 'yellow'): void;
  /** Stops the spinner while a question is asked (the prompter writes to the terminal itself). */
  pause(): void;
  resume(): void;
}

export interface UiOptions {
  /** Steps in the whole run, for "Step n/N". */
  readonly steps?: number;
  /** Milliseconds per spinner frame. */
  readonly frameMs?: number;
}

/** A {@link Ui} writing through `out`. */
export function createUi(
  out: (text: string) => void,
  terminal: Terminal = PLAIN_TERMINAL,
  options: UiOptions = {},
): Ui {
  const s = stylerFor(terminal);
  const rail = railed(terminal);
  const bar = s('gray', RAIL.bar);
  const sym = terminal.unicode
    ? { ok: '✔', info: 'ℹ', warn: '▲', fail: '✖', dot: '•', bar: '█', rest: '░' }
    : { ok: '[ok]', info: '[i]', warn: '[!]', fail: '[x]', dot: '-', bar: '#', rest: '.' };
  const frames = terminal.unicode ? SPINNER_UNICODE : SPINNER_ASCII;
  let stepNo = 0;

  // The live spinner: its line is cleared before other output and drawn again after it.
  let spin: { label: string; extra: string; frame: number; timer?: NodeJS.Timeout } | null = null;
  let paused = false;
  const clear = () => {
    if (spin !== null && !paused && terminal.animate) out(`\r${ESC}2K`);
  };
  const draw = () => {
    if (spin === null || paused || !terminal.animate) return;
    const f = s('cyan', frames[spin.frame % frames.length] ?? '');
    const extra = spin.extra === '' ? '' : s('gray', `  ${spin.extra}`);
    out(rail ? `\r${ESC}2K${f}  ${spin.label}${extra}` : `\r${ESC}2K  ${f} ${spin.label}${extra}`);
  };
  const write = (text: string) => {
    clear();
    out(text);
    draw();
  };
  const line = (mark: string, text: string) =>
    write(rail ? `${bar}  ${mark} ${text}\n` : `  ${mark} ${text}\n`);

  const icon = (name: IconName) => (terminal.emoji ? ICONS[name][0] : s('cyan', ICONS[name][1]));

  return {
    terminal,
    write,
    style: s,
    icon,
    async banner(subtitle) {
      if (!terminal.unicode) {
        write(`\n  ${s('bold', 'K O S H')}  ${subtitle}\n`);
        return;
      }
      write('\n');
      for (const [i, row] of LOGO.entries()) {
        const colored = terminal.color ? `${ESC}38;5;${GRADIENT[i]}m${row}${ESC}39m` : row;
        write(`  ${colored}\n`);
        if (terminal.animate) await new Promise((r) => setTimeout(r, 35));
      }
      write(`  ${s('bold', subtitle)}\n`);
    },
    intro(title, hint) {
      if (!rail) {
        write(`  ${s('gray', hint)}\n`);
        return;
      }
      write(
        `\n${s('gray', RAIL.start)}  ${s('inverse', ` ${title} `)}\n${bar}  ${s('gray', hint)}\n`,
      );
    },
    outro(text) {
      write(rail ? `${bar}\n${s('gray', RAIL.end)}  ${text}\n` : `\n  ${text}\n`);
    },
    step(name, title, hint) {
      stepNo += 1;
      if (rail) {
        const n = options.steps === undefined ? '' : s('gray', `  ${stepNo}/${options.steps}`);
        write(`${bar}\n${s('cyan', RAIL.active)}  ${s('bold', title)}${n}\n`);
        if (hint !== undefined) write(`${bar}  ${s('gray', hint)}\n`);
        return;
      }
      const n = options.steps === undefined ? '' : s('gray', `Step ${stepNo}/${options.steps} · `);
      const rule = terminal.unicode ? '─' : '-';
      const head = `${icon(name)}  ${n}${s('bold', title)}`;
      const fill = Math.max(3, Math.min(terminal.columns, 72) - width(head) - 4);
      write(`\n${head} ${s('gray', rule.repeat(fill))}\n`);
      if (hint !== undefined) write(`  ${s('gray', hint)}\n`);
    },
    ok: (text) => line(s('green', sym.ok), text),
    info: (text) => line(s('cyan', sym.info), text),
    warn: (text) => line(s('yellow', sym.warn), text),
    fail: (text) => line(s('red', sym.fail), text),
    detail: (text) =>
      write(
        rail
          ? `${bar}    ${s('gray', `${sym.dot} ${text}`)}\n`
          : `    ${s('gray', `${sym.dot} ${text}`)}\n`,
      ),
    async task(label, work) {
      const started = Date.now();
      const previous = spin;
      clear();
      spin = { label, extra: '', frame: 0 };
      if (terminal.animate) {
        const current = spin;
        current.timer = setInterval(() => {
          current.frame += 1;
          if (spin === current) draw();
        }, options.frameMs ?? 80);
        current.timer.unref();
      }
      draw();
      const stop = () => {
        clear();
        if (spin?.timer !== undefined) clearInterval(spin.timer);
        spin = previous;
      };
      const seconds = () => {
        const ms = Date.now() - started;
        return ms < 1000 ? '' : s('gray', ` (${(ms / 1000).toFixed(1)}s)`);
      };
      let final = label;
      try {
        const result = await work({
          update(text) {
            if (spin === null) return;
            spin.extra = text;
            draw();
          },
          finish(text) {
            final = text;
          },
        });
        stop();
        line(s('green', sym.ok), `${final}${seconds()}`);
        draw();
        return result;
      } catch (error) {
        stop();
        line(s('red', sym.fail), label);
        draw();
        throw error;
      }
    },
    progress(done, total, label) {
      const size = 20;
      const filled = total === 0 ? size : Math.round((done / total) * size);
      const bar = s('cyan', sym.bar.repeat(filled)) + s('gray', sym.rest.repeat(size - filled));
      return `${bar} ${done}/${total} ${label}`;
    },
    card(title, rows, tone = 'green') {
      const labelWidth = Math.max(0, ...rows.map(([l]) => width(l)));
      const body = rows.map(([l, v]) => `${s('gray', l.padEnd(labelWidth))}  ${v}`);
      const inner = Math.max(width(title), ...body.map(width)) + 2;
      const [tl, tr, bl, br, h, v] = terminal.unicode
        ? ['╭', '╮', '╰', '╯', '─', '│']
        : ['+', '+', '+', '+', '-', '|'];
      const edge = (text: string) => s(tone, text);
      const row = (text: string) =>
        `  ${edge(v)} ${text}${' '.repeat(Math.max(0, inner - width(text) - 1))}${edge(v)}\n`;
      write(`\n  ${edge(`${tl}${h.repeat(inner)}${tr}`)}\n`);
      write(row(s('bold', title)));
      write(row(''));
      for (const b of body) write(row(b));
      write(`  ${edge(`${bl}${h.repeat(inner)}${br}`)}\n`);
    },
    pause() {
      clear();
      paused = true;
    },
    resume() {
      paused = false;
      draw();
    },
  };
}
