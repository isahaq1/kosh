/**
 * `pnpm certify [adapter …]` (RFC 0034 §2.2): runs the adapters' contract suites against the providers' real
 * sandboxes and rewrites their recordings, whose date is the adapter's certification. Credentials come from the
 * environment (each suite names its variables); without them a suite uses the provider's public demo account where
 * there is one. `pnpm test` replays the recordings.
 */
import { spawnSync } from 'node:child_process';

const only = process.argv.slice(2);
const pattern = only.length === 0 ? ['certify/'] : only.map((a) => `certify/${a}.certify`);
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...pattern], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, KOSH_CERTIFY: 'live' },
});
process.exitCode = result.status ?? 1;
