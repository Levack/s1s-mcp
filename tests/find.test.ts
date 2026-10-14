import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileFinder } from '../src/find.js';
import { configSchema } from '../src/config.js';

it('recursively evaluates a directory without a filename list and returns repository-relative source evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-find-directory-'));
  try {
    await mkdir(path.join(root, 'src/nested'), { recursive: true });
    await writeFile(path.join(root, 'outside.py'), 'outside scope');
    await writeFile(path.join(root, 'src/auth.py'), 'def refresh_token(): pass');
    await writeFile(path.join(root, 'src/nested/readme.txt'), 'description');
    await writeFile(path.join(root, 'src/.env'), 'excluded');
    const names: string[][] = [];
    const finder = new FileFinder(configSchema.parse({ roots: [root] }), async request => {
      if ('task' in (request.state as object)) names.push(Object.values(request.questions).map(q => String(q.instructions)));
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
        answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) };
    });
    const result = await finder.find({ question: 'Find token refresh', directory: 'src', inspect: true });
    expect(names).toEqual([['src/auth.py', 'src/nested/readme.txt']]);
    expect(result).toMatchObject({ matched: 2, judged: 2, contentJudged: 2, basis: 'paths_then_shortlisted_content' });
    expect(result.results[0]).toMatchObject({ path: 'src/auth.py', snippet: expect.stringContaining('refresh_token') });
    const filtered = await finder.find({ question: 'Find token refresh', directory: 'src', files: ['**/*.py'] });
    expect(filtered.results.map(row => row.path)).toEqual(['src/auth.py']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('treats directory names literally and prevents escaping configured roots before evaluation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-find-directory-safety-'));
  const outside = await mkdtemp(path.join(tmpdir(), 's1s-find-directory-outside-'));
  let calls = 0;
  try {
    await mkdir(path.join(root, '[literal]'));
    await writeFile(path.join(root, '[literal]/code.py'), 'code');
    await writeFile(path.join(root, 'file.py'), 'not a directory');
    await symlink(outside, path.join(root, 'escape'));
    const finder = new FileFinder(configSchema.parse({ roots: [root] }), async request => {
      calls++;
      expect(Object.values(request.questions).map(q => q.instructions)).toEqual(['[literal]/code.py']);
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers: { p0: { type: 'noul', noul: 0.5 } } };
    });
    expect(await finder.find({ question: 'Find code', directory: '[literal]' })).toMatchObject({ judged: 1 });
    for (const directory of ['../', outside, '.git', 'escape', 'file.py']) {
      await expect(finder.find({ question: 'Find code', directory })).rejects.toThrow();
    }
    expect(await finder.find({ question: 'Find code', directory: 'missing' })).toMatchObject({ matched: 0, judged: 0 });
    expect(calls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('enumerates all filenames with independent noul judgments and short output keys and retains unknown scores', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-find-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/auth.py'), 'CONTENT_MUST_NOT_BE_READ');
    await writeFile(path.join(root, 'other.py'), 'other');
    await writeFile(path.join(root, 'unknown.py'), 'unknown');
    await writeFile(path.join(root, '.env'), 'SECRET');
    const finder = new FileFinder(configSchema.parse({ roots: [root] }), async request => {
      expect(Object.keys(request.questions)).toEqual(['p0', 'p1', 'p2']);
      expect(Object.values(request.questions).map(q => q.instructions)).toEqual(['other.py', 'src/auth.py', 'unknown.py']);
      expect(JSON.stringify(request)).not.toContain('CONTENT_MUST_NOT_BE_READ');
      expect(Object.values(request.questions).every(q => q.type === 'noul')).toBe(true);
      expect(Object.values(request.questions).every(q => typeof q.instructions === 'string')).toBe(true);
      return { model: 'test', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
        p1: { type: 'noul', noul: 0.9 }, p0: { type: 'noul', noul: 0.1 },
      } };
    });
    const result = await finder.find({ question: 'Find authentication' });
    expect(result).toMatchObject({ matched: 3, judged: 2, coverage: 'partial', results: [
      { path: 'src/auth.py', probability: 0.9 }, { path: 'other.py', probability: 0.1 }, { path: 'unknown.py', probability: null },
    ] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('evaluates 811 filenames in one request when the configured byte budget fits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-find-bulk-'));
  try {
    await Promise.all(Array.from({ length: 811 }, (_, i) => writeFile(path.join(root, `module_${i}.py`), '')));
    let calls = 0;
    const finder = new FileFinder(configSchema.parse({ roots: [root], maxBatchBytes: 128000 }), async request => {
      calls++;
      expect(Object.keys(request.questions)).toHaveLength(811);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(128000);
      return { model: 'test', usage: { input_tokens: 1, output_tokens: 1, cost: 0.001 },
        answers: Object.fromEntries(Object.keys(request.questions).map(file => [file, { type: 'noul', noul: 0.5 }])) };
    });
    expect(await finder.find({ question: 'Find authentication' })).toMatchObject({ matched: 811, judged: 811, batches: 1, coverage: 'complete' });
    expect(calls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps escaped and multibyte filenames within the request byte limit without losing candidates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-find-bytes-'));
  try {
    const names = Array.from({ length: 40 }, (_, i) => `module_é_${i}_"quoted".py`).sort();
    await Promise.all(names.map(name => writeFile(path.join(root, name), '')));
    const seen: string[] = [];
    const finder = new FileFinder(configSchema.parse({ roots: [root], maxBatchBytes: 1024 }), async request => {
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(1024);
      seen.push(...Object.values(request.questions).map(q => String(q.instructions)));
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
        answers: Object.fromEntries(Object.keys(request.questions).map(file => [file, { type: 'noul', noul: 0.5 }])) };
    });
    const result = await finder.find({ question: 'Find the café code' });
    expect(result.batches).toBeGreaterThan(1);
    expect(result.judged).toBe(names.length);
    expect(seen.sort()).toEqual(names);
  } finally { await rm(root, { recursive: true, force: true }); }
});
