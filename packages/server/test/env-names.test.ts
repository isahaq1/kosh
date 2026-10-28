/** The environment's names: SHUTRO_ERP_* fill the KOSH_* names the code reads; a KOSH_* set already wins. */
import { expect, test } from 'vitest';
import { applyEnvironmentNames } from '../src/env-names.js';

test('SHUTRO_ERP_* settings are read under their KOSH_* names; the older names keep working', () => {
  const env = applyEnvironmentNames({
    SHUTRO_ERP_STORAGE_DIR: './files',
    SHUTRO_ERP_SECURE_COOKIES: 'false',
    KOSH_SECURE_COOKIES: 'true',
    KOSH_SCHEDULES: 'off',
  });
  expect(env['KOSH_STORAGE_DIR']).toBe('./files');
  expect(env['KOSH_SECURE_COOKIES']).toBe('true'); // set explicitly: kept
  expect(env['KOSH_SCHEDULES']).toBe('off');
});
