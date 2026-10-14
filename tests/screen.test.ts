import { describe, it, expect } from 'vitest';
import { configSchema } from '../src/config.js';
import { Screener, filterSchema, classifySchema, rateSchema } from '../src/screen.js';
import { providerEvaluate, safeError, type Evaluate } from '../src/system-one.js';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TypeSafeClient, APIError } from '@typesafe-ai/sdk';

const config = configSchema.parse({ batchSize: 1, concurrency: 2 });
const texts = ['a', 'b', 'c', 'd'].map(id => ({ id, content: `text ${id}` }));
type Item = { key: string; source: string; content: string };
const items = (request: Parameters<Evaluate>[0]) => (request.state as { items: Item[] }).items;
// Answers each item from its content, so results do not depend on batching.
const answering = (answer: (item: Item) => Record<string, unknown>): Evaluate => async request => ({
  model: 'jev', usage: { input_tokens: 10, output_tokens: 2, cost: 0.001 },
  answers: Object.fromEntries(items(request).map(item => [item.key, answer(item)])) as never });
const noul = (map: Record<string, number>) => answering(item => ({ type: 'noul', noul: map[item.source] ?? 0 }));

describe('filter', () => {
  it('asks one yes/no question per item and returns only likely-yes items, most probable first', async () => {
    let active = 0, peak = 0;
    const base = noul({ a: 0.6, b: 0.9, c: 0.2, d: 0.9 });
    const result = await new Screener(config, async request => {
      active++; peak = Math.max(peak, active); await delay(15); active--;
      expect(request.questions.c0).toMatchObject({ type: 'noul', criteria: { true: 'Mentions billing', false: 'No' },
        instructions: { question: 'Is this about billing?' } });
      return base(request);
    }).filter({ question: 'Is this about billing?', yes: 'Mentions billing', texts });
    expect(peak).toBe(2);
    expect(result.results).toEqual([{ id: 'b', probability: 0.9 }, { id: 'd', probability: 0.9 }, { id: 'a', probability: 0.6 }]);
    expect(result).toMatchObject({ rejected: 1, matched: 4, judged: 4, chunks: 4, batches: 4, models: ['jev'],
      usage: { input_tokens: 40, output_tokens: 8, cost: 0.004 } });
  });
  it('reads files under roots, splits large files, and reports the best line range', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 's1s-filter-'));
    const outside = await mkdtemp(path.join(tmpdir(), 's1s-outside-'));
    try {
      await mkdir(path.join(dir, 'src'));
      await writeFile(path.join(dir, 'src', 'auth.py'), 'def login():\n    token = 1\n');
      await writeFile(path.join(dir, 'src', 'big.py'), Array.from({ length: 40 }, (_, i) => i === 30 ? 'def verify_token(): pass' : `x${i} = ${i}`).join('\n'));
      await writeFile(path.join(dir, 'src', 'util.py'), 'def add(a, b):\n    return a + b\n');
      await writeFile(path.join(dir, 'src', 'blob.py'), Buffer.from([0, 1]));
      await writeFile(path.join(dir, 'src', '.env'), 'token=SECRET');
      await writeFile(path.join(outside, 'out.py'), 'token = "outside"');
      await symlink(path.join(outside, 'out.py'), path.join(dir, 'src', 'escape.py'));
      const contents: string[] = [];
      const result = await new Screener(configSchema.parse({ roots: [dir], maxFileBytes: 300, batchSize: 1 }), answering(item => {
        contents.push(item.content);
        return { type: 'noul', noul: item.content.includes('token') ? 0.9 : 0.1 };
      })).filter({ question: 'Does this handle tokens?', files: ['src/**/*.py'] });
      expect(result.results.map(r => 'path' in r && r.path)).toEqual(['src/auth.py', 'src/big.py']);
      const [start, end] = result.results[1]!.lines!;
      expect(start).toBeLessThanOrEqual(31); expect(end).toBeGreaterThanOrEqual(31);
      expect(result).toMatchObject({ matched: 4, judged: 3, limitReached: false });
      expect(result.errors).toEqual([{ id: 'src/blob.py', error: 'Binary files are unsupported' }]);
      expect(result.chunks).toBeGreaterThan(3);
      expect(contents.every(c => Buffer.byteLength(c) <= 300)).toBe(true);
      expect(contents.join()).not.toContain('SECRET'); expect(contents.join()).not.toContain('outside');
      await expect(new Screener(configSchema.parse({ roots: [dir] })).filter({ question: 'x', files: ['../*.py'] })).rejects.toThrow('relative');
    } finally { await rm(dir, { recursive: true }); await rm(outside, { recursive: true }); }
  });
});

