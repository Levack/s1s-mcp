"""Summarize search-only experiments without making provider requests."""
import json
from pathlib import Path
from statistics import mean

root = Path('benchmark/results/efficiency-2026-10-12')
lines = ['# Search-only localization experiments', '',
         'All model calls use Jev through independent yes/no probability judgments. No planner or consumer model is used. Times include local discovery, reading and Python AST extraction, but exclude Docker startup and shared source export. Current function predictions are a deterministic source-span projection; the production endpoint does not natively rank functions.', '']
for stage in ['retrieval-pilot', 'retrieval-validation', 'retrieval-symbol-pilot', 'retrieval-symbol-exact-pilot', 'retrieval-symbol-followup']:
    file = root / stage / 'results.json'
    if not file.exists():
        continue
    rows = json.loads(file.read_text())
    failed = [r for r in rows if r.get('status') == 'provider_error']
    if stage == 'retrieval-symbol-followup':
        complete_keys = {(r['instance_id'], r['repetition']) for r in rows
                         if sum(x['instance_id'] == r['instance_id'] and x['repetition'] == r['repetition']
                                and x.get('status') != 'provider_error' for x in rows) == 3}
        rows = [r for r in rows if (r['instance_id'], r['repetition']) in complete_keys]
        lines += ['Follow-up is exploratory and incomplete: only six complete three-arm comparisons are included below. One additional current-arm attempt failed with HTTP 403 (API key total limit); no retry or key limit change. Its $0.15 unknown-charge allowance remains in the ledger. All raw attempts are retained.', '']
    lines += [f'## {stage}', '', '| Arm | Runs | File@5 | Function@10 | Mean seconds | Total cost | Mean input tokens | Mean provider calls |',
              '|---|---:|---:|---:|---:|---:|---:|---:|']
    for arm in dict.fromkeys(r['arm'] for r in rows):
        group = [r for r in rows if r['arm'] == arm]
        lines.append(f"| {arm} | {len(group)} | {sum(r['metrics']['fileAcc5'] for r in group)} | {sum(r['metrics']['functionAcc10'] for r in group)} | {mean(r['searchMs'] for r in group)/1000:.3f} | ${sum(r['costUSD'] for r in group):.6f} | {mean(r['inputTokens'] for r in group):.0f} | {mean(r['calls'] for r in group):.2f} |")
    lines += ['', 'Per-task function success counts (all edited functions must appear in the first ten):', '']
    for task in dict.fromkeys(r['instance_id'] for r in rows):
        group = [r for r in rows if r['instance_id'] == task]
        lines.append('- ' + task + ': ' + ', '.join(f"{a}={sum(r['metrics']['functionAcc10'] for r in group if r['arm']==a)}/{sum(r['arm']==a for r in group)}" for a in dict.fromkeys(r['arm'] for r in rows)))
    if any('indexMs' in r for r in rows):
        lines += ['', 'Mean cold index preparation seconds: ' + ', '.join(f"{a}={mean(r['indexMs'] for r in rows if r['arm']==a)/1000:.3f}" for a in dict.fromkeys(r['arm'] for r in rows))]
    lines += ['', f"Attempts with extraction/provider errors: {sum(bool(r['errors']) for r in rows)}. Attempts with inventory limit: {sum(r['inventoryLimit'] for r in rows)}.", '']
ledger = json.loads((root / 'budget.json').read_text())
known = sum(r['costUSD'] or 0 for r in ledger['receipts'])
held = sum(r['reservedUSD'] for r in ledger['receipts'] if r['costUSD'] is None)
lines += [f'Cumulative authorized experiment ledger: ${known:.9f} reported; ${held:.9f} reserved/unknown, within the original $5 authorization. The API key independently reached its cumulative $5 limit; paid work stopped.', '']
(root / 'retrieval-results.md').write_text('\n'.join(lines))
print('\n'.join(lines))
