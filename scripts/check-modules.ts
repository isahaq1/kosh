/**
 * The module standard (RFC 0023): every module in `modules/` is measured against the rules of §3, and `pnpm lint`
 * fails when an enforced rule is broken by a model the module has not waived (`standard: { waive: [...] }` in the
 * manifest, with a reason). The rules live in `packages/cli/src/standard.ts`, shared with `shutro-erp check`
 * (RFC 0034), which runs them on a company's own modules.
 *
 *   node --import ./scripts/source-loader.mjs --conditions=@kosh/source scripts/check-modules.ts [--all]
 *
 * `--all` prints every rule's result, met or not.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkStandard,
  isManifest,
  RULES,
  standardReport,
  withDependencies,
} from '../packages/cli/src/standard.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const all = process.argv.includes('--all');

// Every module on disk, through its package entry (`modules/<name>/src/index.ts`).
const onDisk = existsSync(join(root, 'modules')) ? readdirSync(join(root, 'modules')).sort() : [];
const missing: string[] = [];
const found: unknown[] = [];
for (const name of onDisk) {
  if (!existsSync(join(root, 'modules', name, 'src', 'index.ts'))) continue;
  const exported = (await import(`../modules/${name}/src/index.ts`)) as Record<string, unknown>;
  const manifests = Object.values(exported).filter(isManifest);
  if (manifests.length === 0) missing.push(name);
  found.push(...manifests);
}
const catalogue = withDependencies(found);
const modules = catalogue.filter((m) => onDisk.includes(m['name'] as string));

// The repository enforces every rule.
const result = await checkStandard(modules, catalogue);
const { lines, broken } = standardReport(result, new Set(Object.keys(RULES)), all);
if (missing.length > 0) lines.push(`no manifest exported by src/index.ts: ${missing.join(', ')}`);
process.stdout.write(
  `check-modules: ${result.modules} modules, ${result.models} models, ${result.open.length} open findings, ${result.waived.length} waived\n`,
);
process.stdout.write(`${lines.join('\n')}\n`);
if (broken > 0 || missing.length > 0) {
  process.stderr.write(
    `check-modules: ${broken} failing finding(s) of enforced rules${missing.length > 0 ? `; ${missing.length} module(s) without a manifest` : ''}. Fix them or waive them with a reason (RFC 0023).\n`,
  );
  process.exit(1);
}
