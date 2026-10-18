import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@kosh/reporting is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@kosh/reporting', rfc: 'RFC 0005' });
});
