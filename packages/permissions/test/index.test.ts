import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/permissions is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/permissions', rfc: 'RFC 0003' });
});
