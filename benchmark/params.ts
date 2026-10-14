import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const benches = {
  'swe-bench-mini': { name: 'SWE-bench Verified Mini', dataset: 'MariusHobbhahn/swe-bench-verified-mini', size: 50 },
  'loc-bench': { name: 'Loc-Bench V1', dataset: 'czlll/Loc-Bench_V1', size: 560 },
} as const;

export function parseRange(value: string, size: number): number[] {
  const numbers = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^([1-9]\d*)(?:\s*-\s*([1-9]\d*))?$/.exec(part.trim());
    if (!match) throw new Error('Use task numbers such as 1-10 or 1,3,5-8');
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (first > last || last > size) throw new Error(`Task numbers must be within 1-${size}, with ascending ranges`);
    for (let number = first; number <= last; number++) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b);
}

const pricing = z.strictObject({ inputUSDPerMillion: z.number().nonnegative(), outputUSDPerMillion: z.number().nonnegative() });
const positive = z.number().int().positive();
export const paramsSchema = z.strictObject({
  mode: z.enum(['run', 'prepare', 'report']).default('run'),
  dryRun: z.boolean().default(false),
  model: z.string().min(1).default('qwen/qwen3-coder-next'),
  solverPricing: pricing.optional(),
  baseURL: z.url().default('https://openrouter.ai/api/v1'),
  apiKeyEnv: z.string().default('OPENROUTER_API_KEY'),
  bench: z.enum(['swe-bench-mini', 'loc-bench']).default('swe-bench-mini'),
  dataset: z.enum(['MariusHobbhahn/swe-bench-verified-mini', 'czlll/Loc-Bench_V1']).optional(),
  revision: z.string().min(1).default('main'),
  limit: positive.max(560).default(50),
  range: z.string().min(1).optional(),
  instanceIds: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)).min(1).refine(ids => new Set(ids).size === ids.length, 'Instance IDs must be unique').optional(),
  concurrency: positive.max(32).default(1),
  repetitions: positive.max(20).default(1),
  maxSteps: positive.max(1000).default(60),
  maxOutputTokens: positive.default(4096),
  timeoutSeconds: positive.default(1200),
  commandTimeoutSeconds: positive.default(120),
  requestTimeoutSeconds: positive.default(180),
  gradingTimeoutSeconds: positive.default(1200),
  temperature: z.number().min(0).max(2).default(0),
  seed: z.number().int().nonnegative().default(42),
  cpus: z.number().positive().default(2),
  memory: z.string().regex(/^\d+[mg]$/i).default('4g'),
  pidsLimit: positive.default(256),
  pullImages: z.boolean().default(true),
  output: z.string().min(1).optional(),
  s1s: z.strictObject({
    provider: z.literal('openrouter').optional(),
    model: z.string().min(1).optional(),
    concurrency: positive.max(32).default(4),
    batchSize: positive.max(64).default(8),
    timeout: positive.max(300000).default(30000),
    pricing: pricing.optional(),
  }).default({ concurrency: 4, batchSize: 8, timeout: 30000 }),
}).superRefine((value, ctx) => {
  if (value.range && value.instanceIds) ctx.addIssue({ code: 'custom', path: ['range'], message: 'Choose range or instanceIds, not both' });
  if (value.range) {
    try { parseRange(value.range, benches[value.bench].size); }
    catch (error) { ctx.addIssue({ code: 'custom', path: ['range'], message: (error as Error).message }); }
  }
  if (value.limit > benches[value.bench].size) ctx.addIssue({ code: 'custom', path: ['limit'], message: `Limit exceeds ${benches[value.bench].size} tasks for ${value.bench}` });
  if (value.dataset && value.dataset !== benches[value.bench].dataset) ctx.addIssue({ code: 'custom', path: ['dataset'], message: 'Dataset does not match bench' });
}).transform(value => ({ ...value, dataset: benches[value.bench].dataset }));
export type Params = z.infer<typeof paramsSchema>;
export function taskCount(params: Params) {
  return params.range ? parseRange(params.range, benches[params.bench].size).length : params.instanceIds?.length ?? params.limit;
}
export async function readParams(value?: string): Promise<Params> {
  const raw = value ? JSON.parse(value.trim().startsWith('{') ? value : await readFile(value, 'utf8')) : {};
  return paramsSchema.parse({ model: process.env.BENCH_MODEL, ...raw });
}
