import pLimit from 'p-limit';
import type { Params } from './params.js';
import type { Arm } from './agent.js';

export async function runPairs<T>(tasks: T[], repetition: number, params: Pick<Params, 'concurrency' | 'seed'>,
  attempt: (task: T, index: number, arm: Arm, order: number) => Promise<void>) {
  const limit = pLimit(params.concurrency);
  await Promise.all(tasks.map((task, index) => limit(async () => {
    const arms: Arm[] = (index + repetition + params.seed) % 2 ? ['s1s', 'baseline'] : ['baseline', 's1s'];
    for (const [order, arm] of arms.entries()) await attempt(task, index, arm, order);
  })));
}
