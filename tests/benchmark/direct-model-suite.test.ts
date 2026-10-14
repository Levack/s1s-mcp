import { expect, it } from 'vitest';
import { bodyCandidates } from '../../benchmark/experiments/direct-model-suite.js';
import { batches } from '../../benchmark/experiments/direct-model-ranking.js';

it('merges property definitions and keeps evidence clipped without using gold labels', () => {
  const result = bodyCandidates('refresh_token', [
    {id:'a.py:Client.refresh_token', signature:'def refresh_token', body:'x'.repeat(9000)},
    {id:'a.py:Client.refresh_token', signature:'setter refresh_token', body:'setter'},
    {id:'b.py:other', signature:'def other', body:'other'},
  ]);
  expect(result).toHaveLength(2);
  expect(result[0]!.evidence).toContain('[OMITTED MIDDLE]');
  expect(result[0]!.evidence).toContain('setter');
  expect(Buffer.byteLength(result[0]!.evidence)).toBeLessThan(6200);
  expect(batches(result, 'issue').flat()).toEqual(result);
});
it('bounds function candidates deterministically before provider calls', () => {
  const symbols=Array.from({length:200},(_,i)=>({id:`a.py:f${i}`,signature:`def f${i}`,body:`def f${i}(): pass`}));
  expect(bodyCandidates('f199',symbols)).toHaveLength(160);
  expect(bodyCandidates('f199',symbols).some(c=>c.id==='a.py:f199')).toBe(true);
  expect(bodyCandidates('f199',symbols)).toEqual(bodyCandidates('f199',[...symbols].reverse()));
});
