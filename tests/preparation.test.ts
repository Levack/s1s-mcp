import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.js';
import { TextChunkCache, readTextChunks, listPathEntries } from '../src/files.js';
import { Screener } from '../src/screen.js';
import { PathRanker } from '../src/path-ranking.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

it('packs all 512 names by bytes, with stable coverage and escaped UTF-8 keys', async () => {
  const paths = Array.from({ length: 512 }, (_, i) => `src/é-${i}-".py`);
  const config = configSchema.parse({ maxBatchBytes: 128000 });
  let calls = 0;
  const seen: string[] = [];
  const ranker = new PathRanker(new Screener(config, async request => {
    calls++;
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(config.maxBatchBytes);
    const items = (request.state as { items: { key: string; content: string }[] }).items;
    seen.push(...items.map(item => item.content.slice('File: '.length)));
    return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(items.map(item => [item.key, { type: 'noul' as const, noul: 0.5 }])) };
  }));
  const result = await ranker.rank({ question: 'Find implementation', paths });
  expect(calls).toBe(1);
  expect(seen).toEqual(paths);
  expect(result.results.map(row => row.path)).toEqual(paths);
});

it('splits capacity batches at the byte cap without dropping candidates', async () => {
  const config = configSchema.parse({ maxBatchBytes: 2000 });
  let calls = 0;
  const ranker = new PathRanker(new Screener(config, async request => {
    calls++;
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(2000);
    return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul' as const, noul: 0.5 }])) };
  }));
  const result = await ranker.rank({ question: 'Find code', paths: Array.from({ length: 40 }, (_, i) => `é-${i}.py`) });
  expect(calls).toBeGreaterThan(1);
  expect(result.judged).toBe(40);
  expect(result.errors).toEqual([]);
});

it('stats only the selected listing page, retaining total count and stable ordering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-page-'));
  try {
    await Promise.all(['a', 'b', 'c'].map(name => writeFile(path.join(root, name), name)));
    vi.mocked(stat).mockClear();
    const page = await listPathEntries(configSchema.parse({ roots: [root] }), '.', 1, 1);
    expect(page).toEqual({ totalEntries: 3, entries: [{ path: 'b', kind: 'file', bytes: 1 }] });
    expect(stat).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reuses chunks but invalidates edits, replacements, chunk sizes and unsafe paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-cache-'));
  const outside = await mkdtemp(path.join(tmpdir(), 's1s-cache-outside-'));
  const cache = new TextChunkCache();
  const get = vi.spyOn(cache, 'get');
  const file = path.join(root, 'code.py');
  const config = configSchema.parse({ roots: [root] });
  try {
    await writeFile(file, 'first');
    const first = await readTextChunks(file, config, 100, cache);
    first[0]!.text = 'caller mutation';
    expect((await readTextChunks(file, config, 100, cache))[0]!.text).toBe('first');
    expect(get.mock.results.at(-1)!.value).toBeDefined();
    await writeFile(file, 'other');
    expect((await readTextChunks(file, config, 100, cache))[0]!.text).toBe('other');
    expect(get.mock.results.at(-1)!.value).toBeUndefined();
    await readTextChunks(file, config, 50, cache);
    expect(get.mock.results.at(-1)!.value).toBeUndefined();
    await rm(file); await writeFile(file, 'third');
    expect((await readTextChunks(file, config, 100, cache))[0]!.text).toBe('third');
    await writeFile(path.join(outside, 'code.py'), 'outside');
    await rm(file); await symlink(path.join(outside, 'code.py'), file);
    await expect(readTextChunks(file, config, 100, cache)).rejects.toThrow('outside');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('bounds the cache and returns independent chunks', () => {
  const cache = new TextChunkCache(240);
  const chunks = [{ text: 'example', startLine: 1, endLine: 1 }];
  cache.set('first', 'v1', chunks);
  cache.set('second', 'v1', chunks);
  expect(cache.get('first', 'v1')).toBeUndefined();
  expect(cache.get('second', 'v1')).toEqual(chunks);
  expect(cache.get('second', 'v2')).toBeUndefined();
});

it('starts evaluation before later read windows and keeps file order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-pipeline-'));
  try {
    const files = Array.from({ length: 10 }, (_, i) => `${i}.py`);
    await Promise.all(files.map(file => writeFile(path.join(root, file), 'before')));
    let calls = 0;
    const contents: string[] = [];
    const screener = new Screener(configSchema.parse({ roots: [root], batchSize: 1, concurrency: 1 }), async request => {
      if (++calls === 1) await writeFile(path.join(root, '9.py'), 'updated by first evaluation');
      const items = (request.state as { items: { key: string; content: string }[] }).items;
      contents.push(...items.map(item => item.content));
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(items.map(item => [item.key, { type: 'noul' as const, noul: 0.5 }])) };
    });
    const result = await screener.filter({ question: 'Find code', files });
    expect(result.judged).toBe(10);
    expect(contents.at(-1)).toContain('updated by first evaluation');
    expect(result.results.map(row => 'path' in row ? row.path : '')).toEqual(files);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('stops scheduling additional batches on cancellation and drains active work', async () => {
  const controller = new AbortController();
  let calls = 0;
  const screener = new Screener(configSchema.parse({ batchSize: 1, concurrency: 1 }), async () => {
    calls++;
    controller.abort(new Error('cancelled'));
    return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers: {} };
  });
  await expect(screener.filter({ question: 'Find code', texts: Array.from({ length: 20 }, (_, i) => ({ id: String(i), content: 'code' })) }, controller.signal))
    .rejects.toThrow('cancelled');
  expect(calls).toBe(1);
});
