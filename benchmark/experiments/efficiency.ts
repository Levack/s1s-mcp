import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apiComplete, solve, type Complete } from '../agent.js';
import { openRouterKey, benchmarkConfig } from '../auth.js';
import { paramsSchema } from '../params.js';
import { workspace, type Task } from '../docker.js';
import { gradeLocalization } from '../localization.js';
import { providerEvaluate, type Evaluate } from '../../src/system-one.js';
import { ExperimentBudget } from './budget.js';

const root = path.resolve('benchmark/results/efficiency-2026-10-12');
const stage = process.argv[2];
if (!stage || !/^[a-z0-9-]+$/.test(stage)) throw new Error('Supply a fresh stage name');
const output = path.join(root, stage);
const source = path.resolve('benchmark/results/2026-10-07T20-09-09.317Z');
const allTasks: Task[] = JSON.parse(await readFile(path.join(source, 'tasks.json'), 'utf8'));
const indices = (process.env.EXPERIMENT_TASKS ?? '2,5,9').split(',').map(n => Number(n) - 1);
const tasks = indices.map(index => { const task = allTasks[index]; if (!task) throw new Error('Invalid index'); return task; });
const arms = (process.env.EXPERIMENT_ARMS ?? 'baseline,s1s').split(',') as ('baseline' | 's1s')[];
if (arms.some(a => a !== 'baseline' && a !== 's1s')) throw new Error('Invalid arm');
const repetitions = Number(process.env.EXPERIMENT_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('Invalid repetitions');
const params = paramsSchema.parse({ bench: 'loc-bench', model: process.env.EXPERIMENT_MODEL ?? 'openai/gpt-6-luna', maxSteps: 25,
  maxOutputTokens: 2048, timeoutSeconds: 300, seed: 42, commandTimeoutSeconds: 45 });
const key = await openRouterKey(params, { interactive: false, login: async () => { throw new Error('Login required'); } });
const config = await benchmarkConfig(params, key);
config.maxBatchBytes = 48000;
await mkdir(root, { recursive: true });
await mkdir(output);
await mkdir(path.join(output, 'traces'));
// New authorization: additional $5; preserve the previous experiment ledger untouched.
const budget = await ExperimentBudget.open(path.join(root, 'budget.json'), 4.5);
const catalog = await fetch('https://openrouter.ai/api/v1/models');
if (!catalog.ok) throw new Error('Cannot verify pricing');
const models = await catalog.json() as { data: { id: string; pricing: Record<string, string> }[] };
const model = models.data.find(m => m.id === params.model);
if (!model) throw new Error('Model absent');
const prices = { input: Number(model.pricing.prompt), output: Number(model.pricing.completion), request: Number(model.pricing.request ?? 0) };
if (Object.values(prices).some(p => !Number.isFinite(p) || p < 0)) throw new Error('Unknown pricing');
for (const file of ['src/code-search.ts', 'src/folder-search.ts', 'src/literal-search.ts', 'src/server.ts', 'src/find.ts', 'src/search.ts', 'src/screen.ts', 'src/files.ts', 'benchmark/agent.ts', 'benchmark/docker.ts', 'benchmark/experiments/efficiency.ts']) {
  await writeFile(path.join(output, file.replaceAll('/', '_') + '.snapshot'), await readFile(file));
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ params, arms, repetitions, taskNumbers: indices.map(i => i + 1), source,
  pricing: model.pricing, maxBatchBytes: config.maxBatchBytes, authorizationUSD: 5, stopUSD: 4.5,
  design: 'Tools-only localization comparison. Identical initial messages and common tools; optional MCP tools only. No prefetch, forced tool calls or gold feedback. Gold read after submission. Rotated condition order. Source export included in solve time.' }, null, 2));
let baseComplete = apiComplete(params, key);
const complete: Complete = (messages, tools, signal) => {
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }));
  if (bytes > 400000) throw new Error('Input cap');
  const reserve = Math.max(0.02, 2 * ((bytes + 4096) * prices.input + params.maxOutputTokens * prices.output + prices.request));
  return budget.call(`${stage}:solver`, reserve, () => baseComplete(messages, tools, signal), r => r.usage?.cost);
};
const baseEvaluate = providerEvaluate(config);
const evaluate: Evaluate = (request, signal) => {
  if (Buffer.byteLength(JSON.stringify(request)) > config.maxBatchBytes) throw new Error('Jev request cap');
  return budget.call(`${stage}:jev`, 0.15, () => baseEvaluate(request, signal), r => (r.usage as { cost?: number }).cost);
};
const rows: Record<string, unknown>[] = [];
for (let repetition = 0; repetition < repetitions; repetition++) {
  baseComplete = apiComplete({ ...params, seed: 42 + repetition }, key);
  for (const [index, task] of tasks.entries()) {
    const shift = (index + repetition) % arms.length;
    for (const arm of [...arms.slice(shift), ...arms.slice(0, shift)]) {
      if (budget.stopped) throw new Error('Budget stopped');
      const label = `${task.instance_id}-${repetition}-${arm}`;
      console.log(`START ${label} spent=$${budget.spentUSD.toFixed(5)}`);
      const repo = await workspace(task, params);
      try {
        const result = await solve(task, arm, { ...params, seed: 42 + repetition }, config, repo,
          path.join(output, 'traces', `${label}.jsonl`), complete, evaluate);
        const gold = (JSON.parse(await readFile(path.join(source, 'grading-dataset.json'), 'utf8')) as { instance_id: string; edit_functions: string[] }[]);
        const metrics = gradeLocalization(gold.find(g => g.instance_id === task.instance_id)!.edit_functions,
          result.status === 'submitted' ? result.localization : undefined);
        rows.push({ instance_id: task.instance_id, repetition, arm, ...result, metrics });
        await writeFile(path.join(output, 'results.json'), JSON.stringify(rows, null, 2));
        console.log(`DONE ${label} ${result.status} file@5=${metrics.fileAcc5} func@10=${metrics.functionAcc10} seconds=${(result.solveMs / 1000).toFixed(2)} llm=${result.llm.calls} jev=${result.s1s.calls} mcp=${result.mcpCalls} spent=$${budget.spentUSD.toFixed(5)}`);
      } finally { await repo.close(); }
    }
  }
}
