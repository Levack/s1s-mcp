import { it, expect, vi } from 'vitest';
import { configSchema } from '../src/config.js';
import { SystemOne, type Evaluate } from '../src/system-one.js';

const evaluate: Evaluate = async () => ({ model: 'jev-test', usage: { input_tokens: 10, output_tokens: 1 }, answers: { q: { type: 'noul', noul: 0.9 } } });
const request = { state: 'x', questions: { q: { type: 'noul' as const } } };

it('rejects oversized requests before calling a provider', async () => {
  const call = vi.fn(evaluate);
  const service = new SystemOne(configSchema.parse({ maxBatchBytes: 1024 }), call);
  await expect(service.evaluateRequest({ ...request, state: 'x'.repeat(1024) })).rejects.toThrow('maxBatchBytes');
  expect(call).not.toHaveBeenCalled();
});

it('shares the concurrency limit across calls and forwards cancellation', async () => {
  let active = 0, max = 0;
  const service = new SystemOne(configSchema.parse({ concurrency: 1 }), async (input, signal) => {
    signal?.throwIfAborted();
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return evaluate(input);
  });
  await Promise.all([service.evaluateRequest(request), service.evaluateRequest(request)]);
  expect(max).toBe(1);
  const controller = new AbortController(); controller.abort();
  await expect(service.evaluateRequest(request, controller.signal)).rejects.toThrow();
});
