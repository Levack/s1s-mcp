import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../cli.js';
import { paramsSchema } from '../params.js';
import { apiComplete, type Complete } from '../agent.js';
import { openRouterKey, benchmarkConfig } from '../auth.js';
import { providerEvaluate, type Evaluate } from '../../src/system-one.js';
import { ExperimentBudget } from './budget.js';

const root = path.resolve('benchmark/results/delivery-experiments-2026-10-09');
const previous = path.resolve('benchmark/results/2026-10-08T09-20-27.974Z');
const selection = JSON.parse(await readFile(path.join(previous, 'dataset.json'), 'utf8'));
const stage = process.argv[2] ?? 'swe-tools-only';
if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid stage');
const output = path.join(root, stage);
const params = paramsSchema.parse({ ...JSON.parse(await readFile(path.join(previous, 'params.json'), 'utf8')),
  revision: selection.revision, range: '1-3', output });
const key = await openRouterKey(params, { interactive: false, login: async () => { throw new Error('Login required'); } });
const config = await benchmarkConfig(params, key);
const budget = await ExperimentBudget.open(path.join(root, 'budget.json'));
const baseComplete = apiComplete(params, key);
const complete: Complete = (messages, tools, signal) => {
  if (Buffer.byteLength(JSON.stringify({ messages, tools })) > 400000) throw new Error('Experiment input cap');
  return budget.call(`${stage}:solver`, 0.10, () => baseComplete(messages, tools, signal), r => r.usage?.cost);
};
const baseEvaluate = providerEvaluate(config);
const evaluate: Evaluate = (request, signal) => {
  if (Buffer.byteLength(JSON.stringify(request)) > config.maxBatchBytes) throw new Error('Experiment Jev request cap');
  return budget.call(`${stage}:jev`, 0.15, () => baseEvaluate(request, signal), r => (r.usage as { cost?: number }).cost);
};
if (process.env.EXPERIMENT_VARIANT) throw new Error('Delivery variants are forbidden in tools-only comparisons');
await mkdir(output);
const manifest = { comparison: 'tools-only', referenceRun: previous, maxBatchBytes: config.maxBatchBytes,
  interpretation: 'Three-task official SWE-bench smoke test with identical initial messages and optional MCP tools only. All retrieval time and API charges included. Not sufficient for a general speed or correctness claim.' };
await writeFile(path.join(output, 'experiment.json'), JSON.stringify(manifest, null, 2));
for (const file of ['src/find.ts', 'src/search.ts', 'src/files.ts', 'benchmark/agent.ts', 'benchmark/docker.ts', 'benchmark/experiments/variants.ts']) {
  await writeFile(path.join(output, file.replaceAll('/', '_') + '.snapshot'), await readFile(file));
}
await run(params, { complete, evaluate });
await writeFile(path.join(output, 'experiment.json'), JSON.stringify({ ...manifest,
  cumulativeReportedOrReservedUSD: budget.spentUSD }, null, 2));
console.log(`Shared experiment spend: $${budget.spentUSD.toFixed(6)}`);
