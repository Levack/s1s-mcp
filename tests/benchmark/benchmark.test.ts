import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../../src/config.js';
import type { Evaluate } from '../../src/system-one.js';
import { paramsSchema, readParams } from '../../benchmark/params.js';
import { Ledger, pricedUsage } from '../../benchmark/accounting.js';
import { apiComplete, solve, type Complete, type Tool } from '../../benchmark/agent.js';
import { run } from '../../benchmark/cli.js';
import { join, summarize, type Attempt } from '../../benchmark/report.js';
import type { Workspace, Task } from '../../benchmark/docker.js';

const task: Task = { instance_id: 'django__django-11790', repo: 'django/django', base_commit: 'a'.repeat(40),
  problem_statement: 'Fix a field length bug', image: 'fake-image' };
const repo: Workspace = { shell: async () => 'source excerpt', patch: async () => 'diff', close: async () => {},
  exportSource: async () => {}, exportCurrentSource: async target => { await writeFile(path.join(target, 'a.py'), 'code A'); await writeFile(path.join(target, 'b.py'), 'code B'); } };
const finish = { role: 'assistant' as const, tool_calls: [{ id: 'finish', type: 'function' as const, function: { name: 'finish', arguments: '{}' } }] };
const accounting = () => new Ledger().snapshot();
const attempt = (arm: 'baseline' | 's1s'): Attempt => ({ instance_id: task.instance_id, arm, repetition: 0, order: 0,
  status: 'submitted', setupMs: 1, solveMs: 100, steps: 1, mcpCalls: 0, mcpErrors: 0, llm: accounting(), s1s: accounting() });

it('uses compatible Chat Completions parameters for GPT-6 Luna while preserving other model settings', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: finish }] })));
  vi.stubGlobal('fetch', fetchMock);
  try {
    for (const model of ['openai/gpt-6-luna', 'openai/gpt-4.1-mini']) {
      await apiComplete(paramsSchema.parse({ model }), 'test-key')([], [], new AbortController().signal);
      const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
      expect(body).toMatchObject({ model, seed: 42, max_tokens: 4096 });
      if (model === 'openai/gpt-6-luna') {
        expect(body).toHaveProperty('reasoning_effort', 'none');
        expect(body).not.toHaveProperty('temperature');
      } else {
        expect(body).toHaveProperty('temperature', 0);
        expect(body).not.toHaveProperty('reasoning_effort');
      }
    }
  } finally { vi.unstubAllGlobals(); }
});

it('keeps missing billing unknown and distinguishes explicit token price estimates from reported billing', () => {
  const ledger = new Ledger();
  ledger.add(pricedUsage(1000000, 1000, undefined, { inputUSDPerMillion: 0.12, outputUSDPerMillion: 0.8 }));
  ledger.add(pricedUsage(10, 2, 0));
  expect(ledger.snapshot()).toMatchObject({ costUSD: 0.1208, estimatedCostCalls: 1, missingCostCalls: 0 });
  ledger.add();
  expect(ledger.snapshot()).toMatchObject({ costUSD: null, knownCostUSD: 0.1208, missingCostCalls: 1, missingTokenCalls: 1 });
  expect(pricedUsage(NaN, 1, -1).costUSD).toBeNull();
});

