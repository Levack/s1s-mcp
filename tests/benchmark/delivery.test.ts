import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertToolsOnly, mcpEvidence, solve, type Message, type Tool } from '../../benchmark/agent.js';
import { ExperimentBudget } from '../../benchmark/experiments/budget.js';
import { configSchema } from '../../src/config.js';
import { paramsSchema } from '../../benchmark/params.js';

it('passes MCP evidence once while preserving tool errors and unstructured responses', () => {
  const data = { results: [{ path: 'a.py', probability: 0.9 }] };
  expect(mcpEvidence({ structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] })).toEqual(data);
  expect(mcpEvidence({ isError: true, content: [{ type: 'text', text: 'Scope too broad' }] }))
    .toEqual({ isError: true, evidence: { message: 'Scope too broad' } });
  expect(mcpEvidence({ isError: true, structuredContent: { limitReached: true } })).toEqual({ isError: true, evidence: { limitReached: true } });
});

it('rejects all historical orchestration overrides', () => {
  for (const value of [{ instructions: 'Use MCP first' }, { prefetch: { name: 's1s_find_files', arguments: {} } },
    { fixedArguments: {} }, { toolNames: [] }, { compactSchemas: true }, { sourceFiles: ['**/*.py'] }, { rawMcpEnvelope: false }]) {
    expect(() => assertToolsOnly(value)).toThrow('Tools-only');
  }
  expect(() => assertToolsOnly()).not.toThrow();
});

it('adds only native MCP tools: identical first messages, no automatic export or evaluation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-tools-only-'));
  const initial: { messages: Message[]; tools: Tool[] }[] = [];
  let exports = 0, evaluations = 0;
  try {
    for (const arm of ['baseline', 's1s'] as const) {
      const result = await solve({ instance_id: 'test', repo: 'test/repo', base_commit: 'a'.repeat(40), problem_statement: 'Fix the issue', image: 'fake' },
        arm, paramsSchema.parse({ maxSteps: 1 }), configSchema.parse({}), {
          shell: async () => '', patch: async () => '', close: async () => {}, exportSource: async () => { throw new Error('No base snapshot'); },
          exportCurrentSource: async () => { exports++; },
        }, path.join(dir, `${arm}.jsonl`), async (messages, tools) => {
          initial.push(structuredClone({ messages, tools }));
          return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'done', type: 'function', function: { name: 'finish', arguments: '{}' } }] } }] };
        }, async () => { evaluations++; throw new Error('No unsolicited evaluation'); });
      expect(result).toMatchObject({ status: 'submitted', mcpCalls: 0, sourceExportMs: 0 });
    }
    expect(initial[1]!.messages).toEqual(initial[0]!.messages);
    expect(initial[0]!.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(initial[1]!.tools.filter(tool => !tool.function.name.startsWith('s1s_'))).toEqual(initial[0]!.tools);
    expect(initial[1]!.tools.filter(tool => tool.function.name.startsWith('s1s_'))).toHaveLength(5);
    expect(exports).toBe(0); expect(evaluations).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('preserves model arguments and raw traces, delivers evidence once, and refreshes current edits and deletions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-current-tree-'));
  let step = 0, exports = 0;
  try {
    const result = await solve({ instance_id: 'test', repo: 'test/repo', base_commit: 'a'.repeat(40), problem_statement: 'Fix the issue', image: 'fake' },
      's1s', paramsSchema.parse({ maxSteps: 3 }), configSchema.parse({}), {
        shell: async () => '', patch: async () => '', close: async () => {}, exportSource: async () => { throw new Error('No base snapshot'); },
        exportCurrentSource: async target => {
          exports++;
          await writeFile(path.join(target, 'auth.py'), exports === 1 ? 'original' : 'edited');
          if (exports === 1) await writeFile(path.join(target, 'deleted.py'), 'old');
        },
      }, path.join(dir, 'trace.jsonl'), async messages => {
        if (step) {
          const evidence = JSON.parse(messages.at(-1)!.content!);
          expect(evidence).not.toHaveProperty('content');
          expect(evidence).not.toHaveProperty('structuredContent');
          expect(evidence.judged).toBe(step === 1 ? 2 : 1);
        }
        const name = step++ < 2 ? 's1s_search_file_contents' : 'finish';
        return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: String(step), type: 'function', function: { name,
          arguments: name === 'finish' ? '{}' : JSON.stringify({ question: 'Find code', root_folder: '.', gitignore: '*.txt' }) } }] } }] };
      }, async request => {
        expect(JSON.stringify(request.state)).toContain(exports === 1 ? 'original' : 'edited');
        if (exports === 2) expect(JSON.stringify(request.state)).not.toContain('deleted.py');
        return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
          answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.5 }])) };
      });
    expect(result).toMatchObject({ status: 'submitted', mcpCalls: 2, mcpErrors: 0 });
    expect(exports).toBe(2);
    const trace = (await readFile(path.join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const record of trace.filter(record => record.name === 's1s_search_file_contents')) {
      expect(record.effectiveArguments).toEqual(JSON.parse(record.arguments));
      expect(record.origin).toBeUndefined();
      expect(JSON.parse(record.result.content[0].text)).toEqual(record.result.structuredContent);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('persists billing, rejects unaffordable requests, and stops after unknown billing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-budget-'));
  try {
    const file = path.join(dir, 'budget.json');
    const budget = await ExperimentBudget.open(file, 1);
    let calls = 0;
    await budget.call('known', 0.6, async () => { calls++; return 0.4; }, n => n);
    await expect(budget.call('too much', 0.7, async () => { calls++; return 0.1; }, n => n)).rejects.toThrow('budget');
    await budget.call('unknown', 0.2, async () => { calls++; return null; }, n => n);
    expect(calls).toBe(2);
    expect(budget.stopped).toBe(true);
    expect((await ExperimentBudget.open(file, 1)).stopped).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8')).receipts).toHaveLength(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(['max_tokens_exceeded', 'invalid_union criteria expected string received null'])('retains the full budget liability when covering known input rejection: %s', async message => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-rejected-budget-'));
  try {
    const file = path.join(dir, 'budget.json');
    const budget = await ExperimentBudget.open(file, 1);
    await expect(budget.call('rejected', 0.6, async () => {
      throw Object.assign(new Error(message), { status: 400 });
    }, () => 0)).rejects.toThrow(message);
    expect(budget.stopped).toBe(true);
    await budget.coverRejectedRequest('rejected');
    const reopened = await ExperimentBudget.open(file, 1);
    expect(reopened.stopped).toBe(false);
    expect(reopened.spentUSD).toBe(0.6);
    await expect(reopened.call('too much', 0.5, async () => 0.1, n => n)).rejects.toThrow('budget');
    const receipt = JSON.parse(await readFile(file, 'utf8')).receipts[0];
    expect(receipt).toMatchObject({ costUSD: null, reservedUSD: 0.6, coveredRejection: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
