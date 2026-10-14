import { it, expect } from 'vitest';
import { configSchema } from '../src/config.js';
import { PathRanker } from '../src/path-ranking.js';
import { Screener } from '../src/screen.js';

it('scores explicit names without filesystem access, retaining low and missing scores', async () => {
  const config = configSchema.parse({ roots: ['/nonexistent/s1s-path-ranking-test'], batchSize: 2 });
  let calls = 0;
  const ranker = new PathRanker(new Screener(config, async request => {
    calls++;
    expect(request.state).toMatchObject({ question: 'Find authentication forms' });
    const items = (request.state as { items: { key: string; source: string; content: string }[] }).items;
    return { model: 'test', usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(items.filter(item => !item.content.includes('unknown'))
        .map(item => [item.key, { type: 'noul' as const, noul: item.content.includes('auth') ? 0.9 : 0.01 }])) };
  }));
  const input = { question: 'Find authentication forms', paths: ['docs/readme.md', 'src/auth/forms.py', 'unknown.py'] };
  const result = await ranker.rank(input);
  expect(result).toMatchObject({ matched: 3, judged: 2, batches: 1, basis: 'path_only', omitted: 0 });
  expect(result.results).toEqual([
    { path: 'src/auth/forms.py', score: 0.9 },
    { path: 'docs/readme.md', score: 0.01 },
    { path: 'unknown.py', score: null },
  ]);
  expect(result.errors).toMatchObject([{ id: 'unknown.py' }]);
  expect(calls).toBe(1);
  const limited = await ranker.rank({ ...input, topK: 1 });
  expect(limited.results).toEqual([{ path: 'src/auth/forms.py', score: 0.9 }]);
  expect(limited.omitted).toBe(2);
  const before = calls;
  for (const paths of [[], ['a.py', 'a.py'], ['a.py', ' a.py '], [' '], ['x'.repeat(513)]]) {
    await expect(ranker.rank({ question: 'x', paths })).rejects.toThrow();
  }
  expect(calls).toBe(before);
});

it('keeps paths with provider failures as unknown rather than irrelevant', async () => {
  const ranker = new PathRanker(new Screener(configSchema.parse({}), async () => { throw new Error('Provider unavailable'); }));
  const result = await ranker.rank({ question: 'Find code', paths: ['a.py', 'b.py'] });
  expect(result.results).toEqual([{ path: 'a.py', score: null }, { path: 'b.py', score: null }]);
  expect(result).toMatchObject({ judged: 0, errors: [{ id: 'a.py' }, { id: 'b.py' }] });
});
