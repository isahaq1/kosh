/**
 * Lets Node run the workspace's TypeScript sources as they are: ESM imports in the sources end in `.js`
 * (`./apps.js`), and Node's type stripping does not look for the `.ts` beside them — this hook does, when the `.js`
 * is missing and the `.ts` (or `.tsx`) exists. Used by `scripts/check-modules.ts`:
 *
 *   node --import ./scripts/source-loader.mjs --conditions=@kosh/source scripts/check-modules.ts
 */
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

register(
  `data:text/javascript,${encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
    const parent = context.parentURL;
    if (parent === undefined || !parent.startsWith('file:')) throw error;
    const base = new URL(specifier, parent).href.replace(/\\.js$/, '');
    for (const ext of ['.ts', '.tsx']) {
      const candidate = base + ext;
      if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
    }
    throw error;
  }
}
`)}`,
  pathToFileURL(fileURLToPath(import.meta.url)),
);
void existsSync;
