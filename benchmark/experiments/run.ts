import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { apiComplete, solve, type Complete } from '../agent.js';
import { openRouterKey, benchmarkConfig } from '../auth.js';
import { paramsSchema } from '../params.js';
import { workspace, type Task } from '../docker.js';
import { gradeLocalization } from '../localization.js';
import { providerEvaluate, type Evaluate } from '../../src/system-one.js';
import { ExperimentBudget } from './budget.js';
import { variants } from './variants.js';

const root = path.resolve('benchmark/results/delivery-experiments-2026-10-09');
const stage = process.argv[2] ?? 'pilot';
if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid stage');
const output = path.join(root, stage);
const selected = (process.env.EXPERIMENT_VARIANTS ?? 'baseline,procedural_raw,procedural_clean,concept_clean,concept_focused').split(',');
const conditions = selected.map(name => { const v = variants.find(v => v.name === name); if (!v) throw new Error(`Unknown variant: ${name}`); return v; });
const indices = (process.env.EXPERIMENT_TASKS ?? '1,2,5').split(',').map(n => Number(n) - 1);
const repetitions = Number(process.env.EXPERIMENT_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('Invalid repetitions');
const source = path.resolve('benchmark/results/2026-10-07T20-09-09.317Z');
const allTasks: Task[] = JSON.parse(await readFile(path.join(source, 'tasks.json'), 'utf8'));
const tasks = indices.map(index => { const task = allTasks[index]; if (!task) throw new Error('Invalid task index'); return task; });
const params = paramsSchema.parse({ bench: 'loc-bench', model: process.env.EXPERIMENT_MODEL ?? 'openai/gpt-6-luna',
  maxSteps: Number(process.env.EXPERIMENT_MAX_STEPS ?? 25), maxOutputTokens: Number(process.env.EXPERIMENT_MAX_OUTPUT_TOKENS ?? 2048), timeoutSeconds: 300, seed: 42, commandTimeoutSeconds: 45 });
const key = await openRouterKey(params, { interactive: false, login: async () => { throw new Error('Login required'); } });
const config = await benchmarkConfig(params, key);
await mkdir(root, { recursive: true });
await mkdir(output); // Never overwrite paid experiment attempts.
await mkdir(path.join(output, 'traces'));
const budget = await ExperimentBudget.open(path.join(root, 'budget.json'));
const metadataResponse = await fetch('https://openrouter.ai/api/v1/models');
if (!metadataResponse.ok) throw new Error('Could not verify solver pricing');
const models = await metadataResponse.json() as { data: { id: string; pricing: Record<string, string>; supported_parameters: string[] }[] };
const model = models.data.find(m => m.id === params.model);
if (!model) throw new Error('Solver absent from current model catalog');
const prices = { input: Number(model.pricing.prompt), output: Number(model.pricing.completion), request: Number(model.pricing.request ?? 0) };
if (Object.values(prices).some(p => !Number.isFinite(p) || p < 0)) throw new Error('Unknown pricing');
const requestPolicy = { temperature: model.supported_parameters.includes('temperature'), reasoningEffort: process.env.EXPERIMENT_REASONING };
if (requestPolicy.reasoningEffort && !model.supported_parameters.includes('reasoning_effort')) throw new Error('Unsupported reasoning setting');
const sourceHashes: Record<string, string> = {};
for (const file of ['benchmark/agent.ts', 'benchmark/experiments/variants.ts', 'src/find.ts', 'src/search.ts', 'src/screen.ts', 'src/server.ts', 'src/search-guide.ts']) {
  const data = await readFile(file);
  sourceHashes[file] = createHash('sha256').update(data).digest('hex');
  const snapshot = path.join(output, 'source', file);
  await mkdir(path.dirname(snapshot), { recursive: true });
  await writeFile(snapshot, data);
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ params, conditions, source, instances: tasks.map(t => t.instance_id), repetitions,
  sourceHashes, requestPolicy, pricing: model.pricing, budgetLimitUSD: 4, userLimitUSD: 5, selection: 'Preselected source task numbers; gold used only after submissions.' }, null, 2));
const baseComplete = apiComplete(params, key, requestPolicy);
const complete: Complete = async (messages, tools, signal) => {
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }));
  if (bytes > 400000) throw new Error('Experiment input cap reached');
  // UTF-8 bytes conservatively bound input tokens; reserve extra overhead and routing margin.
  const reservation = Math.max(0.02, 2 * ((bytes + 4096) * prices.input + params.maxOutputTokens * prices.output + prices.request));
  return budget.call(`${stage}:solver:${params.model}`, reservation, () => baseComplete(messages, tools, signal), r => r.usage?.cost);
};
const baseEvaluate = providerEvaluate(config);
const evaluate: Evaluate = (request, signal) => {
  if (Buffer.byteLength(JSON.stringify(request)) > 48000) throw new Error('Experiment Jev request cap reached');
  return budget.call(`${stage}:jev`, 0.05, () => baseEvaluate(request, signal), r => (r.usage as { cost?: number }).cost);
};
const results: Record<string, unknown>[] = [];
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const [index, task] of tasks.entries()) {
    const shift = (index + repetition) % conditions.length;
    const order = [...conditions.slice(shift), ...conditions.slice(0, shift)];
    for (const variant of order) {
      if (budget.stopped) throw new Error(`Budget stopped at $${budget.spentUSD.toFixed(4)}`);
      const label = `${task.instance_id}-${repetition}-${variant.name}`;
      console.log(`START ${label} spent=$${budget.spentUSD.toFixed(4)}`);
      const repo = await workspace(task, params);
      const started = performance.now();
      try {
        const result = await solve(task, variant.arm, { ...params, seed: 42 + repetition }, config, repo,
          path.join(output, 'traces', `${label}.jsonl`), complete, evaluate, variant.delivery);
        // Read gold only after the solver has finished; it never enters its workspace or messages.
        const gold = (JSON.parse(await readFile(path.join(source, 'grading-dataset.json'), 'utf8')) as { instance_id: string; edit_functions: string[] }[])
          .find(g => g.instance_id === task.instance_id)!;
        const metrics = gradeLocalization(gold.edit_functions, result.status === 'submitted' ? result.localization : undefined);
        results.push({ instance_id: task.instance_id, repetition, variant: variant.name, model: params.model, ...result,
          metrics, wallSeconds: (performance.now() - started) / 1000 });
        await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        console.log(`DONE ${label} ${result.status} file@5=${metrics.fileAcc5} function@10=${metrics.functionAcc10} seconds=${(result.solveMs / 1000).toFixed(1)} llm=${result.llm.calls} jev=${result.s1s.calls} mcp=${result.mcpCalls} total=$${budget.spentUSD.toFixed(4)}`);
      } finally { await repo.close(); }
    }
  }
}
console.log(`COMPLETE ${output}; cumulative cost $${budget.spentUSD.toFixed(4)}`);
