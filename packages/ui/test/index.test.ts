import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-ui is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-ui', rfc: 'RFC 0007' });
});
