import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { SystemOne, providerEvaluate } from '../../src/system-one.js';
import { apiComplete, mcpEvidence, type Tool } from '../agent.js';
import { openRouterKey, benchmarkConfig } from '../auth.js';
import { paramsSchema } from '../params.js';
import { ExperimentBudget } from './budget.js';

const root = path.resolve('benchmark/results/delivery-experiments-2026-10-09');
const stage = process.argv[2] ?? 'filename-micro';
if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid stage');
const output = path.join(root, stage);
const source = path.resolve('benchmark/results/2026-10-07T20-09-09.317Z');
const tasks = JSON.parse(await readFile(path.join(source, 'tasks.json'), 'utf8')) as { instance_id: string; problem_statement: string }[];
const methods = ['jev_mcp', 'openai/gpt-6-luna', 'openai/gpt-4.1-mini'];
const params = paramsSchema.parse({ model: 'openai/gpt-6-luna', maxOutputTokens: 2048,
  s1s: { concurrency: Number(process.env.EXPERIMENT_S1S_CONCURRENCY ?? 4) } });
const key = await openRouterKey(params, { interactive: false, login: async () => { throw new Error('Login required'); } });
const config = await benchmarkConfig(params, key);
if (process.env.EXPERIMENT_MAX_BATCH_BYTES) config.maxBatchBytes = Number(process.env.EXPERIMENT_MAX_BATCH_BYTES);
const budget = await ExperimentBudget.open(path.join(root, 'budget.json'));
await mkdir(output);
await writeFile(path.join(output, 'find.ts.snapshot'), await readFile('src/find.ts'));
const rows: { instance_id: string; repetition: number; method: string; seconds: number; costUSD: number; fileAcc5: boolean; fileAcc10: boolean; files: string[]; errors: number; apiCalls: number }[] = [];
const tool: Tool = { type: 'function', function: { name: 'submit_ranked_files', description: 'Submit the top ten filenames to inspect, most useful first.',
  parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, maxItems: 10 } }, required: ['files'], additionalProperties: false } } };
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ methods, repetitions: 5, taskNumbers: [2, 5, 9], s1s: { ...params.s1s, maxBatchBytes: config.maxBatchBytes },
  design: 'Controlled filename-ranking microbenchmark. Identical complete filename inventories from prior MCP traces and original issue text; no file contents. Real MCP find_files handler versus one generative LLM request returning top ten paths. Inventory construction and transport initialization excluded, MCP discovery included. No coding or function localization claims.' }, null, 2));
