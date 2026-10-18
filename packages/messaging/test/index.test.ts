import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/messaging is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/messaging', rfc: 'RFC 0006' });
});
