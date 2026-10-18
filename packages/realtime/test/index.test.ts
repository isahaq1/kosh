import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/realtime is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/realtime', rfc: 'RFC 0006' });
});
