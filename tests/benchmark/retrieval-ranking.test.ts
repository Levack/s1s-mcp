import { describe, expect, it } from 'vitest';
import { lexicalRank, tokens, rankSymbols } from '../../benchmark/experiments/retrieval-ranking.js';

describe('local retrieval candidate ranking', () => {
  it('matches identifiers across common spelling conventions', () => {
    expect(tokens('getDataLayer get_data_layer')).toEqual(['get', 'data', 'layer', 'get', 'data', 'layer']);
  });
  it('uses rare issue terms without treating repeated common terms as decisive', () => {
    const docs = ['request request request request network', 'request throttle retry', 'request network'];
    expect(lexicalRank('request throttle', docs, x => x)[0]).toBe(docs[1]);
  });
  it('preserves input order for absent evidence and handles empty inputs', () => {
    expect(lexicalRank('missing', ['b', 'a'], x => x)).toEqual(['b', 'a']);
    expect(lexicalRank('query', [], String)).toEqual([]);
  });
});

it('retains explicitly named functions ahead of loose prose matches', () => {
  const rows = [
    { id: 'client.py:Client.start', signature: 'configure data layer settings request' },
    { id: 'data/__init__.py:get_data_layer', signature: 'def get_data_layer():' },
  ];
  expect(rankSymbols('configure data layer settings request; fix get_data_layer()', rows)[0]).toBe(rows[1]);
});
