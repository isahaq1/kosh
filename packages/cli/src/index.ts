/**
 * @packageDocumentation
 * `@kosh/cli`: kosh new | dev | module:create | migrate | build (RFC 0001), and `kosh generate client` (RFC 0002
 * §6.4). Commands follow their RFC approvals.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { KoshModule } from '@kosh/modules-sdk';
import { generateClient, openApiOf } from '@kosh/server';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/cli',
  rfc: 'RFC 0001',
});

const USAGE = `Usage: kosh <command>

Commands:
  generate client   Typed API client from the module set or an OpenAPI document
      --modules <file|package>   a module (or file) exporting Kosh modules (\`modules\`, default, or each export)
      --from <file|url>          an OpenAPI document instead (a URL needs --token)
      --token <token>            Bearer token for --from <url>
      --out <file>               where to write (default: src/api/kosh.gen.ts)
      --check                    fail if the file is out of date (CI)

Coming with RFC 0001: new, dev, module:create, migrate, build
`;

/** Options of {@link runCli}. */
export interface CliOptions {
  /** Base for relative paths. Default: `process.cwd()`. */
  readonly cwd?: string;
  readonly fetch?: typeof fetch;
}

function isModule(value: unknown): value is KoshModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'shutro' in value &&
    'accessLevels' in value &&
    'name' in value
  );
}

/** The Kosh modules a file or package exports: `modules`, the default export, or every module export. */
export async function modulesOf(specifier: string, cwd: string): Promise<KoshModule[]> {
  const target =
    specifier.startsWith('.') || specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier)
      ? pathToFileURL(resolve(cwd, specifier)).href
      : specifier;
  const exported = (await import(target)) as Record<string, unknown>;
  for (const key of ['modules', 'default']) {
    const value = exported[key];
    if (Array.isArray(value) && value.every(isModule)) return value;
    if (isModule(value)) return [value];
  }
  const all = Object.values(exported).filter(isModule);
  if (all.length === 0)
    throw new Error(`${specifier} exports no Kosh modules (defineModule from @kosh/modules-sdk).`);
  return all;
}

async function documentFrom(
  from: string,
  token: string | undefined,
  cwd: string,
  doFetch: typeof fetch,
): Promise<Record<string, unknown>> {
  if (/^https?:\/\//.test(from)) {
    const response = await doFetch(from, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`GET ${from}: ${response.status} ${response.statusText}.`);
    return (await response.json()) as Record<string, unknown>;
  }
  return JSON.parse(await readFile(resolve(cwd, from), 'utf8')) as Record<string, unknown>;
}

async function generate(
  argv: readonly string[],
  write: (text: string) => void,
  options: CliOptions,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      modules: { type: 'string' },
      from: { type: 'string' },
      token: { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean' },
    },
    strict: true,
  });
  const cwd = options.cwd ?? process.cwd();
  if ((values.modules === undefined) === (values.from === undefined)) {
    write('kosh generate client: pass exactly one of --modules or --from.\n');
    return 2;
  }
  const document =
    values.modules === undefined
      ? await documentFrom(
          values.from as string,
          values.token,
          cwd,
          options.fetch ?? globalThis.fetch,
        )
      : openApiOf(await modulesOf(values.modules, cwd));
  const code = generateClient(document);
  const out = resolve(cwd, values.out ?? 'src/api/kosh.gen.ts');
  if (values.check === true) {
    const current = await readFile(out, 'utf8').catch(() => '');
    if (current.replaceAll('\r\n', '\n') === code) {
      write(`${out} is up to date.\n`);
      return 0;
    }
    write(`${out} is out of date: run kosh generate client.\n`);
    return 1;
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, code);
  write(`Wrote ${out}.\n`);
  return 0;
}

/** Runs the CLI; returns the exit code. */
export async function runCli(
  argv: readonly string[],
  write: (text: string) => void,
  options: CliOptions = {},
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help') {
    write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === 'generate' && argv[1] === 'client') {
    try {
      return await generate(argv.slice(2), write, options);
    } catch (error) {
      write(`kosh generate client: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  write(`Unknown command '${argv.join(' ')}'. Run kosh --help.\n`);
  return 2;
}
