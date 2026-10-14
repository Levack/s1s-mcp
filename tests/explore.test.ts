import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.js';
import { PathExplorer } from '../src/explore.js';
import { Screener } from '../src/screen.js';
import type { Evaluate } from '../src/system-one.js';

it('ranks names without file contents, retains low scores, and pages all entries deterministically', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-paths-'));
  let calls = 0;
  const config = configSchema.parse({ roots: [dir, dir] });
  const evaluate: Evaluate = async request => {
    calls++;
    expect(JSON.stringify(request)).not.toContain('PRIVATE_CONTENT_MARKER');
    const items = (request.state as { items: { key: string; source: string; content: string }[] }).items;
    for (const item of items) expect(item.content).toMatch(/^(Directory|File): /);
    return { model: 'test', usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(items.map(item => [item.key, { type: 'noul' as const, noul: item.source.includes('auth') ? 0.9 : 0.01 }])) };
  };
  const explorer = new PathExplorer(config, new Screener(config, evaluate));
  try {
    for (const folder of ['auth', 'models', 'node_modules', 'dist', '.hidden']) await mkdir(path.join(dir, folder));
    await writeFile(path.join(dir, 'readme.md'), 'PRIVATE_CONTENT_MARKER');
    await writeFile(path.join(dir, 'auth/forms.py'), 'PRIVATE_CONTENT_MARKER');
    await writeFile(path.join(dir, '.env'), 'PRIVATE_CONTENT_MARKER');
    await writeFile(path.join(dir, 'credentials.json'), 'PRIVATE_CONTENT_MARKER');
    await symlink(path.join(dir, 'auth'), path.join(dir, 'alias'));
    const all = await explorer.explore({ question: 'Find authentication code', mode: 'rank' });
    expect(all).toMatchObject({ totalEntries: 3, listingComplete: true, nextOffset: null });
    expect(all.candidates).toMatchObject([
      { path: 'auth', kind: 'directory', probability: 0.9 },
      { path: 'models', kind: 'directory', probability: 0.01 },
      { path: 'readme.md', kind: 'file', probability: 0.01 },
    ]);
    const pages = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await explorer.explore({ question: 'Find auth', offset, limit: 1 });
      pages.push(...page.candidates.map(c => c.path)); offset = page.nextOffset;
    }
    expect(pages).toEqual(['auth', 'models', 'readme.md']);
    expect((await explorer.explore({ question: 'Find auth', scope: 'auth' })).candidates[0]).toMatchObject({ path: 'auth/forms.py', kind: 'file' });
    const before = calls;
    expect((await explorer.explore({ question: 'Find auth', offset: 100 })).candidates).toEqual([]);
    expect(calls).toBe(before);
    await expect(explorer.explore({ question: 'x', scope: '../' })).rejects.toThrow('relative');
    await expect(explorer.explore({ question: 'x', scope: '.hidden' })).rejects.toThrow('Hidden');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('reports missing scores without dropping unexplored alternatives', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-path-errors-'));
  const config = configSchema.parse({ roots: [dir] });
  try {
    await writeFile(path.join(dir, 'candidate.py'), 'code');
    const explorer = new PathExplorer(config, new Screener(config, async () => ({
      model: 'test', usage: { input_tokens: 1, output_tokens: 0 }, answers: {},
    })));
    const result = await explorer.explore({ question: 'Find code', mode: 'rank' });
    expect(result.candidates).toMatchObject([{ path: 'candidate.py', kind: 'file', probability: null }]);
    expect(result.errors).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('does not spend on content evaluation when a glob is truncated, but evaluates an exact-limit scope', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-truncated-'));
  const config = configSchema.parse({ roots: [dir] });
  let calls = 0;
  const screener = new Screener(config, async request => {
    calls++;
    return { model: 'test', usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul' as const, noul: 0.9 }])) };
  });
  try {
    await writeFile(path.join(dir, 'a.py'), 'a'); await writeFile(path.join(dir, 'b.py'), 'b');
    expect(await screener.filter({ question: 'x', files: ['*.py'], maxFiles: 1 })).toMatchObject({
      limitReached: true, coverage: 'partial', judged: 0, batches: 0, guidance: expect.stringContaining('explore_paths'),
    });
    expect(calls).toBe(0);
    expect(await screener.filter({ question: 'x', files: ['a.py'], maxFiles: 1 })).toMatchObject({ limitReached: false, judged: 1 });
    expect(calls).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


it('lists sizes and advisory routing with zero provider calls, including threshold boundaries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-routing-'));
  const config = configSchema.parse({ roots: [dir] });
  let calls = 0;
  const explorer = new PathExplorer(config, new Screener(config, async () => {
    calls++; throw new Error('Metadata listing must not evaluate');
  }));
  try {
    await mkdir(path.join(dir, 'nested'));
    await writeFile(path.join(dir, 'a.txt'), 'é'.repeat(4096));
    await writeFile(path.join(dir, 'b.txt'), 'x'.repeat(8193));
    const result = await explorer.explore({ question: 'Find relevant code' });
    expect(result).toMatchObject({ mode: 'list', matched: 3, judged: 0, batches: 0, directReadBytes: 8192 });
    expect(result.candidates).toEqual([
      { path: 'a.txt', kind: 'file', bytes: 8192, recommendedAction: 'read_directly' },
      { path: 'b.txt', kind: 'file', bytes: 8193, recommendedAction: 'screen_if_uncertain' },
      { path: 'nested', kind: 'directory', bytes: null, recommendedAction: 'expand' },
    ]);
    const custom = await explorer.explore({ question: 'Find relevant code', directReadBytes: 8193 });
    expect(custom.candidates[1].recommendedAction).toBe('read_directly');
    await expect(explorer.explore({ question: 'x', directReadBytes: 0 })).rejects.toThrow();
    expect(calls).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
