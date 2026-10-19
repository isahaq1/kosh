import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-realtime is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-realtime', rfc: 'RFC 0006' });
});
