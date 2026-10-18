import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/ui is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/ui', rfc: 'RFC 0007' });
});
