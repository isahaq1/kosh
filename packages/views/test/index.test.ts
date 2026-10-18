import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/views is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/views', rfc: 'RFC 0004' });
});
