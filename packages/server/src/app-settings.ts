/**
 * Installation-wide app settings (RFC 0020 §3.1): read in code by key, the declared default when unset. Company
 * settings are `res.company` fields, read as the company's fields.
 */
import type { Env } from './orm.js';

/** The value of the installation setting `key` (`app.setting`), or `fallback` when it was never set. */
export async function installationSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  return env.asSuperuser({ reason: `setting ${key}` }, async (su) => {
    const found = await (
      su.model('kosh.setting' as never) as unknown as {
        search(q: unknown): Promise<{
          length: number;
          load(k: string[]): Promise<{ read(k: string[]): Record<string, unknown>[] }>;
        }>;
      }
    ).search({ where: { key }, limit: 1 });
    if (found.length === 0) return fallback;
    const [row] = (await found.load(['value'])).read(['value']);
    return (row?.['value'] ?? fallback) as T;
  });
}
