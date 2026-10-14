import { z } from 'zod';

export const localizationSchema = z.strictObject({
  files: z.array(z.string().min(1)).max(10),
  functions: z.array(z.string().regex(/^.+\.py:.+$/)).max(15),
});
export type Localization = z.infer<typeof localizationSchema>;
export const metricNames = ['fileAcc5', 'fileAcc10', 'functionAcc10', 'functionAcc15'] as const;
export type LocalizationMetrics = Record<typeof metricNames[number], boolean>;

const normalize = (value: string) => value.trim().replace(/^(?:\/testbed\/|\.\/)/, '').replace(/\.__init__$/, '');
export function gradeLocalization(gold: string[], prediction?: Localization): LocalizationMetrics {
  if (!gold.length) throw new Error('Loc-Bench task has no edited functions');
  const functions = [...new Set(gold.map(normalize))];
  const files = [...new Set(functions.map(f => f.split(':')[0]!))];
  const containsAll = (expected: string[], candidates: string[], k: number) => {
    const top = new Set([...new Set(candidates.map(normalize))].slice(0, k));
    return expected.every(item => top.has(item));
  };
  return {
    fileAcc5: containsAll(files, prediction?.files ?? [], 5),
    fileAcc10: containsAll(files, prediction?.files ?? [], 10),
    functionAcc10: containsAll(functions, prediction?.functions ?? [], 10),
    functionAcc15: containsAll(functions, prediction?.functions ?? [], 15),
  };
}
