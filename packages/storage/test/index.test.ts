import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/storage is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/storage', rfc: 'RFC 0006' });
});
