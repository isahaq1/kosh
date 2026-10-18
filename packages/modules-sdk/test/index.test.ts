import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/modules-sdk is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/modules-sdk', rfc: 'RFC 0001' });
});
