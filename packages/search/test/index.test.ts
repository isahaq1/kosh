import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-search is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-search', rfc: 'RFC 0004' });
});
