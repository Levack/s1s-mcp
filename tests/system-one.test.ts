import { it, expect, vi } from 'vitest';
import { configSchema } from '../src/config.js';
import { SystemOne, primitiveSchemas, type Evaluate } from '../src/system-one.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const evaluate: Evaluate = async request => ({ model: 'jev-test', usage: { input_tokens: 10, output_tokens: 1 },
  answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id,
    q.type === 'noul' ? { type: 'noul', noul: 0.9 }
      : q.type === 'score' ? { type: 'score', score: 1.4, confidence: 0.3, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0, 1: 0.6, 2: 0.4 } }
        : { type: 'choice', choice: 'auth', confidence: 0.8, probabilities: { auth: 0.9, other: 0.1 } },
  ])) });

it('exposes every primitive through MCP, preserving state, structured rubrics and raw answers', async () => {
  const call = vi.fn(evaluate);
  const config = configSchema.parse({});
  const server = createServer(config, new SystemOne(config, call));
  const client = new Client({ name: 'primitive-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const state = { contents: 'Actual contents read by the client', path: '/does/not/exist', url: 'https://invalid.invalid/' };
    const requests = {
      noul: { first: { instructions: { question: 'Relevant?' }, criteria: { true: 'Useful', false: null } }, second: {} },
      score: { relevance: { criteria: ['low', { meaning: 'medium' }, ['high']] } },
      choice: { category: { type: 'choice', criteria: { auth: { description: 'Authentication' }, other: null } } },
    };
    for (const type of ['noul', 'score', 'choice'] as const) {
      const result = await client.callTool({ name: type, arguments: { state, questions: requests[type], model: 'custom-model' } });
      expect(result.isError).not.toBe(true);
      const submitted = call.mock.calls.at(-1)![0];
      expect(submitted.state).toEqual(state);
      expect(submitted.model).toBe('custom-model');
      expect(Object.values(submitted.questions).every(q => q.type === type)).toBe(true);
      expect(result.structuredContent).toEqual(await evaluate(submitted));
    }
    const invalid = await client.callTool({ name: 'choice', arguments: { state, questions: { x: { criteria: {} } } } });
    expect(invalid.isError).toBe(true);
    expect(call).toHaveBeenCalledTimes(3);
  } finally { await client.close(); await server.close(); }
});

it('rejects mixed types, invalid criteria, missing state, and oversized requests before calling a provider', async () => {
  expect(() => primitiveSchemas.noul.parse({ questions: { q: {} } })).toThrow();
  expect(() => primitiveSchemas.noul.parse({ state: 'x', questions: { q: { type: 'choice' } } })).toThrow();
  expect(() => primitiveSchemas.score.parse({ state: 'x', questions: { q: { criteria: ['only'] } } })).toThrow();
  const call = vi.fn(evaluate);
  const service = new SystemOne(configSchema.parse({ maxBatchBytes: 1024 }), call);
  await expect(service.run('noul', { state: 'x'.repeat(1024), questions: { q: {} } })).rejects.toThrow('maxBatchBytes');
  expect(call).not.toHaveBeenCalled();
});

it('shares the concurrency limit across calls and forwards cancellation', async () => {
  let active = 0, max = 0;
  const config = configSchema.parse({ concurrency: 1 });
  const service = new SystemOne(config, async (request, signal) => {
    signal?.throwIfAborted();
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return evaluate(request);
  });
  const input = { state: null, questions: { q: {} } };
  await Promise.all([service.run('noul', input), service.run('noul', input)]);
  expect(max).toBe(1);
  const controller = new AbortController(); controller.abort();
  await expect(service.run('noul', input, controller.signal)).rejects.toThrow();
});

it('reports missing or mismatched answers as failures', async () => {
  const service = new SystemOne(configSchema.parse({}), async () => ({ model: 'test', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }));
  await expect(service.run('noul', { state: 'x', questions: { q: {} } })).rejects.toThrow('missing or mismatched');
});
