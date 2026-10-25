/**
 * `@kosh/ui/vite`: the Vite plugin that serves and builds the service worker (`/sw.js`). In development it is
 * served as is (no caching, push works); a build emits it with the bundle's assets to cache, under a version that
 * changes with them, so the app opens offline and updates itself after a deploy.
 *
 * ```ts
 * import { koshPwa } from '@kosh/ui/vite';
 * export default defineConfig({ plugins: [react(), tailwindcss(), koshPwa()] });
 * ```
 */
import type { Plugin } from 'vite';
import { serviceWorkerSource } from './worker.js';

export interface KoshPwaOptions {
  /** More files of `public/` to cache for offline use (absolute paths). The icon and the manifest always are. */
  readonly extraAssets?: readonly string[];
}

const CACHED = /\.(?:js|css|woff2?|svg|png|webp|ico)$/;

/** A short stable digest of the asset list (no Node import: the package stays browser-only). */
function digest(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const part of parts)
    for (let i = 0; i < part.length; i += 1) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  return h.toString(16).padStart(8, '0');
}

/** The plugin. */
export function koshPwa(options: KoshPwaOptions = {}): Plugin {
  return {
    name: 'kosh-pwa',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_request, response) => {
        response.setHeader('content-type', 'text/javascript');
        response.setHeader('cache-control', 'no-cache');
        response.end(serviceWorkerSource({ version: 'dev', assets: [] }));
      });
    },
    generateBundle(_output, bundle) {
      const built = Object.keys(bundle)
        .filter((file) => CACHED.test(file))
        .map((file) => `/${file}`);
      const assets = [
        ...new Set([
          '/index.html',
          '/manifest.webmanifest',
          '/icon.svg',
          ...(options.extraAssets ?? []),
          ...built,
        ]),
      ].sort();
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerSource({ version: digest(assets), assets }),
      });
    },
  };
}
