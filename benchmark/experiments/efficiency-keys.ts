import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import type { SystemOneRequest, Questions } from '@typesafe-ai/sdk';
import { providerEvaluate } from '../../src/system-one.js';
import { openRouterKey, benchmarkConfig } from '../auth.js';
import { paramsSchema } from '../params.js';
import { ExperimentBudget } from './budget.js';

const root = path.resolve('benchmark/results/efficiency-2026-10-12');
const output = path.join(root, 'filename-keys');
await mkdir(output);
const params = paramsSchema.parse({ model: 'openai/gpt-6-luna' });
const key = await openRouterKey(params, { interactive: false, login: async () => { throw new Error('Login required'); } });
const config = await benchmarkConfig(params, key);
const evaluate = providerEvaluate(config);
const budget = await ExperimentBudget.open(path.join(root, 'budget.json'), 4.5);
const taskIds = ['AzureAD__microsoft-authentication-library-for-python-407', 'BerriAI__litellm-6563', 'Chainlit__chainlit-1534'];
const methods = ['path_keys', 'short_keys', 'short_packed'] as const;
const rows: Record<string, unknown>[] = [];
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ taskIds, methods, repetitions: 3,
  design: 'Replay identical captured filename inventories and query text. path_keys and short_keys preserve batching; short_packed also repacks to 48 KB. Provider requests only, excluding filesystem/MCP setup. Four concurrent batches per condition; rotated sequential conditions. Gold read only after predictions. This isolates provider encoding, not end-to-end agent behavior.' }, null, 2));
await writeFile(path.join(output, 'runner.ts.snapshot'), await readFile('benchmark/experiments/efficiency-keys.ts'));
for (const taskId of taskIds) {
  const events = (await readFile(path.join(root, 'combined/traces', `${taskId}-0-s1s.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const end = events.findIndex(e => e.kind === 'tool' && e.name === 's1s_search_file_names');
  const requests: SystemOneRequest[] = events.slice(0, end).filter(e => e.kind === 's1s_provider' && e.request.state.task).map(e => e.request);
  if (!requests.length) throw new Error('Missing captured name request');
  const candidates = requests.flatMap(r => Object.entries(r.questions));
  if (new Set(candidates.map(([name]) => name)).size !== candidates.length) throw new Error('Duplicate candidate');
  for (let repetition = 0; repetition < 3; repetition++) {
    const order = [...methods.slice(repetition), ...methods.slice(0, repetition)];
    for (const method of order) {
      type Batch = { request: SystemOneRequest; keys: Map<string, string> };
      const batches: Batch[] = [];
      const build = (items: typeof candidates): Batch => {
        const keys = new Map(items.map(([name], i) => [method === 'path_keys' ? name : `p${i}`, name]));
        return { request: { ...requests[0]!, questions: Object.fromEntries(items.map(([name, q], i) => [method === 'path_keys' ? name : `p${i}`, q])) as Questions }, keys };
      };
      if (method === 'short_packed') {
        let group: typeof candidates = [];
        for (const candidate of candidates) {
          if (group.length && Buffer.byteLength(JSON.stringify(build([...group, candidate]).request)) > 48000) {
            batches.push(build(group)); group = [];
          }
          group.push(candidate);
        }
        if (group.length) batches.push(build(group));
      } else for (const request of requests) batches.push(build(Object.entries(request.questions)));
      let costUSD = 0, inputTokens = 0, outputTokens = 0;
      const scores = new Map<string, number>();
      const traces: unknown[] = [];
      const limit = pLimit(4);
      const started = performance.now();
      await Promise.all(batches.map(batch => limit(async () => {
        if (Buffer.byteLength(JSON.stringify(batch.request)) > 48000) throw new Error('Request cap');
        const response = await budget.call(`filename-keys:${method}`, 0.15,
          () => evaluate(batch.request, AbortSignal.timeout(30000)), r => (r.usage as { cost?: number }).cost);
        const cost = (response.usage as { cost?: number }).cost;
        if (cost === undefined) throw new Error('Missing provider cost');
        costUSD += cost;
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
        for (const [id, name] of batch.keys) {
          const answer = response.answers[id];
          if (answer?.type !== 'noul' || !Number.isFinite(answer.noul)) throw new Error('Missing answer');
          scores.set(name, answer.noul);
        }
        traces.push({ request: batch.request, response });
      })));
      const seconds = (performance.now() - started) / 1000;
      const ranked = candidates.map(([name]) => name).sort((a, b) => scores.get(b)! - scores.get(a)!);
      const gold = JSON.parse(await readFile('benchmark/results/2026-10-07T20-09-09.317Z/grading-dataset.json', 'utf8')) as { instance_id: string; edit_functions: string[] }[];
      const expected = [...new Set(gold.find(g => g.instance_id === taskId)!.edit_functions.map(f => f.split(':')[0]!))];
      const row = { taskId, repetition, method, candidates: candidates.length, batches: batches.length, seconds, costUSD, inputTokens, outputTokens,
        fileAcc5: expected.every(p => ranked.slice(0, 5).includes(p)), fileAcc10: expected.every(p => ranked.slice(0, 10).includes(p)), ranked: ranked.slice(0, 20) };
      rows.push(row);
      await writeFile(path.join(output, `${taskId}-${repetition}-${method}.json`), JSON.stringify(traces));
      await writeFile(path.join(output, 'measurements.json'), JSON.stringify(rows, null, 2));
      console.log(`${taskId} ${repetition} ${method}: ${seconds.toFixed(3)}s $${costUSD.toFixed(6)} file@5=${row.fileAcc5} batches=${batches.length} spent=$${budget.spentUSD.toFixed(5)}`);
    }
  }
}
