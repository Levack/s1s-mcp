import { z } from 'zod';
import { Screener } from './screen.js';

export const rankPathsSchema = z.strictObject({
  question: z.string().min(1).max(8000).describe('The issue or search goal for which to rank these file paths.'),
  paths: z.array(z.string().trim().min(1).max(512)).min(1).max(512)
    .refine(paths => new Set(paths).size === paths.length, 'Paths must be unique')
    .describe('Explicit file path names, not glob patterns. Used as text only: files need not exist and no filesystem access is performed.'),
  topK: z.number().int().min(1).max(512).default(512)
    .describe('Maximum results; defaults to retaining all submitted paths, including low and missing scores.'),
});

export class PathRanker {
  constructor(private readonly screener: Screener) {}

  async rank(raw: unknown, signal?: AbortSignal, progress?: (completed: number, total: number) => Promise<void>) {
    const input = rankPathsSchema.parse(raw);
    const result = await this.screener.filter({
      question: input.question,
      yes: 'Based only on this file path, this could be useful to inspect for the question, including indirect dependencies and tests. This is a navigation hint, not a content judgment.',
      no: 'The file path suggests little connection to the question. An uncertain name is not proof that the file is irrelevant.',
      texts: input.paths.map((file, index) => ({ id: `p${index}`, content: `File: ${file}` })),
      threshold: 0, topK: input.paths.length,
    }, signal, progress, false, { capacityBatching: true });
    const scores = new Map(result.results.map(item => ['id' in item ? item.id : '', item.probability]));
    const ranked = input.paths.map((file, index) => ({ path: file, score: scores.get(`p${index}`) ?? null }))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const { results: _results, rejected: _rejected, ...stats } = result;
    return { ...stats,
      errors: stats.errors.map(error => ({ ...error, id: input.paths[Number(error.id.split('#')[0]!.slice(1))] ?? error.id })),
      results: ranked.slice(0, input.topK), omitted: Math.max(0, ranked.length - input.topK),
      basis: 'path_only',
      guidance: 'Scores from 0 to 1 estimate relevance using names only, not file contents. Missing evaluations have score null, not zero. Read promising files and follow dependencies; low scores do not prove irrelevance.',
    };
  }
}
