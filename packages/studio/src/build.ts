/**
 * `kosh studio build`: regenerates the Studio modules of an installation from their `studio.json` (every
 * `src/modules/*\/studio.json`, or the folders named). Files whose content did not change are left alone, so a
 * build changes the working tree only when a spec did.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type GenerateOptions, generateModule } from './generate.js';
import type { StudioSpec } from './spec.js';

export interface BuildResult {
  readonly dir: string;
  readonly name: string;
  /** The files written (changed); the others were up to date. */
  readonly written: readonly string[];
}

/** Reads a module folder's `studio.json`. @throws when it is missing or not JSON */
export async function readSpec(dir: string): Promise<StudioSpec> {
  const file = join(dir, 'studio.json');
  return JSON.parse(await readFile(file, 'utf8')) as StudioSpec;
}

/** Regenerates one Studio module folder. */
export async function buildModule(
  dir: string,
  options: GenerateOptions = {},
): Promise<BuildResult> {
  const spec = await readSpec(dir);
  const files = generateModule(spec, options);
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    const current = existsSync(path) ? await readFile(path, 'utf8') : null;
    if (current === content) continue;
    await writeFile(path, content, 'utf8');
    written.push(name);
  }
  return { dir, name: spec.name, written };
}

/** The Studio module folders of an installation (`src/modules/<name>/studio.json`). */
export async function studioModules(cwd: string): Promise<string[]> {
  const root = join(cwd, 'src', 'modules');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && existsSync(join(root, entry.name, 'studio.json')))
      out.push(join(root, entry.name));
  return out.sort();
}

/** `kosh studio build [folder …]`. */
export async function runStudio(
  argv: readonly string[],
  write: (text: string) => void,
  cwd: string,
): Promise<number> {
  const [action, ...folders] = argv;
  if (action !== 'build') {
    write(
      'Usage: shutro-erp studio build [folder …]   (default: every src/modules/*/studio.json)\n',
    );
    return 2;
  }
  const dirs = folders.length > 0 ? folders.map((f) => resolve(cwd, f)) : await studioModules(cwd);
  if (dirs.length === 0) {
    write('No Studio module (src/modules/*/studio.json).\n');
    return 0;
  }
  let failed = 0;
  for (const dir of dirs) {
    try {
      const result = await buildModule(dir);
      write(
        result.written.length === 0
          ? `${result.name}: up to date\n`
          : `${result.name}: wrote ${result.written.join(', ')}\n`,
      );
    } catch (error) {
      failed += 1;
      write(`${dir}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return failed === 0 ? 0 : 1;
}
