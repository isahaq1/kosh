/** Starting the installation after `kosh init`: the package manager that ran it, the browser command. */
import { expect, test } from 'vitest';
import { browserCommand, packageManager } from '../src/launch.js';

test('the package manager comes from the one that ran the installer', () => {
  expect(
    packageManager({ npm_config_user_agent: 'pnpm/11.18.0 npm/? node/v24.1.0 win32 x64' }),
  ).toBe('pnpm');
  expect(packageManager({ npm_config_user_agent: 'yarn/4.5.0 npm/? node/v24.1.0' })).toBe('yarn');
  expect(packageManager({ npm_config_user_agent: 'bun/1.2.0 npm/? node/v24.1.0' })).toBe('bun');
  expect(packageManager({ npm_config_user_agent: 'npm/11.0.0 node/v24.1.0' })).toBe('npm');
  expect(packageManager({})).toBe('npm');
});

test('the default browser opens the back-office on each system', () => {
  const url = 'http://localhost:5173';
  expect(browserCommand(url, 'win32')).toEqual(['cmd', ['/c', 'start', '""', url]]);
  expect(browserCommand(url, 'darwin')).toEqual(['open', [url]]);
  expect(browserCommand(url, 'linux')).toEqual(['xdg-open', [url]]);
});
