import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-jobs is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-jobs', rfc: 'RFC 0006' });
});
