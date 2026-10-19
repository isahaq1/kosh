import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.js';

test('@isahaq/kosh-reporting is wired into the workspace', () => {
  expect(PACKAGE).toEqual({ name: '@isahaq/kosh-reporting', rfc: 'RFC 0005' });
});
