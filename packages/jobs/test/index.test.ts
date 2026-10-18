import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/jobs is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/jobs', rfc: 'RFC 0006' });
});
