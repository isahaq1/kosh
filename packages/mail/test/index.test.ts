import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-mail is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-mail', rfc: 'RFC 0006' });
});
