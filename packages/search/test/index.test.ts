import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/search is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/search', rfc: 'RFC 0004' });
});
