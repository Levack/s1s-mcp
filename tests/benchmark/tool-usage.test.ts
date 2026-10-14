import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordTool, toolsFromTrace, type Tools } from '../../benchmark/tool-usage.js';
import { writeReport, type Attempt } from '../../benchmark/report.js';
import { Ledger } from '../../benchmark/accounting.js';

it('reports new tool names without schema changes and reconstructs historical runs from traces', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-tool-report-'));
  const event = (name: string, durationMs: number, result: unknown) => ({ kind: 'tool', name, durationMs, result });
  const empty = new Ledger().snapshot();
  const attempt: Attempt = { instance_id: 'test-1', arm: 's1s', repetition: 0, order: 0,
    status: 'submitted', setupMs: 0, solveMs: 1000, steps: 2, mcpCalls: 1, mcpErrors: 1, llm: empty, s1s: empty };
  try {
    await mkdir(path.join(dir, 'traces'));
    const trace = path.join(dir, 'traces/test-1-0-s1s.jsonl');
    await writeFile(trace, [
      { kind: 'completion' }, { kind: 's1s_provider' },
      event('new_tool_v2', 100, { isError: true }), event('new_tool_v2', 50, { isError: false }),
      event('bash', 20, 'exit=1\nfailed'), event('bash', 30, 'exit=0\nsuccess'), event('finish', 1, 'Submitted'),
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    expect(await toolsFromTrace(trace)).toEqual({
      new_tool_v2: { calls: 2, errors: 1, durationMs: 150 },
      bash: { calls: 2, errors: 1, durationMs: 50 }, finish: { calls: 1, errors: 0, durationMs: 1 },
    });
    expect(await toolsFromTrace(path.join(dir, 'missing.jsonl'))).toEqual({});
    await writeFile(path.join(dir, 'traces/test-pending-0-s1s.jsonl'), '{"kind":');
    await writeFile(path.join(dir, 'attempts.json'), JSON.stringify([attempt, { ...attempt, instance_id: 'test-pending', status: 'pending' }, { ...attempt, instance_id: 'test-2', tools: {
      new_tool_v2: { calls: 1, errors: 0, durationMs: 200 },
    } }]));
    await writeFile(path.join(dir, 'params.json'), JSON.stringify({ bench: 'swe-bench-mini' }));
    const summary = await writeReport(dir);
    expect(summary[1]!.tools).toEqual({
      new_tool_v2: { calls: 3, errors: 1, durationMs: 350, usedAttempts: 2 },
      bash: { calls: 2, errors: 1, durationMs: 50, usedAttempts: 1 },
      finish: { calls: 1, errors: 0, durationMs: 1, usedAttempts: 1 },
    });
    const saved = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8'));
    expect(saved.rows[0].tools.new_tool_v2.calls).toBe(2);
    expect(saved.rows[1].tools).toEqual({});
    expect((await readFile(path.join(dir, 'results.md'), 'utf8'))).toContain('| s1s | new_tool_v2 | 3 | 1 | 2 | 0.350 |');
    const csv = await readFile(path.join(dir, 'results.csv'), 'utf8');
    expect(csv.split('\n')[0]).toContain('"tools"');
    expect(csv.split('\n')[0]).not.toContain('new_tool_v2');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('counts transport and argument failures independently of successful tool results', () => {
  const tools: Tools = Object.create(null);
  recordTool(tools, 'constructor', 4, { error: 'Invalid arguments' });
  recordTool(tools, 'constructor', 3, { results: [] });
  recordTool(tools, '__proto__', 2, { error: 'Timeout' });
  expect(tools.constructor).toEqual({ calls: 2, errors: 1, durationMs: 7 });
  expect(tools.__proto__).toEqual({ calls: 1, errors: 1, durationMs: 2 });
});
