/**
 * Copies a business app's generated schema view (`src/.kosh/schema.d.ts`) into `dist/.kosh/` after `tsc`: TypeScript
 * does not emit `.d.ts` sources, and the built bindings' types refer to it. Run from the app's directory.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const from = join(process.cwd(), 'src', '.kosh', 'schema.d.ts');
if (existsSync(from)) {
  mkdirSync(join(process.cwd(), 'dist', '.kosh'), { recursive: true });
  copyFileSync(from, join(process.cwd(), 'dist', '.kosh', 'schema.d.ts'));
}
