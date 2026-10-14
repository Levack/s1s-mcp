import { Command } from 'commander';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import { spawn } from 'node:child_process';
import { publicConfig } from '../src/config.js';
import { type Evaluate } from '../src/system-one.js';
import { Ledger } from './accounting.js';
import { openRouterKey, benchmarkConfig } from './auth.js';
import { interactiveParams, wantsInteractive } from './interactive.js';
import { benches, parseRange, taskCount, paramsSchema, readParams, type Params } from './params.js';
import { workspace, docker, type Task, type Workspace } from './docker.js';
import { solve, apiComplete, assertToolsOnly, type Arm, type Complete, type Delivery } from './agent.js';
import { prepareDataset, prepareHarness } from './prepare.js';
import { runPairs } from './schedule.js';
import { gradeSWE } from './grading.js';
import { gradeLocalization } from './localization.js';
import { writeReport, type Attempt } from './report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function exists(file: string) { try { await access(file); return true; } catch { return false; } }
async function save(file: string, value: unknown) { await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
function command(cmd: string, args: string[], cwd = root): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code ?? signal}`)));
  });
}
export const simulatedEvaluate: Evaluate = async request => ({ model: 'simulated-jev',
  usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
  answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul' as const, noul: 0.9 }])) });
export function simulatedComplete(): Complete {
  let step = 0;
  return async (_messages, tools) => {
    const enhanced = tools.some(t => t.function.name === 's1s_filter_files');
    const name = enhanced && step === 0 ? 's1s_filter_files' : step === (enhanced ? 1 : 0) ? 'bash' : 'finish';
    const finishTool = tools.find(t => t.function.name === 'finish')!;
    const localize = 'files' in (finishTool.function.parameters.properties as Record<string, unknown> ?? {});
    const args = name === 's1s_filter_files' ? { question: 'Is this file relevant to the simulated issue?', files: ['**/*.py'], threshold: 0 }
      : name === 'bash' ? { command: 'git diff' } : localize ? { files: ['example.py'], functions: ['example.py:fix'] } : {};
    return { model: 'simulated', usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 }, choices: [{ message: {
      role: 'assistant', content: null, tool_calls: [{ id: `sim-${step++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
  };
}
async function prepare(params: Params, output: string) {
  if (params.dryRun) {
    const all: Task[] = Array.from({ length: benches[params.bench].size }, (_, i) => ({
      instance_id: `dry-run-${String(i + 1).padStart(3, '0')}`, repo: 'simulated/repository', base_commit: '0'.repeat(40),
      problem_statement: 'Synthetic plumbing check; not a benchmark task.', image: 'simulated', taskNumber: i + 1 }));
    const tasks = params.range ? parseRange(params.range, all.length).map(n => all[n - 1]!)
      : params.instanceIds ? all.filter(t => params.instanceIds!.includes(t.instance_id)) : all.slice(0, Math.min(params.limit, 2));
    if (params.instanceIds && params.instanceIds.some(id => !all.some(t => t.instance_id === id))) throw new Error('Unknown synthetic instance ID; dry runs use dry-run-001, dry-run-002, ...');
    await save(path.join(output, 'tasks.json'), tasks);
    if (params.bench === 'loc-bench') await save(path.join(output, 'grading-dataset.json'), tasks.map(t => ({ instance_id: t.instance_id, edit_functions: ['example.py:fix'] })));
    await save(path.join(output, 'dataset.json'), { dataset: 'SIMULATED', instanceIds: tasks.map(t => t.instance_id), taskNumbers: tasks.map(t => t.taskNumber) });
  } else {
    await prepareDataset(params, output);
  }
}
export async function run(params: Params, execution: { delivery?: Delivery; complete?: Complete; evaluate?: Evaluate } = {}) {
  if (params.mode !== 'report') assertToolsOnly(execution.delivery);
  if (params.mode === 'report') {
    if (!params.output) throw new Error('report requires --output');
    console.log(await writeReport(path.resolve(params.output))); return;
  }
  if (params.mode === 'run' && !params.dryRun && !params.model) throw new Error('Specify --model or BENCH_MODEL');
  const output = path.resolve(params.output ?? path.join(root, 'benchmark/results', new Date().toISOString().replaceAll(':', '-') + (params.dryRun ? '-dry' : '')));
  // A prepared directory can be consumed once. Existing attempts are never overwritten.
  if (await exists(path.join(output, 'attempts.json'))) throw new Error('Output already contains attempts; choose a new output or use --mode report');
  const prepared = await exists(path.join(output, 'tasks.json'));
  if (prepared) {
    const previous = paramsSchema.parse(JSON.parse(await readFile(path.join(output, 'params.json'), 'utf8')));
    for (const key of ['bench', 'dryRun', 'dataset', 'revision', 'limit', 'range', 'instanceIds', 'pullImages'] as const) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(params[key])) throw new Error(`Prepared output differs in ${key}; choose a new output`);
    }
    if (params.mode === 'prepare') throw new Error('Output is already prepared');
  }
  const live = params.mode === 'run' && !params.dryRun;
  const key = live ? await openRouterKey(params, { login: () => command(process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'login', '--provider', 'openrouter', '--auth-method', 'oauth']) }) : undefined;
  const config = await benchmarkConfig(params, key);
  if (params.mode === 'run' && !params.dryRun) {
    if (!params.pullImages) throw new Error('Live runs require pullImages=true to record Docker image identities');
    await docker(['info']);
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  await save(path.join(output, 'params.json'), params);
  const preparationStarted = performance.now();
  if (!prepared) await prepare(params, output);
  const harnessImage = !params.dryRun && params.bench === 'swe-bench-mini' ? await prepareHarness(output) : undefined;
  const tasks = JSON.parse(await readFile(path.join(output, 'tasks.json'), 'utf8')) as Task[];
  const source = await docker(['version', '--format', '{{.Server.Version}}']).catch(() => null);
  const runMetadata = { startedAt: new Date().toISOString(), preparationMs: performance.now() - preparationStarted,
    node: process.version, dockerVersion: source, s1s: publicConfig(config),
    model: params.model, delivery: execution.delivery,
    armPolicy: 'tools-only: identical initial messages; MCP tool definitions only in s1s arm; no prefetch, additional instructions or argument overrides; alternating order; sequential arms within each pair', concurrency: params.concurrency, executionWallMs: 0 };
  await save(path.join(output, 'run.json'), runMetadata);
  console.log(`Prepared ${tasks.length} tasks: ${output}`);
  if (params.mode === 'prepare') return;
  const attempts: Attempt[] = [];
  for (let repetition = 0; repetition < params.repetitions; repetition++) {
    for (const [index, task] of tasks.entries()) {
      const arms: Arm[] = (index + repetition + params.seed) % 2 ? ['s1s', 'baseline'] : ['baseline', 's1s'];
      for (const [order, arm] of arms.entries()) attempts.push({ instance_id: task.instance_id, repetition, arm, order,
        status: 'pending', setupMs: 0, solveMs: 0, steps: 0, mcpCalls: 0, mcpErrors: 0,
        llm: new Ledger().snapshot(), s1s: new Ledger().snapshot() });
    }
  }
  await save(path.join(output, 'attempts.json'), attempts);
  await mkdir(path.join(output, 'traces'));
  for (let repetition = 0; repetition < params.repetitions; repetition++) {
    const executionStarted = performance.now();
    const persist = pLimit(1);
    await runPairs(tasks, repetition, params, async (task, index, arm, order) => {
        console.log(`[${index + 1}/${tasks.length}] repeat=${repetition + 1} ${arm} ${task.instance_id}`);
        const setupStarted = performance.now();
        let repo: Workspace | undefined;
        const empty = new Ledger().snapshot();
        let attempt: Attempt = { instance_id: task.instance_id, repetition, arm, order, status: 'setup_error',
          setupMs: 0, solveMs: 0, steps: 0, mcpCalls: 0, mcpErrors: 0, llm: empty, s1s: empty };
        let patch = '';
        try {
          repo = params.dryRun ? { shell: async () => 'SIMULATED shell result', patch: async () => 'SIMULATED patch',
            exportCurrentSource: async target => { await writeFile(path.join(target, 'example.py'), 'def fix():\n    pass\n'); },
            exportSource: async target => { await writeFile(path.join(target, 'example.py'), 'def fix():\n    pass\n'); }, close: async () => {} } : await workspace(task, params);
          attempt.setupMs = performance.now() - setupStarted;
          const trace = path.join(output, 'traces', `${task.instance_id}-${repetition}-${arm}.jsonl`);
          await writeFile(trace, '', { mode: 0o600, flag: 'wx' });
          attempt = { ...attempt, ...await solve(task, arm, params, config, repo, trace,
            params.dryRun ? simulatedComplete() : execution.complete ?? apiComplete(params, key!),
            params.dryRun ? simulatedEvaluate : execution.evaluate, execution.delivery) };
          if (params.bench === 'swe-bench-mini') {
            try { patch = await repo.patch(); }
            catch { attempt.patchError = 'Failed to extract patch'; }
          }
        } catch (e) {
          attempt.setupMs = performance.now() - setupStarted;
          attempt.error = e instanceof Error ? e.message : 'Attempt failed';
        } finally { if (repo) await repo.close().catch(() => { attempt.error = 'Container cleanup failed'; }); }
        attempts[attempts.findIndex(a => a.instance_id === task.instance_id && a.arm === arm && a.repetition === repetition)] = attempt;
        await persist(async () => {
          await save(path.join(output, 'attempts.json'), attempts);
          await writeFile(path.join(output, `${arm}-${repetition}.predictions.jsonl`), JSON.stringify({
            instance_id: task.instance_id, ...(params.bench === 'loc-bench' ? { localization: attempt.localization ?? null } : { model_name_or_path: arm, model_patch: patch }) }) + '\n', { flag: 'a' });
          await writeReport(output);
        });
    });
    runMetadata.executionWallMs += performance.now() - executionStarted;
    await save(path.join(output, 'run.json'), runMetadata);
    for (const arm of (repetition % 2 ? ['s1s', 'baseline'] : ['baseline', 's1s']) as Arm[]) {
      if (params.bench === 'loc-bench') {
        const gold = JSON.parse(await readFile(path.join(output, 'grading-dataset.json'), 'utf8')) as { instance_id: string; edit_functions: string[] }[];
        await save(path.join(output, `${arm}-${repetition}.grades.json`), gold.map(row => {
          const gradingStarted = performance.now();
          const prediction = attempts.find(a => a.instance_id === row.instance_id && a.arm === arm && a.repetition === repetition);
          const metrics = gradeLocalization(row.edit_functions, prediction?.status === 'submitted' ? prediction.localization : undefined);
          return { instance_id: row.instance_id, resolved: metrics.fileAcc5, status: 'localized', gradingMs: performance.now() - gradingStarted, localization: metrics };
        }));
      } else if (params.dryRun) {
        await save(path.join(output, `${arm}-${repetition}.grades.json`), tasks.map((t, i) => ({
          instance_id: t.instance_id, status: i % 2 ? 'unresolved' : 'resolved', resolved: i % 2 === 0, gradingMs: 0 })));
      } else {
        try { await gradeSWE(params, output, arm, repetition, harnessImage!); }
        catch (e) { console.error(`Grading failed for ${arm}: ${e instanceof Error ? e.message : 'unknown error'}`); }
      }
      await writeReport(output);
    }
  }
  const summary = await writeReport(output);
  console.log(summary);
  console.log(`Reports: ${path.join(output, 'results.md')} and results.csv`);
  if (summary.some(s => s.graded !== s.attempts || s.gradingErrors > 0)) throw new Error('Grading incomplete or failed; see reports and official grading logs');
}
async function main() {
  const cli = new Command().name('benchmark').description('Paired LLM evaluation with/without s1s MCP')
    .option('--bench <name>', 'swe-bench-mini or loc-bench (default: swe-bench-mini)')
    .option('--interactive', 'Choose benchmark settings interactively')
    .option('--params <json-or-file>', 'Optional JSON configuration')
    .option('--model <id>', 'Solver model ID on OpenRouter')
    .option('--range <numbers>', 'Task numbers in sorted ID order, 1-based inclusive (e.g. 1-10 or 1,3,5-8)')
    .option('--instance-ids <ids>', 'Comma-separated problem IDs', value => value.split(',').map(id => id.trim()))
    .option('--limit <n>', 'Number of tasks (Mini: 1–50; Loc-Bench: 1–560)', Number)
    .option('--max-steps <n>', 'Maximum solver calls per attempt', Number)
    .option('--max-output-tokens <n>', 'Maximum output tokens per solver call', Number)
    .option('--concurrency <n>', 'Parallel task pairs (default: 1)', Number)
    .option('--repetitions <n>', 'Paired repetitions', Number)
    .option('--timeout-seconds <n>', 'Time limit per solving attempt', Number)
    .option('--output <directory>', 'Results directory')
    .option('--base-url <url>', 'Chat Completions API root')
    .option('--s1s-model <id>', 'System One model')
    .option('--s1s-provider <name>', 'System One provider (openrouter)')
    .option('--mode <mode>', 'run, prepare, or report')
    .option('--dry-run', 'Exercise the pipeline with simulated data, APIs and grading');
  cli.parse();
  const { params: input, s1sModel, s1sProvider, interactive, ...flags } = cli.opts();
  if (flags.range !== undefined && flags.instanceIds !== undefined) throw new Error('Choose --range or --instance-ids, not both');
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive && !tty) throw new Error('--interactive requires a terminal. Specify benchmark settings with flags in scripts.');
  const base = await readParams(input);
  let options = paramsSchema.parse({ ...base, ...flags, ...(flags.range !== undefined ? { instanceIds: undefined } : flags.instanceIds !== undefined ? { range: undefined } : {}), ...(flags.bench && flags.bench !== base.bench ? { dataset: undefined } : {}), s1s: { ...base.s1s,
    ...(s1sModel ? { model: s1sModel } : {}), ...(s1sProvider ? { provider: s1sProvider } : {}) } });
  if (wantsInteractive(process.argv.slice(2), tty)) {
    options = await interactiveParams(options);
    console.log(options.mode === 'run' && !options.dryRun
      ? `Running ${options.model}: ${taskCount(options)} tasks × 2 conditions × ${options.repetitions} repetitions (${taskCount(options) * 2 * options.repetitions} attempts), with s1s ${options.s1s.model ?? 'jev-latest'}.`
      : `Mode: ${options.dryRun ? 'dry run' : options.mode}. Results: ${options.output}`);
  }
  await run(options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    if (error instanceof Error && error.name === 'ExitPromptError') { process.exitCode = 130; return; }
    console.error(error instanceof Error ? error.message : 'Benchmark failed'); process.exitCode = 1;
  });
}
