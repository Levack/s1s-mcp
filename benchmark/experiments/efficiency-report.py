"""Offline summary of efficiency experiments. Never sends provider requests."""
import json
from pathlib import Path
from statistics import mean, median

root = Path('benchmark/results/efficiency-2026-10-12')
stages = []
for directory in sorted(root.iterdir()):
    if not (directory / 'results.json').exists():
        continue
    manifest = json.loads((directory / 'manifest.json').read_text())
    rows = json.loads((directory / 'results.json').read_text())
    groups = []
    for arm in ['baseline', 's1s', 'one_call']:
        selected = [r for r in rows if r['arm'] == arm]
        if not selected:
            continue
        groups.append(dict(arm=arm, attempts=len(selected),
            fileAcc5=sum(r['metrics']['fileAcc5'] for r in selected),
            functionAcc10=sum(r['metrics']['functionAcc10'] for r in selected),
            latencyAttempts=sum(r['solveMs'] is not None for r in selected),
            meanSeconds=mean(r['solveMs'] / 1000 for r in selected if r['solveMs'] is not None),
            medianSeconds=median(r['solveMs'] / 1000 for r in selected if r['solveMs'] is not None),
            meanSourceExportSeconds=mean(r['sourceExportMs'] / 1000 for r in selected if r['sourceExportMs'] is not None),
            solverCalls=sum(r.get('solverCalls', r.get('llm', {}).get('calls', 0)) for r in selected),
            jevCalls=sum(r.get('providerCalls', r.get('s1s', {}).get('calls', 0)) for r in selected),
            mcpCalls=sum(r.get('retrievalCalls', r.get('mcpCalls', 0)) for r in selected),
            mcpErrors=sum(r.get('mcpErrors', int(r.get('mcpError', False))) for r in selected),
            costUSD=sum(r.get('costUSD', r.get('llm', {}).get('knownCostUSD', 0) + r.get('s1s', {}).get('knownCostUSD', 0)) for r in selected),
            solverErrors=sum(r['status'] != 'submitted' for r in selected),
            evidenceFileAcc5=sum(r.get('evidenceFileAcc5') is True for r in selected) if arm == 'one_call' else None,
            meanSearchSeconds=mean((r['searchMs'] + r['sourceExportMs']) / 1000 for r in selected if r.get('searchMs') is not None) if arm == 'one_call' else None))
    stages.append(dict(stage=directory.name, design=manifest['design'], model=manifest['params']['model'],
        taskNumbers=manifest['taskNumbers'], repetitions=manifest['repetitions'], groups=groups))
ledger = json.loads((root / 'budget.json').read_text())
reported = sum(r['costUSD'] or 0 for r in ledger['receipts'])
held = sum(r['reservedUSD'] for r in ledger['receipts'] if r['costUSD'] is None)
summary = dict(stages=stages, reportedUSD=reported, reservedUnknownUSD=held,
               authorizationUSD=5, stopUSD=ledger['limitUSD'], receipts=len(ledger['receipts']))
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
lines = ['# Search efficiency experiments', '',
    'Additional authorization: $5 on 2026-10-12. Separate ledger from the October 9 experiments; stop line $4.50. The tools-only stages have no forced MCP calls, prefetch or extra initial prompts. Gold never enters any solver or retrieval request. The tools-only stages use optional native tools. The one-call stages are explicitly different workflows: a controller invokes search_code once with the original issue, then one model completion submits locations from the evidence, with no follow-up retrieval. They do not demonstrate automatic one-call behavior in an unconstrained agent. Source snapshots and raw request/response traces are retained in each stage.', '',
    'These are Loc-Bench localization tasks, not end-to-end bug fixes. File@5 / Function@10 require every gold location to appear within the first 5 files / 10 functions. Solve time includes local shell, MCP, source export and solver waits, excluding workspace startup. Cost includes solver and Jev API calls, excluding local CPU/Docker.', '',
    '| Stage | Arm | Attempts | File@5 | Function@10 | Mean s | Median s | LLM calls | Jev calls | MCP errors | Total API USD |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
for stage in stages:
    for g in stage['groups']:
        lines.append(f"| {stage['stage']} | {g['arm']} | {g['attempts']} | {g['fileAcc5']}/{g['attempts']} | {g['functionAcc10']}/{g['attempts']} | {g['meanSeconds']:.3f} | {g['medianSeconds']:.3f} | {g['solverCalls']} | {g['jevCalls']} | {g['mcpErrors']} | {g['costUSD']:.6f} |")
lines += ['', 'One-call raw retrieval coverage (before the consumer model selects a final answer):', '', '| Stage | Attempts | Evidence file@5 | Mean retrieval seconds, including export |', '|---|---:|---:|---:|']
for stage in stages:
    for g in stage['groups']:
        if g['arm'] == 'one_call':
            lines.append(f"| {stage['stage']} | {g['attempts']} | {g['evidenceFileAcc5']}/{g['attempts']} | {g['meanSearchSeconds']:.3f} |")
lines += ['', 'Stages are separate comparisons; do not pool tuning tasks and validation tasks or different implementations. All are small samples with provider/model nondeterminism. One one-call-validation response was malformed JSON: it is counted as a failure with its full ledger cost, without retry. Its trace/timing were lost in the runner exception; timing means exclude that attempt and raw evidence recall treats its unknown coverage as unsuccessful. See failure-recovery.json. The compact stage repeated seed 42 twice; later two-repeat stages use seeds 42 and 43. Task numbers and all settings are in each manifest.', '',
    f'Current authorization ledger: reported ${reported:.9f}; unknown/in-flight reservations ${held:.9f}; total ${reported + held:.9f}.', '',
    'Stage sequence: current (original raw MCP envelope), compact (deduplicated evidence), candidates (explicit content paths/topK), combined (optional filename+content inspection), hybrid (local exact search), routing (clearer tool choice and candidate path handling), one-call-pilot (complete internal retrieval pipeline), one-call-packed (shared content-query batching and declaration outlines), one-call-focused (identifier neighborhoods), one-call-validation (seven separate tasks), and one-call-agent (optional-tool adoption audit without a paired baseline). Validation stages use their recorded implementation on tasks excluded from this session\'s tuning. Exact search is local and makes no Jev calls; improvements involving it must not be attributed to Jev inference.', '']
(root / 'results.md').write_text('\n'.join(lines))
print(f'Report: {root / "results.md"}; reported ${reported:.9f}, held ${held:.9f}')
