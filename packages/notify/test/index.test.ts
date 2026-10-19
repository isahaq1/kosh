import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-notify is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-notify', rfc: 'RFC 0006' });
});
