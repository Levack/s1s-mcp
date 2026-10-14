import { summarizeTools, toolsFromTrace, type Tools } from './tool-usage.js';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Accounting } from './accounting.js';
import { metricNames, type Localization, type LocalizationMetrics } from './localization.js';
import { benches } from './params.js';
import type { Arm } from './agent.js';
export interface Attempt {
  instance_id: string; arm: Arm; repetition: number; order: number; status: string;
  setupMs: number; solveMs: number; steps: number; mcpCalls: number; mcpErrors: number;
  tools?: Tools; llm: Accounting; s1s: Accounting; localization?: Localization; error?: string; patchError?: string;
}
export interface Grade { instance_id: string; resolved: boolean; status: string; gradingMs: number; localization?: LocalizationMetrics }
export interface Row extends Attempt { resolved: boolean | null; gradeStatus: string; gradingMs: number | null; costUSD: number | null; knownCostUSD: number; localizationMetrics?: LocalizationMetrics }
export function join(attempts: Attempt[], grades: Map<string, Grade>): Row[] {
  return attempts.map(a => {
    const g = grades.get(`${a.arm}:${a.repetition}:${a.instance_id}`);
    return { ...a, tools: a.tools ?? {}, localizationMetrics: g?.localization, resolved: g ? g.resolved && a.status !== 'setup_error' : null,
      gradeStatus: g?.status ?? 'not_graded', gradingMs: g?.gradingMs ?? null,
      costUSD: a.status === 'pending' || a.llm.costUSD == null || a.s1s.costUSD == null ? null : a.llm.costUSD + a.s1s.costUSD,
      knownCostUSD: a.llm.knownCostUSD + a.s1s.knownCostUSD };
  });
}
export function summarize(rows: Row[]) {
  return (['baseline', 's1s'] as const).map(arm => {
    const items = rows.filter(r => r.arm === arm);
    const sum = (get: (r: Row) => number) => items.reduce((v, r) => v + get(r), 0);
    const resolved = items.filter(r => r.resolved).length;
    const localization = Object.fromEntries(metricNames.map(name => [name, items.length && items.every(r => r.localizationMetrics)
      ? sum(r => Number(r.localizationMetrics![name])) / items.length : null]));
    return { arm, tools: summarizeTools(items), localization, attempts: items.length, graded: items.filter(r => r.resolved !== null).length, resolved,
      resolveRate: items.length && items.every(r => r.resolved !== null) ? resolved / items.length : null,
      costUSD: items.some(r => r.costUSD === null) ? null : sum(r => r.costUSD!),
      knownCostUSD: sum(r => r.knownCostUSD),
      estimatedCostCalls: sum(r => r.llm.estimatedCostCalls + r.s1s.estimatedCostCalls),
      solverCalls: sum(r => r.llm.calls),
      s1sProviderCalls: sum(r => r.s1s.calls),
      totalApiCalls: sum(r => r.llm.calls + r.s1s.calls),
      solverCostUSD: items.some(r => r.llm.costUSD === null) ? null : sum(r => r.llm.costUSD!),
      s1sCostUSD: items.some(r => r.s1s.costUSD === null) ? null : sum(r => r.s1s.costUSD!),
      missingCostCalls: sum(r => r.llm.missingCostCalls + r.s1s.missingCostCalls),
      meanSolveSeconds: items.length && items.every(r => r.status !== 'pending') ? sum(r => r.solveMs) / items.length / 1000 : null,
      totalSetupSeconds: sum(r => r.setupMs) / 1000,
      totalSolveSeconds: sum(r => r.solveMs) / 1000,
      totalGradingSeconds: items.every(r => r.gradingMs !== null) ? sum(r => r.gradingMs!) / 1000 : null,
      solverErrors: items.filter(r => ['solver_error', 'timeout', 'setup_error'].includes(r.status)).length,
      gradingErrors: items.filter(r => r.gradeStatus === 'grading_error').length,
      mcpUsedAttempts: items.filter(r => r.mcpCalls > 0).length,
      mcpCalls: sum(r => r.mcpCalls), mcpErrors: sum(r => r.mcpErrors),
      inputTokens: sum(r => r.llm.inputTokens + r.s1s.inputTokens), outputTokens: sum(r => r.llm.outputTokens + r.s1s.outputTokens) };
  });
}
const csvCell = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
export async function writeReport(output: string) {
  const attempts: Attempt[] = JSON.parse(await readFile(path.join(output, 'attempts.json'), 'utf8'));
  for (const attempt of attempts) {
    attempt.tools ??= attempt.status === 'pending' ? {}
      : await toolsFromTrace(path.join(output, 'traces', `${attempt.instance_id}-${attempt.repetition}-${attempt.arm}.jsonl`));
  }
  const grades = new Map<string, Grade>();
  for (const file of await readdir(output)) {
    const match = /^(baseline|s1s)-(\d+)\.grades\.json$/.exec(file);
    if (!match) continue;
    for (const g of JSON.parse(await readFile(path.join(output, file), 'utf8')) as Grade[]) grades.set(`${match[1]}:${match[2]}:${g.instance_id}`, g);
  }
  const rows = join(attempts, grades), summary = summarize(rows);
  const pairs = rows.filter(r => r.arm === 'baseline').map(b => {
    const s = rows.find(r => r.arm === 's1s' && r.repetition === b.repetition && r.instance_id === b.instance_id);
    return { instance_id: b.instance_id, repetition: b.repetition, baselineLocalization: b.localizationMetrics, s1sLocalization: s?.localizationMetrics, baselineResolved: b.resolved, s1sResolved: s?.resolved ?? null,
      costDeltaUSD: b.costUSD !== null && s?.costUSD != null ? s.costUSD - b.costUSD : null,
      solveDeltaSeconds: s ? (s.solveMs - b.solveMs) / 1000 : null };
  });
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({ summary, pairs, rows }, null, 2) + '\n');
  const flat = rows.map(r => ({ instance_id: r.instance_id, repetition: r.repetition, arm: r.arm, order: r.order,
    ...r.localizationMetrics, status: r.status, gradeStatus: r.gradeStatus, resolved: r.resolved, costUSD: r.costUSD,
    knownCostUSD: r.knownCostUSD, solverCostUSD: r.llm.costUSD, s1sCostUSD: r.s1s.costUSD,
    missingCostCalls: r.llm.missingCostCalls + r.s1s.missingCostCalls,
    missingTokenCalls: r.llm.missingTokenCalls + r.s1s.missingTokenCalls,
    estimatedCostCalls: r.llm.estimatedCostCalls + r.s1s.estimatedCostCalls,
    setupSeconds: r.setupMs / 1000, solveSeconds: r.solveMs / 1000, gradingSeconds: r.gradingMs == null ? null : r.gradingMs / 1000,
    solverCalls: r.llm.calls, s1sProviderCalls: r.s1s.calls, totalApiCalls: r.llm.calls + r.s1s.calls,
    steps: r.steps, mcpCalls: r.mcpCalls, mcpErrors: r.mcpErrors, error: r.error, patchError: r.patchError, tools: JSON.stringify(r.tools) }));
  const keys = Object.keys(flat[0] ?? { instance_id: '' });
  await writeFile(path.join(output, 'results.csv'), [keys.map(csvCell).join(','), ...flat.map(r => keys.map(k => csvCell(r[k as keyof typeof r])).join(','))].join('\n') + '\n');
  const number = (n: number | null) => n === null ? 'N/A' : n.toFixed(3);
  const params = JSON.parse(await readFile(path.join(output, 'params.json'), 'utf8'));
  const dry = params.dryRun;
  const localize = params.bench === 'loc-bench';
  const accuracy = localize
    ? '| Condition | Attempts | File Acc@5 | File Acc@10 | Function Acc@10 | Function Acc@15 | Total API USD | Solver USD | s1s USD | Mean solve seconds | Estimated calls | Errors (solver / grading) | MCP used |\n' +
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n' + summary.map(s =>
        `| ${s.arm} | ${s.attempts} | ${metricNames.map(name => s.localization[name] == null ? 'N/A' : (s.localization[name]! * 100).toFixed(1) + '%').join(' | ')} | ${number(s.costUSD)} | ${number(s.solverCostUSD)} | ${number(s.s1sCostUSD)} | ${number(s.meanSolveSeconds)} | ${s.estimatedCostCalls} | ${s.solverErrors} / ${s.gradingErrors} | ${s.mcpUsedAttempts} |`).join('\n')
    :
    '| Condition | Attempts | Resolved | Resolve rate | Total API USD | Solver USD | s1s USD | Mean solve seconds | Estimated calls | Errors (solver / grading) | MCP used |\n' +
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n' + summary.map(s =>
      `| ${s.arm} | ${s.attempts} | ${s.resolved} | ${s.resolveRate === null ? 'N/A' : (s.resolveRate * 100).toFixed(1) + '%'} | ${number(s.costUSD)} | ${number(s.solverCostUSD)} | ${number(s.s1sCostUSD)} | ${number(s.meanSolveSeconds)} | ${s.estimatedCostCalls} | ${s.solverErrors} / ${s.gradingErrors} | ${s.mcpUsedAttempts} |`).join('\n');
  const calls = '\n\n| Condition | LLM API calls | s1s provider API calls | Total API calls | MCP tool calls | MCP errors |\n' +
    '|---|---:|---:|---:|---:|---:|\n' + summary.map(s =>
      `| ${s.arm} | ${s.solverCalls} | ${s.s1sProviderCalls} | ${s.totalApiCalls} | ${s.mcpCalls} | ${s.mcpErrors} |`).join('\n') +
    '\n\nCall counts are observed attempts, including failed API calls. One MCP ranking call can produce multiple s1s provider API calls through batching. Total API calls sum LLM and s1s provider calls; MCP calls are listed separately to avoid double counting.\n';
  const toolCalls = '\n\n| Condition | Tool | Calls | Errors | Attempts using tool | Total tool seconds |\n' +
    '|---|---|---:|---:|---:|---:|\n' + summary.flatMap(s => Object.entries(s.tools).sort(([a], [b]) => a.localeCompare(b)).map(([name, usage]) =>
      `| ${s.arm} | ${name.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${usage.calls} | ${usage.errors} | ${usage.usedAttempts} | ${(usage.durationMs / 1000).toFixed(3)} |`)).join('\n') +
    '\n\nTool counts include attempted calls, including validation failures, timeouts and shell nonzero exits. Tool errors do not necessarily mean the solver failed: it may recover. Names are the actual called names from the trace. Provider batch calls are counted separately. Missing trace data in historical results cannot reconstruct tool calls.\n';
  await writeFile(path.join(output, 'results.md'), `# ${benches[params.bench as keyof typeof benches]?.name ?? 'SWE-bench Verified Mini'} comparison\n\n${dry ? '**DRY RUN: simulated solver and grading. No measured performance claims.**\n\n' : ''}` + accuracy + calls + toolCalls +
    (localize ? '\n\nAcc@k requires all gold edited locations in the top k unique predictions. Gold comes from edit_functions; file labels are their paths. Class constructors normalize to the class name. Empty, invalid or failed submissions score zero; all scheduled attempts remain in the denominator. Grades are N/A until complete. This runner uses strict all-location coverage, including when gold exceeds k; it does not truncate gold to k. Project dependencies are not installed in source-only Loc-Bench containers.\n' : '') +
    (localize ? '\n\n' : '\n\nResolve rate uses all scheduled attempts, including infrastructure failures and empty patches. Missing grading produces N/A until completed. ') + 'Costs use provider-reported usage.cost, include all observed solver and s1s provider calls, and exclude Docker/host costs. Explicit per-million token prices can estimate missing reported costs; estimated calls are labeled and do not model cache discounts. Missing cost is N/A; knownCostUSD is only a lower bound. Failed or timed-out API calls may have been billed without returning usage. Internal s1s retries are disabled. Solve time includes MCP calls and excludes preparation, container setup and official grading; these are recorded separately. Arms run sequentially within each pair with alternating order per task/repetition; task pairs can run concurrently. The s1s condition exposes the real MCP tools over in-memory MCP transport; tool calls are counted. Experiment delivery overrides may additionally prefetch context, as documented in their manifests. The base task prompt and solver settings are shared. The s1s arm also receives the MCP server usage instructions when supported by the runner; exact messages and tools are recorded in traces. No automatic retries, significance claim or hidden-test feedback to the solver.\n');
  return summary;
}
