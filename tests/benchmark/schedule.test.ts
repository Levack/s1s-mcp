import { it, expect } from 'vitest';
import { runPairs } from '../../benchmark/schedule.js';
import { paramsSchema } from '../../benchmark/params.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../../benchmark/cli.js';

it('limits overlapping tasks while preserving sequential arms and alternating order for each pair', async () => {
  for (const concurrency of [1, 2]) {
    let active = 0, maximum = 0;
    const events: [number, string][] = [];
    const activeTasks = new Set<number>();
    await runPairs([0, 1, 2, 3], 0, { concurrency, seed: 42 }, async (task, _index, arm) => {
      expect(activeTasks.has(task)).toBe(false);
      activeTasks.add(task);
      maximum = Math.max(maximum, ++active);
      events.push([task, arm]);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      activeTasks.delete(task);
    });
    expect(maximum).toBe(concurrency);
    for (const task of [0, 1, 2, 3]) expect(events.filter(e => e[0] === task).map(e => e[1])).toEqual(task % 2 ? ['s1s', 'baseline'] : ['baseline', 's1s']);
  }
  expect(() => paramsSchema.parse({ concurrency: 0 })).toThrow();
  expect(() => paramsSchema.parse({ concurrency: 33 })).toThrow();
});

it('persists every prediction and counter across concurrent pairs and repetitions', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 's1s-parallel-'));
  try {
    await run(paramsSchema.parse({ bench: 'loc-bench', range: '1-6', concurrency: 3, repetitions: 2, dryRun: true, output }));
    const attempts = JSON.parse(await readFile(path.join(output, 'attempts.json'), 'utf8'));
    expect(attempts).toHaveLength(24);
    expect(attempts.every((a: { status: string }) => a.status === 'submitted')).toBe(true);
    expect(new Set(attempts.map((a: { instance_id: string; arm: string; repetition: number }) => `${a.instance_id}:${a.arm}:${a.repetition}`)).size).toBe(24);
    for (const repetition of [0, 1]) for (const arm of ['baseline', 's1s']) {
      const predictions = (await readFile(path.join(output, `${arm}-${repetition}.predictions.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(predictions).toHaveLength(6);
      expect(new Set(predictions.map(p => p.instance_id)).size).toBe(6);
    }
    const result = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
    expect(result.summary).toMatchObject([{ solverCalls: 24, totalApiCalls: 24, mcpCalls: 0 }, { solverCalls: 24, s1sProviderCalls: 0, totalApiCalls: 24, mcpCalls: 0 }]);
  } finally { await rm(output, { recursive: true, force: true }); }
});