describe('rate', () => {
  it('returns all scores by default and applies optional cutoffs only after judging every candidate', async () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({ id: String(i), content: `candidate ${i}` }));
    const evaluate = answering(item => ({ type: 'score', score: Number(item.source) / 24, confidence: 1, legend: {}, probabilities: {} }));
    const screener = new Screener(config, evaluate);
    const input = { question: 'Useful?', levels: ['no', 'yes'], texts: candidates };
    expect(rateSchema.parse(input)).not.toHaveProperty('topK');
    expect(rateSchema.parse(input)).not.toHaveProperty('threshold');
    const all = await screener.rate(input);
    expect(all.results).toHaveLength(25);
    expect(all.judged).toBe(25);
    const selected = await screener.rate({ ...input, topK: 2, threshold: 0.9 });
    expect(selected.results.map(row => 'id' in row && row.id)).toEqual(['24', '23']);
    expect(selected.judged).toBe(25);
    expect(selected.usage).toEqual(all.usage);
  });
  it('normalizes scores to 0–1, names the nearest level, and averages over parts', async () => {
    const levels = ['clearly A', 'leans A', 'leans B', 'clearly B'];
    const scores: Record<string, number> = { a: 0, b: 3, c: 1.6, d: 2 };
    const result = await new Screener(config, answering(item => ({ type: 'score', score: scores[item.source]!, confidence: 0.8,
      legend: Object.fromEntries(levels.map((l, i) => [i, l])), probabilities: {} }))).rate({ question: 'A or B?', levels, texts, topK: 3 });
    expect(result.results.map(r => [('id' in r) && r.id, r.level])).toEqual([['b', 'clearly B'], ['d', 'leans B'], ['c', 'leans B']]);
    expect(result.results[2]!.score).toBeCloseTo(1.6 / 3);
    expect(result.belowThreshold).toBe(1);
    const long = { id: 'long', content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') };
    let part = 0;
    const averaged = await new Screener(configSchema.parse({ maxFileBytes: 300, batchSize: 1 }), answering(() =>
      ({ type: 'score', score: part++ % 2 ? 2 : 0, confidence: 1, legend: {}, probabilities: {} }))).rate({ question: 'x', levels: ['low', 'mid', 'high'], texts: [long] });
    expect(averaged.chunks).toBeGreaterThan(1);
    expect(averaged.results[0]!.score).toBeGreaterThan(0.3); expect(averaged.results[0]!.score).toBeLessThan(0.7);
  });
});

describe('classify', () => {
  it('groups every item under its most probable option', async () => {
    const probabilities: Record<string, Record<string, number>> = {
      a: { auth: 0.9, db: 0.1 }, b: { auth: 0.2, db: 0.8 }, c: { auth: 0.6, db: 0.4 }, d: { auth: 0.3, db: 0.7 } };
    const result = await new Screener(config, answering(item => {
      const p = probabilities[item.source]!;
      return { type: 'choice', choice: p.auth! > p.db! ? 'auth' : 'db', confidence: 1, probabilities: p };
    })).classify({ question: 'Which area?', options: { auth: 'Authentication', db: 'Persistence', ui: 'Interface' }, texts });
    expect(result.groups).toEqual({ auth: [{ id: 'a', probability: 0.9 }, { id: 'c', probability: 0.6 }],
      db: [{ id: 'b', probability: 0.8 }, { id: 'd', probability: 0.7 }], ui: [] });
  });
});

