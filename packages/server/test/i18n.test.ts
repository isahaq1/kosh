/** Translated metadata (RFC 0023 §3.1): dictionaries merged, picked by language, applied to what is served. */
import { expect, test } from 'vitest';
import { dictionaryFor, loadDictionaries, translateDetail, translateValue } from '../src/i18n.js';

test('modules’ dictionaries merge per language; empty entries never win', async () => {
  const dictionaries = await loadDictionaries([
    { i18n: { bn: async () => ({ bn: { Customer: 'গ্রাহক', Name: '' } }) } },
    { i18n: { bn: async () => ({ bn: { Name: 'নাম', Customer: 'ক্রেতা' } }) } },
    {},
  ]);
  const bn = dictionaries.get('bn');
  expect(bn?.get('Customer')).toBe('গ্রাহক'); // the first module's
  expect(bn?.get('Name')).toBe('নাম');
});

test('the language picks the dictionary: bn_BD falls back to bn; English is served as it is', () => {
  const dictionaries = new Map([['bn', new Map([['Name', 'নাম']])]]);
  expect(dictionaryFor(dictionaries, 'bn_BD')?.get('Name')).toBe('নাম');
  expect(dictionaryFor(dictionaries, 'en_US')).toBeNull();
  expect(dictionaryFor(dictionaries, 'fr')).toBeNull();
});

test('people-facing strings and selection labels are translated; values and ids are not', () => {
  const dict = new Map([
    ['Customer', 'গ্রাহক'],
    ['Draft', 'খসড়া'],
    ['Confirm', 'নিশ্চিত করুন'],
  ]);
  const served = {
    view: {
      model: 'sale.order',
      sheet: [{ kind: 'field', field: 'partner', label: 'Customer' }],
      header: { buttons: [{ transition: 'confirm', label: 'Confirm' }] },
    },
    fields: { state: { options: [['draft', 'Draft']], label: 'Status' } },
  };
  expect(translateValue(served, dict)).toEqual({
    view: {
      model: 'sale.order',
      sheet: [{ kind: 'field', field: 'partner', label: 'গ্রাহক' }],
      header: { buttons: [{ transition: 'confirm', label: 'নিশ্চিত করুন' }] },
    },
    fields: { state: { options: [['draft', 'খসড়া']], label: 'Status' } },
  });
});

test('a problem’s detail has its known message translated', () => {
  const dict = new Map([['A project ends on or after it starts.', 'প্রকল্প শুরুর দিন বা পরে শেষ হয়।']]);
  expect(translateDetail('project.project: A project ends on or after it starts.', dict)).toBe(
    'project.project: প্রকল্প শুরুর দিন বা পরে শেষ হয়।',
  );
});
