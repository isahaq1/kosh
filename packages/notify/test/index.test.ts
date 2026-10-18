import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/notify is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/notify', rfc: 'RFC 0006' });
});