describe('screening engine', () => {
  it('bounds concurrency across simultaneous calls on the same screener', async () => {
    let active = 0, peak = 0;
    const base = noul({});
    const screener = new Screener(config, async request => { active++; peak = Math.max(peak, active); await delay(10); active--; return base(request); });
    await Promise.all([screener.filter({ question: 'x', texts }), screener.filter({ question: 'y', texts })]);
    expect(peak).toBe(2);
  });
  it('reports failed and malformed answers as errors instead of treating them as no', async () => {
    let n = 0;
    const result = await new Screener(config, async request => {
      if (n++ === 0) throw new Error('Unavailable');
      return { model: 'jev', usage: { input_tokens: 1, output_tokens: 1 }, answers: { [items(request)[0]!.key]: { type: 'noul', noul: 4 } } };
    }).filter({ question: 'x', texts: texts.slice(0, 2), threshold: 0 });
    expect(result.results).toEqual([]); expect(result.judged).toBe(0);
    expect(result.errors.map(e => e.error).sort()).toEqual(['Provider returned a missing or invalid answer', 'Unavailable']);
  });
  it('packs several items per request and splits by encoded byte size', async () => {
    const sizes: number[] = [], counts: number[] = [];
    const base = noul({});
    await new Screener(configSchema.parse({ batchSize: 8, maxBatchBytes: 2200 }), async request => {
      sizes.push(Buffer.byteLength(JSON.stringify(request))); counts.push(Object.keys(request.questions).length);
      return base(request);
    }).filter({ question: 'x', texts: texts.map(t => ({ ...t, content: 'x'.repeat(500) })) });
    expect(counts.some(n => n > 1)).toBe(true); expect(counts.length).toBeGreaterThan(1);
    expect(sizes.every(n => n <= 2200)).toBe(true);
  });
  it('propagates cancellation and never starts queued provider calls after abort', async () => {
    const controller = new AbortController(); let calls = 0;
    const screening = new Screener(configSchema.parse({ concurrency: 1, batchSize: 1 }), async (_request, signal) => {
      calls++; await delay(1000, undefined, { signal }); throw new Error('Unreachable');
    }).filter({ question: 'x', texts }, controller.signal);
    await delay(20); controller.abort();
    await expect(screening).rejects.toThrow(); await delay(20); expect(calls).toBe(1);
  });
  it('requires exactly one source, unique text IDs, ordered levels and 2–255 options', () => {
    expect(() => filterSchema.parse({ question: 'x' })).toThrow();
    expect(() => filterSchema.parse({ question: 'x', texts, files: ['**/*'] })).toThrow();
    expect(() => filterSchema.parse({ question: 'x', texts: [texts[0], texts[0]] })).toThrow();
    expect(() => rateSchema.parse({ question: 'x', texts, levels: ['only'] })).toThrow();
    expect(() => classifySchema.parse({ question: 'x', texts, options: { only: 'One' } })).toThrow();
    expect(filterSchema.parse({ question: 'x', files: ['src/**'] })).toMatchObject({ threshold: 0.5, topK: 20, maxFiles: 500 });
  });
  it('uses the official SDK endpoint and redacts HTTP response bodies', async () => {
    let called = '';
    const client = new TypeSafeClient({ apiKey: 'not-a-real-key', baseURL: 'https://example.test', retry: { maxRetries: 0 },
      fetch: async url => {
        called = url;
        return new Response(JSON.stringify({ model: 'jev', usage: { input_tokens: 1, output_tokens: 1 }, answers: { c0: { type: 'noul', noul: 0.9 } } }), { status: 200 });
      } });
    const result = await new Screener(config, (request, signal) => client.systemOne(request, { signal })).filter({ question: 'x', texts: [texts[0]!] });
    expect(called).toBe('https://example.test/v1/systemone'); expect(result.results[0]?.probability).toBe(0.9);
    expect(() => providerEvaluate(config)).toThrow('No provider API key');
    expect(safeError(new APIError(400, { detail: 'secret-key and document contents' }, new Headers()))).toBe('Provider HTTP 400');
  });
});
