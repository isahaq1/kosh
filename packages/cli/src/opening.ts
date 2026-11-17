/**
 * `shutro-erp opening` (RFC 0036 §2.1): start a company from its own figures.
 *
 * - `opening template` writes the workbook to fill, with the company's accounts listed;
 * - `opening check <file>` does everything and rolls it back: every error on its row, and the proof;
 * - `opening load <file>` keeps it, when every check is equal.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  loadOpening,
  openingReportText,
  openingTemplate,
  readOpeningWorkbook,
  verifyOpening,
} from '@kosh/accounting';
import { problemOf } from '@kosh/server';
import { openProject } from './project.js';

const USAGE = `Usage: shutro-erp opening <template | check <file> | load <file> | verify [file]> [--company <id>]

  Start a company from its own figures, whatever it used before:

  template [--out <file>]  the workbook to fill (default opening-balances.xlsx), the company's accounts listed:
                           the trial balance at the cut-off, the unpaid customer and vendor documents, the stock
                           by location and lot with its cost, and the old system's control totals
  check <file>             everything is done and rolled back: every error on its row, then the proof — the
                           trial balance account by account, the control totals, the stock's quantities and value
  load <file>              the same, kept when every check is equal: one posted opening entry, a posted document
                           for what is left of each open one, one validated inventory adjustment per location
  verify [file]            verify the latest opening's certificate: its seal, that the record still says what was
                           sealed, its signature (KOSH_SIGNING_KEY) and, given the workbook, that it is the one loaded

  --company <id>           the company (default: the first)
`;

const errorText = (error: unknown): string => {
  const p = problemOf(error);
  if (p.status >= 500) return error instanceof Error ? error.message : String(error);
  return p.hint === undefined ? p.detail : `${p.detail} ${p.hint}`;
};

export async function runOpening(
  argv: readonly string[],
  write: (text: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string' },
      company: { type: 'string' },
      modules: { type: 'string', default: 'src/modules.ts' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, file] = positionals;
  if (
    values.help === true ||
    (command !== 'template' && command !== 'check' && command !== 'load' && command !== 'verify') ||
    ((command === 'check' || command === 'load') && file === undefined)
  ) {
    write(USAGE);
    return values.help === true ? 0 : 2;
  }
  const server = await openProject(cwd, values.modules ?? 'src/modules.ts');
  try {
    const company =
      values.company === undefined
        ? Number(
            (
              await server.driver.query<{ id: number }>({
                text: 'SELECT min(id) AS id FROM res_company',
                params: [],
              })
            )[0]?.id ?? 0,
          )
        : Number(values.company);
    if (!(company > 0)) throw new Error('No company: run shutro-erp init first.');
    if (command === 'template') {
      const out = resolve(cwd, values.out ?? 'opening-balances.xlsx');
      const bytes = await server.shutro.bootstrap({ reason: 'opening template', company }, (env) =>
        openingTemplate(env),
      );
      await writeFile(out, bytes);
      write(`Wrote ${out}: fill it, then run shutro-erp opening check <file>.\n`);
      return 0;
    }
    const key = process.env['KOSH_SIGNING_KEY'];
    const signing = key === undefined || key === '' ? {} : { signingKey: key };
    if (command === 'verify') {
      const workbook = file === undefined ? undefined : await readFile(resolve(cwd, file));
      const result = await server.shutro.bootstrap({ reason: 'opening verified', company }, (env) =>
        verifyOpening(env, { ...signing, ...(workbook === undefined ? {} : { workbook }) }),
      );
      if (result === null) {
        write('No opening was loaded.\n');
        return 1;
      }
      write(`Opening balances at ${result.cutoff} (${result.status}):\n`);
      for (const c of result.checks) write(`${c.ok ? '✔' : '✖'} ${c.name}: ${c.detail}\n`);
      return result.ok ? 0 : 1;
    }
    const data = readOpeningWorkbook(await readFile(resolve(cwd, file as string)));
    const report = await loadOpening(
      server.shutro,
      data,
      { company, commit: command === 'load', ...signing },
      errorText,
    );
    write(openingReportText(report));
    return report.ok || report.status === 'already' ? 0 : 1;
  } finally {
    await server.close();
  }
}
