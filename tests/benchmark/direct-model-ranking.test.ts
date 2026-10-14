import { describe, expect, it } from 'vitest';
import { batches, candidatesFromTrace, parseScores, scoreResponseFormat, completionScores } from '../../benchmark/experiments/direct-model-ranking.js';

describe('direct model comparison inputs', () => {
  it('requires all batch scores with no extra fields in strict Structured Outputs', () => {
    const format = scoreResponseFormat(2);
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema).toEqual({ type: 'object', properties: {
      p0: { type: 'number', minimum: 0, maximum: 1 }, p1: { type: 'number', minimum: 0, maximum: 1 },
    }, required: ['p0', 'p1'], additionalProperties: false });
    for (const count of [0, 65, 1.5]) expect(() => scoreResponseFormat(count)).toThrow();
  });
  it('rejects refused or truncated responses even if they contain parseable JSON', () => {
    const response = { choices: [{ finish_reason: 'stop', message: { content: '{"p0":0.5}' } }] };
    expect(completionScores(response, 1)).toEqual([0.5]);
    expect(() => completionScores({ choices: [{ ...response.choices[0]!, finish_reason: 'length' }] }, 1)).toThrow('incomplete');
    expect(() => completionScores({ choices: [{ finish_reason: 'stop', message: { refusal: 'Refused' } }] }, 1)).toThrow('refused');
    expect(() => completionScores({ choices: [] }, 1)).toThrow('missing choice');
    expect(() => completionScores({ choices: [{ finish_reason: 'stop', message: { content: 'Explanation\n{"p0":0.5}' } }] }, 1)).toThrow();
  });
  it('deduplicates filename batches and keeps function evidence separate without reading predictions', () => {
    const request = (state: { question?: string; issue?: string }, instructions: string) => ({ request: { state, questions: { p0: { instructions } } } });
    expect(candidatesFromTrace({ trace: [request({ question: 'q' }, 'a.py'), request({ question: 'q' }, 'a.py'), request({ issue: 'q' }, 'a.py:f\ndef f(): pass')] }))
      .toEqual({ names: [{ id: 'a.py', evidence: 'a.py' }], bodies: [{ id: 'a.py:f', evidence: 'a.py:f\ndef f(): pass' }] });
  });
  it('preserves multiple definitions sharing a function ID', () => {
    const result = candidatesFromTrace({ trace: ['one', 'two'].map(body => ({ request: { state: { issue: 'q' }, questions: { p0: { instructions: `a.py:f\n${body}` } } } })) });
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]!.evidence).toContain('one');
    expect(result.bodies[0]!.evidence).toContain('two');
  });
  it('preserves every candidate exactly once across bounded batches', () => {
    const candidates = Array.from({ length: 131 }, (_, i) => ({ id: `a${i}`, evidence: 'x'.repeat(1000) }));
    const groups = batches(candidates, 'issue');
    expect(groups.flat()).toEqual(candidates);
    expect(groups.every(g => g.length <= 64 && Buffer.byteLength(JSON.stringify({ question: 'issue', candidates: g })) <= 40000)).toBe(true);
    expect(() => batches([{ id: 'huge', evidence: 'x'.repeat(41000) }], 'issue')).toThrow();
  });
  it('requires exactly one finite probability for every candidate', () => {
    expect(parseScores({ p1: 0.7, p0: 0 }, 2)).toEqual([0, 0.7]);
    for (const raw of [{ p0: 1 }, { p0: 1, other: 0 }, { p0: -1, p1: 0 }, { p0: 0, p1: NaN }, { p0: 0, p1: '0.5' }]) {
      expect(() => parseScores(raw, 2)).toThrow();
    }
  });
});