for (const index of [1, 4, 8]) {
  const task = tasks[index]!;
  const original = (await readFile(path.join(root, 'all-filenames/traces', `${task.instance_id}-0-all_names.jsonl`), 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const names = [...new Set<string>(original.filter(e => e.kind === 's1s_provider' && e.request.state.task?.startsWith('Each output key'))
    .flatMap(e => Object.keys(e.request.questions)))].sort();
  if (!names.length) throw new Error('No captured filename inventory');
  const inventory = await mkdtemp(path.join(tmpdir(), 's1s-filename-inventory-'));
  try {
    for (const name of names) {
      if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Invalid inventory filename');
      await mkdir(path.dirname(path.join(inventory, name)), { recursive: true });
      await writeFile(path.join(inventory, name), '');
    }
    await writeFile(path.join(output, `${task.instance_id}-inventory.json`), JSON.stringify(names));
    for (let repetition = 0; repetition < 5; repetition++) {
      const shift = repetition % methods.length;
      for (const method of [...methods.slice(shift), ...methods.slice(0, shift)]) {
        if (budget.stopped) throw new Error('Experiment budget stopped');
        const trace: unknown[] = [];
        let costUSD = 0, errors = 0, apiCalls = 0, files: string[] = [], seconds = 0;
        if (method === 'jev_mcp') {
          const evaluate = providerEvaluate(config);
          const server = createServer({ ...config, roots: [inventory] }, new SystemOne(config, async (request, signal) => {
            const result = await budget.call(`${stage}:jev`, 0.05, () => evaluate(request, signal), r => (r.usage as { cost?: number }).cost);
            costUSD += (result.usage as { cost?: number }).cost ?? 0;
            apiCalls++;
            trace.push({ request, response: result });
            return result;
          }));
          const client = new Client({ name: 'filename-micro', version: '1' });
          const [ct, st] = InMemoryTransport.createLinkedPair();
          await Promise.all([client.connect(ct), server.connect(st)]);
          try {
            const started = performance.now();
            const result = mcpEvidence(await client.callTool({ name: 'find_files', arguments: { question: task.problem_statement, files: ['**/*.py'], topK: 10, inspect: false } })) as { matched?: number; results?: { path: string }[]; errors?: unknown[]; isError?: boolean };
            if (result.matched !== names.length) throw new Error('MCP and LLM candidate inventories differ');
            seconds = (performance.now() - started) / 1000;
            files = result.results?.map(r => r.path) ?? [];
            errors = result.errors?.length ?? (result.isError ? 1 : 0);
            trace.push({ mcpResult: result });
          } finally { await client.close(); await server.close(); }
        } else {
          const complete = apiComplete({ ...params, model: method, seed: 42 + repetition }, key);
          const messages = [
            { role: 'system' as const, content: 'Rank the supplied filenames by usefulness to inspect for the issue, including relevant implementation and dependencies. Use filenames only; no file contents are available. Return up to ten paths, most useful first, by calling submit_ranked_files. Do not invent paths.' },
            { role: 'user' as const, content: JSON.stringify({ question: task.problem_statement, paths: names }) },
          ];
          if (Buffer.byteLength(JSON.stringify({ messages, tool })) > 200000) throw new Error('Microbenchmark request cap');
          const started = performance.now();
          const response = await budget.call(`${stage}:${method}`, 0.25,
            () => complete(messages, [tool], AbortSignal.timeout(120000)), r => r.usage?.cost);
          seconds = (performance.now() - started) / 1000;
          costUSD = response.usage?.cost ?? 0;
          apiCalls = 1;
          trace.push({ request: { messages, tools: [tool] }, response });
          try {
            const call = response.choices?.[0]?.message.tool_calls?.find(call => call.function.name === 'submit_ranked_files');
            const parsed = JSON.parse(call?.function.arguments ?? '{}').files;
            if (!Array.isArray(parsed) || parsed.length > 10 || parsed.some(p => typeof p !== 'string' || !names.includes(p))) throw new Error('Invalid prediction');
            files = parsed;
          } catch { errors = 1; }
        }
        const gold = (JSON.parse(await readFile(path.join(source, 'grading-dataset.json'), 'utf8')) as { instance_id: string; edit_functions: string[] }[])
          .find(g => g.instance_id === task.instance_id)!;
        const expected = [...new Set(gold.edit_functions.map(f => f.split(':')[0]!))];
        const unique = [...new Set(files)];
        const row = { instance_id: task.instance_id, repetition, method, seconds, costUSD,
          fileAcc5: errors === 0 && expected.every(p => unique.slice(0, 5).includes(p)),
          fileAcc10: errors === 0 && expected.every(p => unique.slice(0, 10).includes(p)), files, errors, apiCalls };
        rows.push(row);
        await writeFile(path.join(output, `${task.instance_id}-${repetition}-${method.replaceAll('/', '_')}.json`), JSON.stringify(trace));
        await writeFile(path.join(output, 'micro-results.json'), JSON.stringify(rows, null, 2));
        console.log(`${task.instance_id} repeat=${repetition + 1} ${method}: ${seconds.toFixed(3)}s file@5=${row.fileAcc5} calls=${apiCalls} spent=$${budget.spentUSD.toFixed(4)}`);
      }
    }
  } finally { await rm(inventory, { recursive: true, force: true }); }
}
const report = ['# Controlled filename ranking', '',
  'Same stored filename inventory and original issue for every method. Real MCP filename filtering versus one generative LLM call returning the top ten paths. Five order-rotated repetitions per task. This measures filename triage only, not code understanding, function localization or end-to-end fixing.', '',
  '| Method | Attempts | File@5 | File@10 | Mean seconds | API USD |', '|---|---:|---:|---:|---:|---:|'];
for (const method of methods) {
  const selected = rows.filter(r => r.method === method);
  report.push(`| ${method} | ${selected.length} | ${selected.filter(r => r.fileAcc5).length}/${selected.length} | ${selected.filter(r => r.fileAcc10).length}/${selected.length} | ${(selected.reduce((n, r) => n + r.seconds, 0) / selected.length).toFixed(3)} | ${selected.reduce((n, r) => n + r.costUSD, 0).toFixed(5)} |`);
}
await writeFile(path.join(output, 'comparison.md'), report.join('\n') + '\n');
