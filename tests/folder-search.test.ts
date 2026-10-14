import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FolderSearch } from '../src/folder-search.js';
import { configSchema } from '../src/config.js';

it('applies gitignore text before limits and evaluation, preserving negation and directory rules', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-ignore-'));
  try {
    await mkdir(path.join(root, 'src/generated'), { recursive: true });
    for (const file of ['keep.py', 'drop.py', 'notes.txt', '.env']) await writeFile(path.join(root, 'src', file), 'body');
    await Promise.all(Array.from({ length: 90 }, (_, i) => writeFile(path.join(root, `src/generated/${i}.py`), 'excluded')));
    let calls = 0;
    const search = new FolderSearch(configSchema.parse({ roots: [root] }), async request => {
      calls++;
      expect(Object.values(request.questions).map(q => q.instructions)).toEqual(['src/keep.py', 'src/notes.txt']);
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.5 }])) };
    });
    expect(await search.search({ question: 'Find code', root_folder: 'src', gitignore: '# rules\ngenerated/\n*.py\n!keep.py\n!.env' }, 'names'))
      .toMatchObject({ matched: 2, judged: 2 });
    expect(calls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('judges all eligible contents without a filename relevance shortlist', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-contents-'));
  try {
    await writeFile(path.join(root, 'unrelated_name.py'), 'def refresh_token(): pass');
    await writeFile(path.join(root, 'authentication.py'), 'def add(): pass');
    const seen: string[] = [];
    const search = new FolderSearch(configSchema.parse({ roots: [root] }), async request => {
      expect(request.state).not.toHaveProperty('task');
      const items = (request.state as { items: { key: string; source: string; content: string }[] }).items;
      seen.push(...items.map(item => item.source));
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(items.map(item => [item.key, { type: 'noul', noul: item.content.includes('refresh_token') ? 0.9 : 0.1 }])) };
    });
    const result = await search.search({ question: 'Find token refresh', root_folder: '.' }, 'contents');
    expect(seen.sort()).toEqual(['authentication.py', 'unrelated_name.py']);
    expect(result.results[0]).toMatchObject({ path: 'unrelated_name.py', snippet: expect.stringContaining('refresh_token') });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('handles repository-root gitignore rules while traversing nested directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-root-ignore-'));
  try {
    for (const directory of ['docs', 'src/nested', 'dist']) await mkdir(path.join(root, directory), { recursive: true });
    for (const file of ['docs/readme.md', 'src/nested/code.py', 'src/nested/cache.pyc', 'dist/bundle.js']) await writeFile(path.join(root, file), 'code');
    const search = new FolderSearch(configSchema.parse({ roots: [root] }), async request => ({
      model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) }));
    const result = await search.search({ question: 'Find implementation', root_folder: '.', gitignore: '*.pyc\n.build\n/dist\n' }, 'names');
    expect(result.results.map(row => row.path).sort()).toEqual(['docs/readme.md', 'src/nested/code.py']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects oversized content scopes without provider work and allows exclusions to narrow them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-content-budget-'));
  let calls = 0;
  try {
    await Promise.all(Array.from({ length: 81 }, (_, i) => writeFile(path.join(root, `file${i}.py`), 'code')));
    const search = new FolderSearch(configSchema.parse({ roots: [root] }), async request => {
      calls++;
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) };
    });
    expect(await search.search({ question: 'Find code', root_folder: '.' }, 'contents'))
      .toMatchObject({ limitReached: true, judged: 0, guidance: expect.stringContaining('root_folder') });
    expect(calls).toBe(0);
    expect(await search.search({ question: 'Find code', root_folder: '.', gitignore: '*\n!file0.py' }, 'contents'))
      .toMatchObject({ judged: 1, limitReached: false });
    expect(calls).toBe(1);
    await writeFile(path.join(root, 'file0.py'), 'x'.repeat(800001));
    expect(await search.search({ question: 'Find code', root_folder: '.', gitignore: '*\n!file0.py' }, 'contents'))
      .toMatchObject({ judged: 0, limitReached: true });
    expect(calls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('searches explicit candidates across folders without judging unrelated files and validates traversal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-candidates-'));
  try {
    for (const directory of ['src', 'tests', 'noise']) await mkdir(path.join(root, directory));
    await writeFile(path.join(root, 'src/auth.py'), 'def refresh_token(): pass');
    await writeFile(path.join(root, 'tests/test_auth.py'), 'def test_refresh(): pass');
    await Promise.all(Array.from({ length: 90 }, (_, i) => writeFile(path.join(root, `noise/${i}.py`), 'noise')));
    const seen: string[] = [];
    const search = new FolderSearch(configSchema.parse({ roots: [root] }), async request => {
      const items = (request.state as { items: { key: string; source: string }[] }).items;
      seen.push(...items.map(item => item.source));
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(items.map(item => [item.key, { type: 'noul', noul: 0.9 }])) };
    });
    const result = await search.search({ question: 'Find refresh', files: ['src/auth.py', 'tests/test_auth.py'], topK: 1 }, 'contents');
    expect(seen.sort()).toEqual(['src/auth.py', 'tests/test_auth.py']);
    expect(result).toMatchObject({ judged: 2, limitReached: false });
    expect(result.results).toHaveLength(1);
    await expect(search.search({ question: 'Find refresh', files: ['../outside.py'] }, 'contents')).rejects.toThrow('relative');
    expect(seen).toHaveLength(2);
    const scoped = await search.search({ question: 'Find refresh', root_folder: 'src', files: ['auth.py'] }, 'contents');
    expect(scoped.results[0]).toMatchObject({ path: 'src/auth.py' });
    const copied = await search.search({ question: 'Find refresh', root_folder: 'src', files: ['src/auth.py'] }, 'contents');
    expect(copied.results[0]).toMatchObject({ path: 'src/auth.py' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('can return evidence from the top three name candidates in one call while keeping other candidates visible', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-inspect-'));
  const contents: string[] = [];
  try {
    for (const name of ['a.py', 'b.py', 'c.py', 'd.py']) await writeFile(path.join(root, name), `def ${name[0]}(): pass`);
    const search = new FolderSearch(configSchema.parse({ roots: [root] }), async request => {
      const state = request.state as { task?: string; items?: { key: string; source: string }[] };
      const items = state.items;
      if (items) contents.push(...items.map(item => item.source));
      return { model: 'test', usage: { input_tokens: 1, output_tokens: 1, cost: 0.001 },
        answers: Object.fromEntries(Object.keys(request.questions).map(key => [key,
          { type: 'noul', noul: items ? 0.9 : request.questions[key]!.instructions === 'd.py' ? 0.1 : 0.8 }])) };
    });
    const result = await search.search({ question: 'Find implementation', inspect: true }, 'names');
    expect(contents.sort()).toEqual(['a.py', 'b.py', 'c.py']);
    expect(result).toMatchObject({ basis: 'paths_then_shortlisted_content', contentJudged: 3,
      shortlistedPaths: expect.arrayContaining([expect.objectContaining({ path: 'd.py' })]),
      usage: { cost: 0.002 } });
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toHaveProperty('snippet');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('returns exact matches and line context with no provider calls, even for more than 80 files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-literal-'));
  try {
    await Promise.all(Array.from({ length: 81 }, (_, i) => writeFile(path.join(root, `noise${i}.py`), 'unrelated')));
    await writeFile(path.join(root, 'auth.py'), '# context\ndef refresh_token():\n    return "[a.b]"\n');
    await writeFile(path.join(root, '.env'), '[a.b]');
    const search = new FolderSearch(configSchema.parse({ roots: [root] }), async () => { throw new Error('No provider work allowed'); });
    const result = await search.search({ question: 'Find exact text', literal: '[a.b]' }, 'contents');
    expect(result).toMatchObject({ basis: 'literal', matchingFiles: 1, judged: 0, batches: 0,
      usage: { cost: 0 }, coverage: 'complete', results: [{ path: 'auth.py', lines: [1, 4], snippet: expect.stringContaining('def refresh_token') }] });
    const absent = await search.search({ question: 'Find exact text', literal: 'REFRESH_TOKEN' }, 'contents');
    expect(absent).toMatchObject({ matchingFiles: 0, results: [], coverage: 'complete' });
    await expect(search.search({ question: 'Find code', literal: 'x\ny' }, 'contents')).rejects.toThrow('single-line');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps exact matches visible in long lines and reports partial coverage for unreadable contents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-literal-long-'));
  try {
    await writeFile(path.join(root, 'long.py'), 'x'.repeat(1000) + 'needle' + 'y'.repeat(1000));
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    const search = new FolderSearch(configSchema.parse({ roots: [root] }), async () => { throw new Error('No provider'); });
    const result = await search.search({ question: 'Find needle', literal: 'needle' }, 'contents');
    expect(result).toMatchObject({ coverage: 'partial', errors: [expect.objectContaining({ id: 'binary.bin' })],
      results: [{ path: 'long.py', snippet: expect.stringContaining('needle') }] });
    expect(result.results[0]!.snippet!.length).toBeLessThan(510);
  } finally { await rm(root, { recursive: true, force: true }); }
});
