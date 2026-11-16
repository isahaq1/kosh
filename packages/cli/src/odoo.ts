/**
 * `shutro-erp odoo import` (RFC 0034 §2.3): read a live Odoo through its JSON-RPC API and import its units, product
 * categories, taxes, chart of accounts, contacts and products, each with its Odoo id kept — a dry run unless
 * `--commit`, and a report that accounts for every record read, printed and saved as JSON.
 *
 * The password (or, better, an API key) of the Odoo user comes from `ODOO_PASSWORD` in the environment or `.env`,
 * never from the command line, where it would stay in the shell's history.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connectOdoo, importFromOdoo, reportText } from '@kosh/odoo';
import { openProject } from './project.js';

const USAGE = `Usage: shutro-erp odoo import --url <https://odoo.example.com> --db <database> --login <user> [--commit]

  Reads Odoo through its API as <user> (ODOO_PASSWORD: the password or an API key) and imports units, product
  categories, taxes, the chart of accounts, contacts and products, each keeping its Odoo id. Without --commit,
  a dry run: everything is done and rolled back, and the report says what would happen.

  --commit             keep the import
  --company <id>       the company the records belong to (default: the first)
  --report <file>      where the JSON report goes (default: odoo-import-<time>.json)
`;

export async function runOdoo(
  argv: readonly string[],
  write: (text: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      url: { type: 'string' },
      db: { type: 'string' },
      login: { type: 'string' },
      commit: { type: 'boolean', default: false },
      company: { type: 'string' },
      report: { type: 'string' },
      modules: { type: 'string', default: 'src/modules.ts' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true || positionals[0] !== 'import') {
    write(USAGE);
    return values.help === true ? 0 : 2;
  }
  if (values.url === undefined || values.db === undefined || values.login === undefined) {
    write(`--url, --db and --login are needed.\n\n${USAGE}`);
    return 2;
  }
  const envFile = resolve(cwd, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const password = process.env['ODOO_PASSWORD'];
  if (password === undefined || password === '') {
    write(
      'Set ODOO_PASSWORD (the password or an API key of the Odoo user) in the environment or .env.\n',
    );
    return 2;
  }

  write(`Signing in to Odoo at ${values.url} as ${values.login}…\n`);
  const odoo = await connectOdoo({ url: values.url, db: values.db, login: values.login, password });
  write(`Odoo ${odoo.version}. Reading…\n`);
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
    const report = await importFromOdoo(server.shutro, odoo, {
      dryRun: values.commit !== true,
      company,
      source: { url: values.url, db: values.db },
      onStep: (step, n) => write(`  ${step}: ${n} records\n`),
    });
    write(`\n${reportText(report)}`);
    const file = resolve(
      cwd,
      values.report ?? `odoo-import-${report.startedAt.replace(/[:.]/g, '-')}.json`,
    );
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    write(`\nThe full report: ${file}\n`);
    if (report.dryRun)
      write(
        report.ok
          ? 'Nothing was kept. Run again with --commit to import.\n'
          : 'Nothing was kept. Fix what failed (in Odoo or in Kosh) and run the dry run again.\n',
      );
    return report.ok ? 0 : 1;
  } finally {
    await server.close();
  }
}
