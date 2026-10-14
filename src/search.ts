import { z } from 'zod';
import type { Config } from './config.js';
import { discoverFiles } from './files.js';
import { Screener } from './screen.js';
import type { Evaluate } from './system-one.js';

export const searchSchema = z.strictObject({
  question: z.string().min(1).max(8000).describe('What code or evidence you need. Include the issue and the behavior to locate.'),
  files: z.array(z.string().min(1).max(512)).min(1).max(32).describe('Repository-relative paths or scoped globs, e.g. ["src/auth/**/*.py"]. The server reads and judges their contents.'),
  topK: z.number().int().min(1).max(10).default(5),
  maxFiles: z.number().int().min(1).max(80).default(40),
  snippetThreshold: z.number().min(0).max(1).default(0.5).describe('Minimum content relevance for returning a snippet. Lower-scoring paths and scores are retained; set 0 to return every snippet.'),
  snippetsPerFile: z.number().int().min(1).max(3).default(1),
  focusTerms: z.array(z.string().min(1).max(100)).max(8).optional(),
});

/** One content-search operation: discover, judge bounded source chunks, return evidence. */
export class SourceSearch {
  private screener: Screener;
  constructor(private config: Config, evaluate: Evaluate) {
    this.screener = new Screener({ ...config, maxFileBytes: Math.min(config.maxFileBytes, 6000) }, evaluate);
  }
  async search(raw: unknown, signal?: AbortSignal, progress?: (completed: number, total: number) => Promise<void>, inventory?: Awaited<ReturnType<typeof discoverFiles>>) {
    const input = searchSchema.parse(raw);
    const found = inventory ?? await discoverFiles(this.config, input.files, input.maxFiles);
    if (found.limitReached || found.files.reduce((sum, f) => sum + f.bytes, 0) > 800000) {
      return { matched: found.files.length, judged: 0, chunks: 0, limitReached: true, coverage: 'partial' as const,
        errors: [], batches: 0, models: [], usage: { input_tokens: 0, output_tokens: 0 }, durationMs: 0,
        results: [], rejected: 0,
        guidance: 'Scope exceeds the file or 800 KB content budget. No evaluation was performed. Narrow files to a relevant directory or explicit candidate paths; this is not a negative search result.' };
    }
    const { snippetThreshold, snippetsPerFile, focusTerms, ...screenInput } = input;
    const result = await this.screener.filter({ ...screenInput, threshold: 0,
      yes: 'This source contains implementation or evidence useful for answering the search question, including a relevant dependency.',
      no: 'This source has no useful implementation or evidence for the search question.' }, signal, progress, true, { inventory: found, snippetsPerFile, focusTerms, capacityBatching: true });
    return { ...result, results: result.results.map(row => row.probability !== null && row.probability < snippetThreshold
      ? { ...row, snippet: undefined, additionalSnippets: undefined, snippetOmitted: true }
      : { ...row, ...(row.additionalSnippets ? { additionalSnippets: row.additionalSnippets.filter(s => s.probability >= snippetThreshold) } : {}) }),
      guidance: 'Ranked source evidence, not a proof of correctness. Lower-scoring snippets are omitted but their paths, scores and line ranges remain available; read them or set snippetThreshold=0 if needed. Snippets are chunks, not necessarily complete symbols. Low scores or missing files do not establish irrelevance. Follow dependencies and expand scope when needed.' };
  }
}
