import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'benchmark/results/delivery-experiments-2026-10-09');
type Row = {
  instance_id: string; repetition: number; variant: string; model: string; status: string;
  solveMs: number; sourceExportMs?: number; mcpCalls: number; mcpErrors: number;
  metrics: Record<string, boolean>;
  llm: { calls: number; costUSD: number | null; inputTokens: number; outputTokens: number };
  s1s: { calls: number; costUSD: number | null };
  tools: Record<string, { calls: number; errors: number; durationMs: number }>;
};
const stages: { name: string; rows: Row[] }[] = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try { stages.push({ name: entry.name, rows: JSON.parse(await readFile(path.join(root, entry.name, 'results.json'), 'utf8')) }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const sum = (rows: Row[], metric: (r: Row) => number) => rows.reduce((n, r) => n + metric(r), 0);
const output = ['# MCP delivery experiments', '',
  'Exploratory comparisons on pinned Loc-Bench source snapshots. Each attempt uses a fresh offline container. Gold is read only after submission. Conditions rotate order; tasks are selected by stored task number, without selecting by outcome. All attempts remain in accuracy denominators. Source export for MCP is included in solve time; Docker setup is excluded. Small samples do not establish a general speed advantage.', '',
  'File@5 and Function@10 require every gold location to be present within the first 5 files or 10 functions. Faster results with lower accuracy are not treated as improvements.', ''];
output.push('Important: `all-filenames`, `controller-comparison`, and `filename-micro` used an experimental filename-key-only prompt. It failed to bind the candidate path explicitly in each question. Their results diagnose that failed design; they are not evidence about the corrected filename workflow. `all-filenames` also relied on prompt-only inspection mode selection. Later stages bind `candidate_path` explicitly and fix the inspection mode in the adapter. The pre-existing rank_paths/filter_files handlers already supplied candidate evidence explicitly.', '');
output.push('The `prefetch_content3` condition automatically invokes MCP before the first solver request, using only the original issue and source globs. Retrieval time and costs are included. This is a harness-orchestrated workflow, not evidence that merely connecting MCP makes an agent automatically prefetch.', '');
for (const stage of stages) {
  output.push(`## ${stage.name}`, '',
    '| Variant | Model | Attempts | File@5 | Function@10 | Mean seconds | LLM calls | Jev calls | MCP errors | API USD |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const variant of new Set(stage.rows.map(r => r.variant))) {
    const rows = stage.rows.filter(r => r.variant === variant);
    const costKnown = rows.every(r => r.llm.costUSD !== null && r.s1s.costUSD !== null);
    output.push(`| ${variant} | ${rows[0]!.model} | ${rows.length} | ${sum(rows, r => +r.metrics.fileAcc5!)}/${rows.length} | ${sum(rows, r => +r.metrics.functionAcc10!)}/${rows.length} | ${(sum(rows, r => r.solveMs) / rows.length / 1000).toFixed(2)} | ${sum(rows, r => r.llm.calls)} | ${sum(rows, r => r.s1s.calls)} | ${sum(rows, r => r.mcpErrors)} | ${costKnown ? sum(rows, r => r.llm.costUSD! + r.s1s.costUSD!).toFixed(5) : 'unknown'} |`);
  }
  output.push('', '| Task | Repeat | Variant | Seconds | File@5 | Function@10 | LLM calls | Jev calls | Status |', '|---|---:|---|---:|---:|---:|---:|---:|---|');
  for (const r of stage.rows) output.push(`| ${r.instance_id} | ${r.repetition + 1} | ${r.variant} | ${(r.solveMs / 1000).toFixed(2)} | ${+r.metrics.fileAcc5!} | ${+r.metrics.functionAcc10!} | ${r.llm.calls} | ${r.s1s.calls} | ${r.status} |`);
  output.push('');
}
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    const micro = await readFile(path.join(root, entry.name, 'micro-results.json'), 'utf8');
    const rows = JSON.parse(micro) as { method: string; seconds: number; fileAcc5: boolean; fileAcc10: boolean; costUSD: number }[];
    output.push(`## ${entry.name}: filename triage only`, '',
      'Three task inventories, five rotated repetitions each. Same inventory and original issue per method. MCP filesystem discovery is included; inventory preparation and transport initialization are excluded. LLMs return top ten paths in one call. This is not an end-to-end coding benchmark.', '',
      '| Method | Attempts | File@5 | File@10 | Mean seconds | API USD |', '|---|---:|---:|---:|---:|---:|');
    for (const method of new Set(rows.map(r => r.method))) {
      const selected = rows.filter(r => r.method === method);
      output.push(`| ${method} | ${selected.length} | ${selected.filter(r => r.fileAcc5).length}/${selected.length} | ${selected.filter(r => r.fileAcc10).length}/${selected.length} | ${(selected.reduce((n, r) => n + r.seconds, 0) / selected.length).toFixed(3)} | ${selected.reduce((n, r) => n + r.costUSD, 0).toFixed(5)} |`);
    }
    output.push('');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
for (const entry of await readdir(root, { withFileTypes: true })) {
 if (!entry.isDirectory() || !entry.name.startsWith('swe-')) continue;
 try {
  const swe = JSON.parse(await readFile(path.join(root, entry.name, 'summary.json'), 'utf8')) as {
    summary: { arm: string; attempts: number; graded: number; resolved: number; meanSolveSeconds: number; costUSD: number | null; solverCalls: number; s1sProviderCalls: number }[];
  };
  output.push(`## SWE-bench: ${entry.name}`, '',
    'Three pinned tasks, one attempt per condition. MCP automatically ranks all Python filenames and inspects the top three before the solver starts. Retrieval is included in solve time; official grading and container setup are excluded. This is a small smoke test, not a general performance estimate.', '',
    '| Condition | Attempts | Graded | Resolved | Mean solve seconds | LLM calls | Jev calls | API USD |',
    '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of swe.summary) output.push(`| ${row.arm} | ${row.attempts} | ${row.graded} | ${row.resolved} | ${row.meanSolveSeconds.toFixed(2)} | ${row.solverCalls} | ${row.s1sProviderCalls} | ${row.costUSD?.toFixed(5) ?? 'unknown'} |`);
  output.push('');
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const budget = JSON.parse(await readFile(path.join(root, 'budget.json'), 'utf8')) as { receipts: { costUSD: number | null; reservedUSD: number; coveredRejection?: boolean }[] };
const spent = budget.receipts.reduce((n, r) => n + (r.costUSD ?? 0), 0);
const held = budget.receipts.filter(r => r.costUSD === null).reduce((n, r) => n + r.reservedUSD, 0);
output.push(`Provider-reported spend across all stages: $${spent.toFixed(6)}. Unknown/in-flight receipts: ${budget.receipts.filter(r => r.costUSD === null).length}, with $${held.toFixed(6)} retained as budget liability. Input-validation rejections explicitly covered by their full reservation: ${budget.receipts.filter(r => r.coveredRejection).length}. The experiment stop line is $4, below the authorized $5 ceiling.`, '');
await writeFile(path.join(root, 'comparison.md'), output.join('\n'));
console.log(`Reported ${stages.length} stages, ${stages.reduce((n, s) => n + s.rows.length, 0)} attempts; reported spend $${spent.toFixed(6)}.`);
