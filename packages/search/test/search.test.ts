import type { SearchSpec } from '@isahaq/kosh-views';
import { describe, expect, test } from 'vitest';
import {
  addFacet,
  compileSearch,
  decodeSearch,
  encodeSearch,
  SearchError,
  suggestions,
  toggle,
} from '../src/index.js';

const spec: SearchSpec = {
  fields: ['name', 'partner.name'],
  filters: {
    draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
    submitted: { label: 'Submitted', domain: { state: 'submitted' }, group: 'state' },
    big: { label: 'Big', domain: { amountTotal: { gt: '100000' } } },
    mine: { label: 'Mine', domain: { createdBy: { $env: 'uid' } } },
  },
  groupBy: ['partner', 'state', 'dateOrder:month'],
};

describe('compileSearch', () => {
  test('facets OR within a field, filters OR within a group, AND across; the action domain always applies', () => {
    let state = addFacet({}, 'name', 'acme');
    state = addFacet(state, 'name', 'beta');
    state = addFacet(state, 'partner.name', 'dhaka');
    const compiled = compileSearch(
      spec,
      { ...state, filters: ['draft', 'submitted', 'big'], groupBy: ['partner'] },
      { company: 1 },
    );
    expect(compiled).toEqual({
      where: {
        and: [
          { company: 1 },
          { or: [{ name: { ilike: '%acme%' } }, { name: { ilike: '%beta%' } }] },
          { 'partner.name': { ilike: '%dhaka%' } },
          { or: [{ state: 'draft' }, { state: 'submitted' }] },
          { amountTotal: { gt: '100000' } },
        ],
      },
      groupBy: ['partner'],
      order: [],
    });
  });

  test('LIKE wildcards typed by the user are literal', () => {
    expect(compileSearch(spec, addFacet({}, 'name', '50%_off')).where).toEqual({
      name: { ilike: '%50\\%\\_off%' },
    });
  });

  test('nothing selected: no domain', () => {
    expect(compileSearch(spec, {}).where).toBeUndefined();
  });

  test('keys the spec does not offer are refused', () => {
    expect(() => compileSearch(spec, { filters: ['nope'] })).toThrow(SearchError);
    expect(() => compileSearch(spec, { facets: [{ field: 'secret', values: ['x'] }] })).toThrow(
      SearchError,
    );
    expect(() => compileSearch(spec, { groupBy: ['amountTotal'] })).toThrow(SearchError);
  });
});

describe('URL state', () => {
  test('round-trips, and malformed input is dropped', () => {
    const state = {
      facets: [{ field: 'name', values: ['acme'] }],
      filters: ['big'],
      groupBy: ['dateOrder:month'],
      custom: { amountTotal: { gt: 5 } },
    };
    expect(decodeSearch(encodeSearch(state))).toEqual(state);
    expect(encodeSearch({})).toBe('');
    expect(decodeSearch('{not json')).toEqual({});
    expect(decodeSearch('{"f":[["name"]],"x":[1,"big"]}')).toEqual({ filters: ['big'] });
  });

  test('helpers', () => {
    expect(suggestions(spec, ' acme ')).toEqual([
      { field: 'name', value: 'acme' },
      { field: 'partner.name', value: 'acme' },
    ]);
    expect(toggle(['a'], 'a')).toEqual([]);
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
  });
});
