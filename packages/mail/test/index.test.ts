import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/mail is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/mail', rfc: 'RFC 0006' });
});
