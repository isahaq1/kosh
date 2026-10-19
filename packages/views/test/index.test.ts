import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-views is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-views', rfc: 'RFC 0004' });
});
