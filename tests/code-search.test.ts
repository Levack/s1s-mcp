import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodeSearch } from '../src/code-search.js';
import { configSchema } from '../src/config.js';

it('finishes discovery and content inspection in one search, keeping multiple source chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-code-search-'));
  let nameCalls = 0, contentCalls = 0;
  try {
    await writeFile(path.join(root, 'auth.py'), Array.from({ length: 200 }, (_, i) => `def refresh${i}(): return ${i}`).join('\n'));
    for (let i = 0; i < 13; i++) await writeFile(path.join(root, `noise${i}.py`), 'unrelated');
    const search = new CodeSearch(configSchema.parse({ roots: [root] }), async request => {
      const state = request.state as { task?: string; items?: { key: string; source: string }[] };
      if (state.task) nameCalls++; else contentCalls++;
      return { model: 'test', usage: { input_tokens: 1, output_tokens: 1, cost: 0.001 },
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id,
          { type: 'noul', noul: state.task ? q.instructions === 'auth.py' ? 0.9 : 0.1 : 0.9 }])) };
    });
    const result = await search.search({ question: 'Find authentication refresh implementation' });
    expect(result).toMatchObject({ retrievalComplete: true, basis: 'names_then_contents', inspectedFiles: 5, usage: { cost: 0.002 } });
    expect(nameCalls).toBe(1); expect(contentCalls).toBe(1);
    const auth = result.results.find(r => 'path' in r && r.path === 'auth.py')!;
    expect(auth.snippet).toBeTruthy();
    expect(auth.additionalSnippets).toHaveLength(1);
    expect(auth.additionalSnippets![0]!.snippet).not.toBe(auth.snippet);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('uses a supplied exact identifier to locate code in an uninformative filename without paid filename ranking', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-code-symbol-'));
  try {
    await mkdir(path.join(root, 'package'));
    await writeFile(path.join(root, 'package/__init__.py'), 'def get_data_layer():\n    return None\n');
    for (let i = 0; i < 13; i++) await writeFile(path.join(root, `noise${i}.py`), 'unrelated');
    let calls = 0;
    const search = new CodeSearch(configSchema.parse({ roots: [root] }), async request => {
      calls++;
      expect(request.state).not.toHaveProperty('task');
      expect(JSON.stringify(request.state)).toContain('get_data_layer');
      return { model: 'test', usage: { input_tokens: 1, output_tokens: 1, cost: 0.001 },
        answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) };
    });
    expect(await search.search({ question: 'Avoid repeated setup in get_data_layer()' })).toMatchObject({
      retrievalComplete: true, basis: 'exact_symbols_then_contents', nameJudgments: 0,
      results: [{ path: 'package/__init__.py', snippet: expect.stringContaining('get_data_layer') }] });
    expect(calls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('directly inspects a small folder and rejects scope escapes without provider work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-code-small-'));
  let calls = 0;
  try {
    await writeFile(path.join(root, 'a.py'), 'def authenticate(): pass');
    const search = new CodeSearch(configSchema.parse({ roots: [root] }), async request => {
      calls++; expect(request.state).not.toHaveProperty('task');
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
        answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) };
    });
    expect(await search.search({ question: 'Find authentication' })).toMatchObject({ basis: 'all_scoped_contents', retrievalComplete: true });
    await expect(search.search({ question: 'Find code', root_folder: '../' })).rejects.toThrow('relative');
    expect(calls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
