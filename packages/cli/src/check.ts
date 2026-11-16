/**
 * `shutro-erp check` (RFC 0034 step 1): the module standard of RFC 0023 — the rules the shipped apps pass — run on
 * a company's own modules (`src/modules/<name>/index.ts`, made by `shutro-erp module create` or Studio). The
 * installed set (`src/modules.ts`) is read only to resolve what they depend on. Bangla labels (T1) and an overview
 * with demo data (A1) are reported but do not fail the check unless `--strict`: a company's own module need not be in
 * Bangla, nor ship demo data.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { modulesOf } from './project.js';
import { checkStandard, isManifest, RULES, standardReport, withDependencies } from './standard.js';

const RELAXED = new Set(['T1', 'A1']);

export async function runCheck(
  argv: readonly string[],
  write: (text: string) => void,
  cwd: string,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      modules: { type: 'string', default: 'src/modules.ts' },
      all: { type: 'boolean' },
      strict: { type: 'boolean' },
    },
    strict: true,
  });
  // The company's own modules.
  const dir = join(cwd, 'src', 'modules');
  const own: Record<string, unknown>[] = [];
  const unreadable: string[] = [];
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const entry = join(dir, name, 'index.ts');
    if (!existsSync(entry)) continue;
    const exported = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    const manifests = Object.values(exported).filter(isManifest);
    if (manifests.length === 0) unreadable.push(name);
    own.push(...manifests);
  }
  if (own.length === 0 && unreadable.length === 0) {
    write('shutro-erp check: no module of your own in src/modules/ — nothing to check.\n');
    return 0;
  }
  // What they may refer to: the installed apps, when the project has them.
  const installedFile = values.modules ?? 'src/modules.ts';
  const installed = existsSync(resolve(cwd, installedFile))
    ? await modulesOf(installedFile, cwd)
    : [];
  const catalogue = withDependencies([...installed, ...own]);
  const ownNames = new Set(own.map((m) => m['name'] as string));
  const underCheck = catalogue.filter((m) => ownNames.has(m['name'] as string));

  const enforced = new Set(
    Object.keys(RULES).filter((rule) => values.strict === true || !RELAXED.has(rule)),
  );
  const result = await checkStandard(underCheck, catalogue);
  const { lines, broken } = standardReport(result, enforced, values.all === true);
  if (unreadable.length > 0)
    lines.push(
      `no manifest exported by index.ts: ${unreadable.map((n) => `src/modules/${n}`).join(', ')}`,
    );
  write(
    `shutro-erp check: ${result.modules} module(s), ${result.models} model(s), ${result.open.length} open finding(s), ${result.waived.length} waived\n`,
  );
  if (lines.length > 0) write(`${lines.join('\n')}\n`);
  if (broken > 0 || unreadable.length > 0) {
    write(
      `shutro-erp check: ${broken} failing finding(s). Fix them, or waive one with its reason in the manifest (standard: { waive: [{ rule, model, reason }] }).\n`,
    );
    return 1;
  }
  write('shutro-erp check: your modules meet the module standard.\n');
  return 0;
}
