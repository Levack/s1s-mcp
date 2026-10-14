import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradeLocalization, localizationSchema } from '../../benchmark/localization.js';
import { paramsSchema } from '../../benchmark/params.js';
import { run } from '../../benchmark/cli.js';
import { solve, type Complete } from '../../benchmark/agent.js';
import { configSchema } from '../../src/config.js';

it('selects the official dataset and validates benchmark-specific limits', () => {
  expect(paramsSchema.parse({ bench: 'loc-bench', limit: 560 }).dataset).toBe('czlll/Loc-Bench_V1');
  for (const raw of [{ bench: 'unknown' }, { bench: 'loc-bench', limit: 561 },
    { bench: 'loc-bench', dataset: 'MariusHobbhahn/swe-bench-verified-mini' }]) {
    expect(() => paramsSchema.parse(raw)).toThrow();
  }
});

it('requires every gold location, normalizes constructors, and deduplicates rankings', () => {
  const gold = ['a.py:A.__init__', 'b.py:fix'];
  expect(gradeLocalization(gold, { files: ['a.py'], functions: ['a.py:A'] })).toEqual({
    fileAcc5: false, fileAcc10: false, functionAcc10: false, functionAcc15: false,
  });
  const files = ['x.py', 'x.py', 'y.py', 'z.py', 'a.py', 'b.py'];
  expect(gradeLocalization(gold, { files, functions: ['./a.py:A', 'b.py:fix'] }).fileAcc5).toBe(true);
  expect(gradeLocalization(gold, { files: files.map(f => `/testbed/${f}`), functions: [] }).fileAcc5).toBe(true);
  expect(gradeLocalization(gold).functionAcc15).toBe(false);
  const six = Array.from({ length: 6 }, (_, i) => `f${i}.py:func`);
  expect(gradeLocalization(six, { files: six.map(f => f.split(':')[0]!), functions: six })).toMatchObject({ fileAcc5: false, fileAcc10: true });
  expect(() => localizationSchema.parse({ files: [], functions: ['not-a-function'] })).toThrow();
});

it('shares the location task prompt, adds only MCP tools, and recovers from an invalid finish', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 's1s-loc-agent-'));
  const prompts: string[] = [];
  try {
    for (const arm of ['baseline', 's1s'] as const) {
      let step = 0;
      const complete: Complete = async (messages, tools) => {
        prompts.push(messages[0]!.content!);
        expect(tools.find(t => t.function.name === 'finish')!.function.parameters).toHaveProperty('required', ['files', 'functions']);
        return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: String(step), type: 'function',
          function: { name: 'finish', arguments: step++ ? '{"files":["a.py"],"functions":["a.py:fix"]}' : '{}' } }] } }] };
      };
      const result = await solve({ instance_id: 'example-1', repo: 'owner/repo', base_commit: 'a'.repeat(40), problem_statement: 'Find a bug', image: 'unused' },
        arm, paramsSchema.parse({ bench: 'loc-bench', maxSteps: 2 }), configSchema.parse({}),
        { shell: async () => '', patch: async () => { throw new Error('No patch expected'); }, exportSource: async () => {}, exportCurrentSource: async () => {}, close: async () => {} },
        path.join(output, `${arm}.jsonl`), complete);
      expect(result).toMatchObject({ status: 'submitted', steps: 2, localization: { files: ['a.py'], functions: ['a.py:fix'] } });
    }
    expect(new Set(prompts).size).toBe(1);
    expect(prompts.every(prompt => prompt.includes('do not implement the change'))).toBe(true);
    expect(prompts[2]).toBe(prompts[0]);
    expect(prompts[2]).not.toContain('s1s_');
  } finally { await rm(output, { recursive: true, force: true }); }
});

it('runs both Loc-Bench arms and produces localization reports that can be regenerated', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 's1s-loc-dry-'));
  try {
    await run(paramsSchema.parse({ bench: 'loc-bench', dryRun: true, limit: 2, output }));
    const summary = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
    expect(summary.summary.map((s: { localization: object }) => s.localization)).toEqual([
      { fileAcc5: 1, fileAcc10: 1, functionAcc10: 1, functionAcc15: 1 },
      { fileAcc5: 1, fileAcc10: 1, functionAcc10: 1, functionAcc15: 1 },
    ]);
    expect(summary.summary).toMatchObject([
      { solverCalls: 4, s1sProviderCalls: 0, totalApiCalls: 4, mcpCalls: 0 },
      { solverCalls: 4, s1sProviderCalls: 0, totalApiCalls: 4, mcpCalls: 0 },
    ]);
    expect(await readFile(path.join(output, 'results.md'), 'utf8')).toContain('Function Acc@15');
    expect(await readFile(path.join(output, 'results.md'), 'utf8')).toContain('| s1s | 4 | 0 | 4 | 0 | 0 |');
    expect(await readFile(path.join(output, 'results.csv'), 'utf8')).toContain('"fileAcc5"');
    expect(await readFile(path.join(output, 'baseline-0.predictions.jsonl'), 'utf8')).not.toContain('model_patch');
    await run(paramsSchema.parse({ mode: 'report', output }));
    expect(await readFile(path.join(output, 'results.md'), 'utf8')).toContain('Loc-Bench V1');
  } finally { await rm(output, { recursive: true, force: true }); }
});
