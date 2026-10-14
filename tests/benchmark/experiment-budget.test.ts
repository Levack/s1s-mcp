import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExperimentBudget } from '../../benchmark/experiments/budget.js';

it('reserves concurrent calls before dispatch and persists every settled cost', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'parallel-budget-'));
  try {
    const file = path.join(dir, 'budget.json');
    const budget = await ExperimentBudget.open(file, 1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let dispatched = 0;
    const invoke = (label: string) => budget.call(label, 0.4, async () => {
      dispatched++;
      await gate;
      return { cost: 0.2 };
    }, result => result.cost);
    const first = invoke('first');
    const second = invoke('second');
    await expect(invoke('over-limit')).rejects.toThrow('Experiment budget stopped');
    expect(budget.spentUSD).toBeCloseTo(0.8);
    release();
    await Promise.all([first, second]);
    expect(dispatched).toBe(2);
    expect(budget.spentUSD).toBeCloseTo(0.4);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.receipts.map((r: { costUSD: number }) => r.costUSD)).toEqual([0.2, 0.2]);
    expect((await ExperimentBudget.open(file, 1)).spentUSD).toBeCloseTo(0.4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
