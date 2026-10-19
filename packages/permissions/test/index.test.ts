import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-permissions is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-permissions', rfc: 'RFC 0003' });
});