it('rejects misspelled and invalid params, reads JSON files, and uses the low-cost model default', async () => {
  expect(paramsSchema.parse({}).model).toBe('qwen/qwen3-coder-next');
  for (const value of [{ limit: 51 }, { maxSteps: 0 }, { max_steps: 10 }, { s1s: { concurrency: 33 } }])
    expect(() => paramsSchema.parse(value)).toThrow();
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-bench-params-'));
  try {
    await writeFile(path.join(dir, 'params.json'), '{"limit":3,"model":"example/model"}');
    expect(await readParams(path.join(dir, 'params.json'))).toMatchObject({ limit: 3, model: 'example/model' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('shares the task prompt and solver settings, keeps identical initial context with optional MCP tools, and counts each provider batch once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-bench-agent-'));
  const observed: { system: string; user: string; tools: Tool[] }[] = [];
  let providerCalls = 0;
  const evaluate: Evaluate = async request => {
    providerCalls++;
    return { model: 'fake-jev', usage: { input_tokens: 20, output_tokens: 2, cost: 0.005 },
      answers: Object.fromEntries(Object.keys(request.questions).map(k => [k, { type: 'noul' as const, noul: 0.8 }])) };
  };
  try {
    const params = paramsSchema.parse({ maxSteps: 3, s1s: { batchSize: 1 } });
    for (const arm of ['baseline', 's1s'] as const) {
      let step = 0;
      const complete: Complete = async (messages, tools) => {
        if (arm === 's1s' && step > 0) {
          const evidence = JSON.parse(messages.at(-1)!.content!);
          expect(evidence.results).toHaveLength(2);
          expect(evidence).not.toHaveProperty('structuredContent');
          expect(evidence).not.toHaveProperty('content');
        }
        observed.push({ system: messages[0]!.content!, user: messages[1]!.content!, tools });
        for (const tool of tools.filter(t => t.function.name.startsWith('s1s_'))) {
          expect(Object.keys(tool.function.parameters.properties as object)).toEqual(tool.function.name === 's1s_search_code'
            ? ['question', 'root_folder', 'gitignore'] : tool.function.name === 's1s_search_file_contents'
            ? ['question', 'root_folder', 'gitignore', 'literal', 'files', 'topK'] : tool.function.name === 's1s_search_file_names'
            ? ['question', 'root_folder', 'gitignore', 'inspect'] : ['question', 'items', 'metrics']);
        }
        // Only a model-selected, offered MCP tool is dispatched.
        const message = arm === 's1s' && step++ === 0 ? { role: 'assistant' as const, tool_calls: [{ id: 'search', type: 'function' as const,
          function: { name: 's1s_search_file_contents', arguments: JSON.stringify({ question: `Is this file relevant to: ${task.problem_statement}?`, root_folder: '.' }) } }] } : finish;
        return { choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 5, cost: 0.01 } };
      };
      const result = await solve(task, arm, params, configSchema.parse({ batchSize: 1 }), repo, path.join(dir, `${arm}.jsonl`), complete, evaluate);
      expect(result.status).toBe('submitted');
      expect(result.mcpCalls).toBe(arm === 's1s' ? 1 : 0);
      expect(result.mcpErrors).toBe(0);
      expect(result.tools.finish).toMatchObject({ calls: 1, errors: 0 });
      if (arm === 's1s') expect(result.tools.s1s_search_file_contents).toMatchObject({ calls: 1, errors: 0 });
      if (arm === 's1s') {
        const searched = (await readFile(path.join(dir, 's1s.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
          .find(entry => entry.kind === 'tool');
        expect(searched.result.structuredContent.results.map((r: { path: string }) => r.path)).toEqual(['a.py', 'b.py']);
      }
      expect(result.llm.calls).toBe(arm === 's1s' ? 2 : 1);
      expect(result.s1s.calls).toBe(arm === 's1s' ? 1 : 0);
      expect(result.s1s.costUSD).toBe(arm === 's1s' ? 0.005 : 0);
      const summary = summarize(join([{ ...attempt(arm), ...result }], new Map())).find(s => s.arm === arm)!;
      expect(summary).toMatchObject({ solverCalls: arm === 's1s' ? 2 : 1, s1sProviderCalls: arm === 's1s' ? 1 : 0,
        totalApiCalls: arm === 's1s' ? 3 : 1, mcpCalls: arm === 's1s' ? 1 : 0 });
    }
    expect(providerCalls).toBe(1);
    expect(observed[1]!.system).toBe(observed[0]!.system);
    expect(observed[1]!.system).not.toContain('MCP usage context:');
    expect(observed[1]!.system).not.toContain('s1s_');
    expect(new Set(observed.filter(o => o.tools.some(t => t.function.name === 's1s_search_file_names')).map(o => o.system)).size).toBe(1);
    expect(new Set(observed.map(o => o.user)).size).toBe(1);
    expect(observed[0]!.tools.map(t => t.function.name)).toEqual(['bash', 'finish']);
    expect(observed[1]!.tools.some(t => t.function.name === 's1s_search_file_contents')).toBe(true);
    expect(observed[0]!.user).not.toContain('test_patch');
    expect(observed[0]!.user).not.toContain('FAIL_TO_PASS');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('retains a billable completion with malformed output and failed provider calls as unknown costs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-bench-errors-'));
  try {
    const result = await solve(task, 'baseline', paramsSchema.parse({}), configSchema.parse({}), repo,
      path.join(dir, 'malformed.jsonl'), async () => ({ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.1 } }));
    expect(result).toMatchObject({ status: 'solver_error', llm: { calls: 1, costUSD: 0.1 } });
    const failed = await solve(task, 'baseline', paramsSchema.parse({}), configSchema.parse({}), repo,
      path.join(dir, 'failed.jsonl'), async () => { throw new Error('HTTP 503'); });
    expect(failed).toMatchObject({ status: 'solver_error', llm: { calls: 1, costUSD: null, missingCostCalls: 1 } });
    expect(summarize(join([{ ...attempt('baseline'), ...failed }], new Map()))[0]).toMatchObject({
      solverCalls: 1, s1sProviderCalls: 0, totalApiCalls: 1, costUSD: null,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('counts all attempts in the resolve denominator and leaves an incomplete grade as N/A', () => {
  const a = attempt('baseline'), b = { ...attempt('s1s'), status: 'setup_error' };
  const grades = new Map([['baseline:0:' + task.instance_id, { instance_id: task.instance_id, resolved: true, status: 'resolved', gradingMs: 5 }],
    ['s1s:0:' + task.instance_id, { instance_id: task.instance_id, resolved: false, status: 'empty_patch', gradingMs: 0 }]]);
  const summary = summarize(join([a, b], grades));
  expect(summary[0]).toMatchObject({ attempts: 1, resolveRate: 1 });
  expect(summary[1]).toMatchObject({ attempts: 1, resolveRate: 0, solverErrors: 1 });
  expect(summarize(join([a, b], new Map()))[0]!.resolveRate).toBeNull();
  const pending = summarize(join([{ ...a, status: 'pending' }], new Map()))[0]!;
  expect(pending.costUSD).toBeNull();
  expect(pending.meanSolveSeconds).toBeNull();
});

it('runs the paired dry pipeline, alternates order, labels simulated results, and refuses to overwrite attempts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-bench-pipeline-'));
  try {
    const params = paramsSchema.parse({ dryRun: true, limit: 2, output: dir });
    await run(params);
    const attempts: Attempt[] = JSON.parse(await readFile(path.join(dir, 'attempts.json'), 'utf8'));
    expect(attempts.map(a => a.arm)).toEqual(['baseline', 's1s', 's1s', 'baseline']);
    expect(attempts.every(a => a.status === 'submitted')).toBe(true);
    const result = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8'));
    expect(result.pairs).toHaveLength(2);
    expect(result.summary).toMatchObject([
      { solverCalls: 4, s1sProviderCalls: 0, totalApiCalls: 4, mcpCalls: 0 },
      { solverCalls: 4, s1sProviderCalls: 0, totalApiCalls: 4, mcpCalls: 0 },
    ]);
    const csv = (await readFile(path.join(dir, 'results.csv'), 'utf8')).trim().split('\n').map(line => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1]!.replaceAll('""', '"')));
    const headers = csv[0]!;
    expect(csv.slice(1).map(row => [row[headers.indexOf('arm')], row[headers.indexOf('solverCalls')], row[headers.indexOf('s1sProviderCalls')], row[headers.indexOf('totalApiCalls')], row[headers.indexOf('mcpCalls')]])).toEqual([
      ['baseline', '2', '0', '2', '0'], ['s1s', '2', '0', '2', '0'],
      ['s1s', '2', '0', '2', '0'], ['baseline', '2', '0', '2', '0'],
    ]);
    expect(await readFile(path.join(dir, 'results.md'), 'utf8')).toContain('| s1s | 4 | 0 | 4 | 0 | 0 |');
    expect(result.summary.map((s: { mcpUsedAttempts: number }) => s.mcpUsedAttempts)).toEqual([0, 0]);
    expect(await readFile(path.join(dir, 'results.md'), 'utf8')).toContain('DRY RUN');
    expect(await readFile(path.join(dir, 'results.csv'), 'utf8')).toContain('"solverCostUSD","s1sCostUSD"');
    await expect(run(params)).rejects.toThrow('already contains attempts');
    await run(paramsSchema.parse({ mode: 'report', output: dir }));
    expect(await readFile(path.join(dir, 'results.md'), 'utf8')).toContain('| baseline | 4 | 0 | 4 | 0 | 0 |');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
