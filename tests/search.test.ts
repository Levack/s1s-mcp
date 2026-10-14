import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SourceSearch } from '../src/search.js';
import { configSchema } from '../src/config.js';

it('returns the actual judged source chunk and spends nothing on an overbroad scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-search-'));
  let calls = 0;
  try {
    await writeFile(path.join(root, 'auth.py'), Array.from({ length: 80 }, (_, i) => i === 65 ? 'def refresh_token(): pass' : `unrelated_${i} = 0`).join('\n'));
    await writeFile(path.join(root, 'other.py'), 'def add(a, b): return a + b');
    const search = new SourceSearch(configSchema.parse({ roots: [root], maxFileBytes: 500 }), async request => {
      calls++;
      const items = (request.state as { items: { key: string; content: string }[] }).items;
      return { model: 'test', usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(items.map(item => [item.key, { type: 'noul' as const, noul: item.content.includes('refresh_token') ? 0.95 : 0.05 }])) };
    });
    expect(await search.search({ question: 'Find token refresh', files: ['*.py'], maxFiles: 1 })).toMatchObject({ limitReached: true, judged: 0 });
    expect(calls).toBe(0);
    const found = await search.search({ question: 'Find token refresh', files: ['*.py'], topK: 1 });
    expect(found.results[0]).toMatchObject({ path: 'auth.py', probability: 0.95, snippet: expect.stringContaining('def refresh_token') });
    expect(found.results[0]!.lines![0]).toBeLessThanOrEqual(66);
    expect(found.results[0]!.lines![1]).toBeGreaterThanOrEqual(66);
    const filtered = await search.search({ question: 'Find token refresh', files: ['*.py'], topK: 2 });
    const weak = filtered.results.find(row => row.path === 'other.py')!;
    expect(weak).toMatchObject({ probability: 0.05, snippetOmitted: true });
    expect(weak.snippet).toBeUndefined();
    expect((await search.search({ question: 'Find token refresh', files: ['other.py'], snippetThreshold: 0 })).results[0])
      .toMatchObject({ path: 'other.py', snippet: expect.stringContaining('def add') });
    await writeFile(path.join(root, 'huge.py'), 'x'.repeat(800001));
    const before = calls;
    expect(await search.search({ question: 'x', files: ['huge.py'] })).toMatchObject({ limitReached: true, judged: 0 });
    expect(calls).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('can focus one-call retrieval on identifier neighborhoods and reports unjudged chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-search-focus-'));
  try {
    await writeFile(path.join(root, 'a.py'), [
      ...Array.from({ length: 200 }, (_, i) => `# before ${i} ${'x'.repeat(30)}`),
      'def known_symbol(): pass',
      ...Array.from({ length: 200 }, (_, i) => `# after ${i} ${'x'.repeat(30)}`),
    ].join('\n'));
    let questionCopies = 0;
    const search = new SourceSearch(configSchema.parse({ roots: [root], maxFileBytes: 1500 }), async request => {
      expect(request.state).toHaveProperty('criteria');
      for (const q of Object.values(request.questions)) {
        expect(q.instructions).not.toHaveProperty('question');
        questionCopies++;
      }
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
        answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) };
    });
    const result = await search.search({ question: 'Find known_symbol', files: ['a.py'], focusTerms: ['known_symbol'], snippetsPerFile: 2 });
    expect(result.omittedChunks).toBeGreaterThan(0);
    expect(result.coverage).toBe('partial');
    expect(questionCopies).toBe(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
