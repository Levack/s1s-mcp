import { describe, it, expect } from 'vitest';
import { configSchema } from '../src/config.js';
import { Ranker, providerEvaluate, rankSchema, safeError, type Evaluate } from '../src/rank.js';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TypeSafeClient, APIError } from '@typesafe-ai/sdk';
const config = configSchema.parse({ batchSize: 1, concurrency: 2 });
const candidates = ['a', 'b', 'c', 'd'].map(id => ({ id, content: id }));
describe('context filtering', () => {
  it('evaluates concurrent batches, preserves stable IDs, raw probabilities and weighted scores', async () => {
    let active = 0, peak = 0;
    const evaluate: Evaluate = async request => {
      active++; peak = Math.max(peak, active);
      await delay(15); active--;
      expect(request.state).toMatchObject({ purpose: 'Find evidence' });
      return { model: 'actual-model', usage: { input_tokens: 10, output_tokens: 2, cost: 0.001 }, answers: {
        c0_e0: { type: 'noul', noul: 0.8 },
        c0_e1: { type: 'score', score: 1, confidence: 0.9, legend: { 0: 'none', 1: 'partial', 2: 'direct' }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } },
      } };
    };
    const result = await new Ranker(config, evaluate).rank({ purpose: 'Find evidence', candidates,
      evaluations: [{ id: 'useful', type: 'noul', instructions: 'Useful?', weight: 2 },
        { id: 'support', type: 'score', instructions: 'Evidence?', levels: ['none', 'partial', 'direct'], weight: 1 }], topK: 2 });
    expect(peak).toBe(2);
    expect(result.results.map(r => r.id)).toEqual(['a', 'b']);
    expect(result.results[0]?.score).toBeCloseTo(0.7);
    expect(result.results[0]?.evaluations.support).toMatchObject({ confidence: 0.9, probabilities: { 1: 0.8 } });
    expect(result.usage).toEqual({ input_tokens: 40, output_tokens: 8, cost: 0.004 });
    expect(result.filteredCandidates).toBe(2);
    expect(result.models).toEqual(['actual-model']);
  });
  it('bounds concurrency across simultaneous calls on the same ranker', async () => {
    let active = 0, peak = 0;
    const ranker = new Ranker(config, async () => {
      active++; peak = Math.max(peak, active); await delay(10); active--;
      return { model: 'jev', usage: { input_tokens: 1, output_tokens: 1 }, answers: { c0_e0: { type: 'noul', noul: 1 } } };
    });
    await Promise.all([ranker.rank({ purpose: 'x', candidates }), ranker.rank({ purpose: 'y', candidates })]);
    expect(peak).toBe(2);
  });
  it('returns candidate errors for failed and malformed responses without treating them as irrelevant', async () => {
    let n = 0;
    const result = await new Ranker(config, async () => {
      n++;
      if (n === 1) throw new Error('Unavailable');
      return { model: 'jev', usage: { input_tokens: 1, output_tokens: 1 }, answers: { c0_e0: { type: 'noul', noul: 4 } } };
    }).rank({ purpose: 'x', candidates: candidates.slice(0, 2) });
    expect(result.results).toEqual([]); expect(result.errors).toHaveLength(2);
    expect(result.evaluatedCandidates).toBe(0);
  });
  it('packs multiple candidates in one request and splits by encoded byte size', async () => {
    const sizes: number[] = [];
    const counts: number[] = [];
    const bounded = configSchema.parse({ batchSize: 8, maxBatchBytes: 2200 });
    await new Ranker(bounded, async request => {
      sizes.push(Buffer.byteLength(JSON.stringify(request))); counts.push(Object.keys(request.questions).length);
      return { model: 'jev', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul' as const, noul: 0.2 }])) };
    }).rank({ purpose: 'x', candidates: candidates.map(c => ({ ...c, content: 'x'.repeat(200) })) });
    expect(counts.some(n => n > 1)).toBe(true); expect(counts.length).toBeGreaterThan(1);
    expect(sizes.every(n => n <= 2200)).toBe(true);
  });
  it('propagates cancellation and never starts queued provider calls after abort', async () => {
    const controller = new AbortController(); let calls = 0;
    const ranking = new Ranker(configSchema.parse({ concurrency: 1, batchSize: 1 }), async (_request, signal) => {
      calls++; await delay(1000, undefined, { signal }); throw new Error('Unreachable');
    }).rank({ purpose: 'x', candidates }, controller.signal);
    await delay(20); controller.abort();
    await expect(ranking).rejects.toThrow(); await delay(20); expect(calls).toBe(1);
  });
  it('rejects duplicate IDs, invalid rubrics and zero-only weights', () => {
    expect(() => rankSchema.parse({ purpose: 'x', candidates: [candidates[0], candidates[0]] })).toThrow();
    expect(() => rankSchema.parse({ purpose: 'x', candidates, evaluations: [{ id: 's', type: 'score', instructions: 'Rate' }] })).toThrow();
    expect(() => rankSchema.parse({ purpose: 'x', candidates, evaluations: [{ id: 'n', type: 'noul', instructions: 'Yes?', weight: 0 }] })).toThrow();
  });
  it('enforces roots, symlink escapes, sensitive files, byte limits and binary checks before sending', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 's1s-files-'));
    const outside = await mkdtemp(path.join(tmpdir(), 's1s-outside-'));
    try {
      await writeFile(path.join(dir, 'good.md'), 'useful');
      await writeFile(path.join(dir, '.env'), 'SECRET');
      await writeFile(path.join(dir, 'large.txt'), 'x'.repeat(200));
      await writeFile(path.join(dir, 'binary'), Buffer.from([0, 1]));
      await writeFile(path.join(outside, 'out.txt'), 'outside');
      await symlink(path.join(outside, 'out.txt'), path.join(dir, 'escape'));
      let sent = '';
      const result = await new Ranker(configSchema.parse({ roots: [dir], maxFileBytes: 100 }), async request => {
        sent = JSON.stringify(request);
        return { model: 'jev', usage: { input_tokens: 1, output_tokens: 1 }, answers: { c0_e0: { type: 'noul', noul: 1 } } };
      }).rank({ purpose: 'x', candidates: ['good.md', '.env', 'large.txt', 'binary', 'escape'].map(id => ({ id, path: path.join(dir, id) })) });
      expect(result.errors).toHaveLength(4); expect(result.results[0]?.id).toBe('good.md');
      expect(sent).not.toContain('SECRET'); expect(sent).not.toContain('outside');
    } finally { await rm(dir, { recursive: true }); await rm(outside, { recursive: true }); }
  });
  it('uses the official SDK endpoint with cancellation and redacts HTTP response bodies', async () => {
    let called = '';
    const client = new TypeSafeClient({ apiKey: 'not-a-real-key', baseURL: 'https://example.test', retry: { maxRetries: 0 },
      fetch: async (url, init) => {
        called = url;
        expect(init?.headers).toBeDefined();
        return new Response(JSON.stringify({ model: 'jev', usage: { input_tokens: 1, output_tokens: 1 }, answers: { c0_e0: { type: 'noul', noul: 0.9 } } }), { status: 200 });
      } });
    const result = await new Ranker(config, (request, signal) => client.systemOne(request, { signal })).rank({ purpose: 'x', candidates: [candidates[0]] });
    expect(called).toBe('https://example.test/v1/systemone'); expect(result.results[0]?.score).toBe(0.9);
    expect(() => providerEvaluate(config)).toThrow('No provider API key');
    const privateError = new APIError(400, { detail: 'secret-key and document contents' }, new Headers());
    expect(safeError(privateError)).toBe('Provider HTTP 400');
  });
});
