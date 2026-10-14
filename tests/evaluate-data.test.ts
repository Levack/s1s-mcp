import { expect, it, vi } from 'vitest';
import { configSchema } from '../src/config.js';
import { SystemOne, type Evaluate } from '../src/system-one.js';
import { evaluateBoolean, evaluateScore, evaluateBooleanOutputSchema, evaluateScoreOutputSchema } from '../src/evaluate-data.js';

const input = { question: 'How long do tokens last?', items: [
  { id: 'web', data: { title: 'Docs', body: 'Tokens expire in 60 minutes.' }, answer: 'One hour.', source_url: 'https://example.com/docs' },
  { id: 'other', data: null },
], metrics: [{ id: 'supported', question: 'Is the answer supported by the evidence?' }] };
const config = configSchema.parse({ concurrency: 2 });
const response = (answers: Awaited<ReturnType<Evaluate>>['answers']) => ({ model: 'test', usage: { input_tokens: 5, output_tokens: 2 }, answers });

it('preserves arbitrary evidence, question/answer context and false results in a fixed boolean output', async () => {
  const provider = vi.fn<Evaluate>(async request => {
    const state = request.state as { item: { id: string } };
    return response({ m0: { type: 'noul', noul: state.item.id === 'web' ? 0.8 : 0.1 } });
  });
  const progress = vi.fn();
  const result = await evaluateBoolean(input, new SystemOne(config, provider), undefined, progress);
  expect(evaluateBooleanOutputSchema.safeParse(result).success).toBe(true);
  expect(result.results.map(item => item.metrics.supported)).toEqual([
    { value: true, probability: 0.8 }, { value: false, probability: 0.1 },
  ]);
  expect(provider.mock.calls[0]![0].state).toMatchObject({ question: input.question, item: input.items[0] });
  expect(provider.mock.calls[1]![0].state).toMatchObject({ item: { id: 'other', data: null } });
  expect(progress).toHaveBeenLastCalledWith(2, 2);
  expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 4, cost: null });
});

it('normalizes multiple independent score scales and never returns boolean fields', async () => {
  const result = await evaluateScore({ ...input, metrics: [
    { id: 'relevance', question: 'How relevant?', levels: ['none', 'some', 'strong'] },
    { id: 'correctness', question: 'How correct?', levels: ['wrong', 'right'] },
  ] }, new SystemOne(config, async () => response({
    m0: { type: 'score', score: 1.5 }, m1: { type: 'score', score: 0 },
  })));
  expect(evaluateScoreOutputSchema.safeParse(result).success).toBe(true);
  expect(result.results[0]!.metrics).toEqual({ relevance: { score: 0.75, level: 'strong' }, correctness: { score: 0, level: 'wrong' } });
});

it('rejects duplicate IDs and public mode selectors before provider calls', async () => {
  const provider = vi.fn<Evaluate>();
  const service = new SystemOne(config, provider);
  expect(() => evaluateBoolean({ ...input, items: [input.items[0], input.items[0]] }, service)).toThrow('IDs must be unique');
  expect(() => evaluateBoolean({ ...input, metrics: [input.metrics[0], input.metrics[0]] }, service)).toThrow('IDs must be unique');
  expect(() => evaluateBoolean({ ...input, metrics: [{ ...input.metrics[0], type: 'score' }] }, service)).toThrow();
  expect(() => evaluateScore(input, service)).toThrow();
  expect(provider).not.toHaveBeenCalled();
});

it('reports oversized items without truncating them and still evaluates other items', async () => {
  const provider = vi.fn<Evaluate>(async () => response({ m0: { type: 'noul', noul: 0.7 } }));
  const result = await evaluateBoolean({ ...input, items: [{ id: 'large', data: 'x'.repeat(3000) }, input.items[1]] },
    new SystemOne(configSchema.parse({ maxBatchBytes: 1500 }), provider));
  expect(provider).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ coverage: 'partial', judged: 1, errors: [{ id: 'large', metric: null, error: expect.stringContaining('maxBatchBytes') }] });
  expect(result.results[0]!.metrics).toEqual({});
});

it('reports missing, nonfinite and out-of-range provider answers without inventing decisions', async () => {
  for (const answers of [{}, { m0: { type: 'noul' as const, noul: NaN } }, { m0: { type: 'noul' as const, noul: 1.1 } }]) {
    const result = await evaluateBoolean(input, new SystemOne(config, async () => response(answers)));
    expect(result).toMatchObject({ judged: 0, coverage: 'partial' });
    expect(result.errors).toHaveLength(2);
    expect(result.results.every(item => Object.keys(item.metrics).length === 0)).toBe(true);
  }
  const result = await evaluateScore({ ...input, metrics: [{ id: 's', question: 'Score?', levels: ['a', 'b'] }] },
    new SystemOne(config, async () => response({ m0: { type: 'score', score: 2 } })));
  expect(result.judged).toBe(0);
});

it('reports provider failures and propagates cancellation', async () => {
  const provider = vi.fn<Evaluate>(async () => { throw new Error('Unavailable'); });
  const service = new SystemOne(config, provider);
  expect(await evaluateBoolean(input, service)).toMatchObject({ judged: 0, coverage: 'partial', errors: [
    { id: 'web', error: 'Unavailable' }, { id: 'other', error: 'Unavailable' },
  ] });
  provider.mockClear();
  const controller = new AbortController(); controller.abort();
  await expect(evaluateBoolean(input, service, controller.signal)).rejects.toThrow();
  expect(provider).not.toHaveBeenCalled();
});
