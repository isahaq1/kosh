/**
 * The starter project: it installs every peer the bundle declares (they are optional for server-only installs, so
 * npm does not install them by itself; a missing one leaves the back-office blank: "Could not resolve
 * @tanstack/react-router imported by shutro-erp").
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { mainTsx, packageJson } from '../src/templates.js';

const root = join(import.meta.dirname, '..', '..', '..');

test('the starter installs every peer dependency of the shutro-erp bundle', () => {
  const peers = new Set<string>();
  for (const area of ['packages', 'modules'])
    for (const name of readdirSync(join(root, area))) {
      let manifest: { peerDependencies?: Record<string, string> };
      try {
        manifest = JSON.parse(readFileSync(join(root, area, name, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      for (const peer of Object.keys(manifest.peerDependencies ?? {})) peers.add(peer);
    }
  const starter = JSON.parse(
    packageJson({ name: 'shop', apps: [], port: 3000, koshVersion: '0.3.1' }, null),
  ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const installed = new Set([
    ...Object.keys(starter.dependencies),
    ...Object.keys(starter.devDependencies),
  ]);
  expect([...peers].filter((p) => !installed.has(p))).toEqual([]);
  expect(peers.has('@tanstack/react-router')).toBe(true);
});

// A name the starter imports and the app does not export leaves the whole back-office blank, sign-in included
// ("does not provide an export named 'calendar_syncMessages'", shutro-erp 0.3.9).
test('main.tsx of the starter imports only names the web entries of the apps export', () => {
  const main = mainTsx({ name: 'shop', apps: [], port: 3000, koshVersion: '0.3.1' });
  const imports = [...main.matchAll(/^import \{ ([^}]+) \} from 'shutro-erp\/(\w+)\/web';$/gm)];
  expect(imports.length).toBeGreaterThan(20);
  const missing: string[] = [];
  for (const [, names, app] of imports) {
    const entry = ['modules', 'packages']
      .flatMap((area) =>
        ['index.ts', 'index.tsx'].map((f) => join(root, area, app as string, 'src', 'web', f)),
      )
      .map((file) => {
        try {
          return readFileSync(file, 'utf8');
        } catch {
          return null;
        }
      })
      .find((source) => source !== null);
    if (entry === undefined || entry === null) {
      missing.push(`${app}: no web entry`);
      continue;
    }
    for (const name of (names as string).split(',').map((n) => n.trim()))
      if (!new RegExp(`export [^;]*\\b${name}\\b`).test(entry)) missing.push(`${app}: ${name}`);
  }
  expect(missing).toEqual([]);
});
