import path from 'node:path';
import type { Config } from './config.js';
import { readTextChunks, type discoverFiles } from './files.js';
import { safeError } from './system-one.js';

/** Exact, case-sensitive local search. It makes no relevance judgments or provider requests. */
export async function searchLiteral(config: Config, found: Awaited<ReturnType<typeof discoverFiles>>,
  literal: string, topK: number, signal?: AbortSignal) {
  const started = performance.now();
  const errors: { id: string; error: string }[] = [];
  const results: { path: string; lines: [number, number]; snippet: string; matchingLines: number }[] = [];
  const limitReached = found.limitReached || found.files.reduce((sum, file) => sum + file.bytes, 0) > 32_000_000;
  let matchingFiles = 0;
  if (!limitReached) for (const file of [...found.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    signal?.throwIfAborted();
    const root = config.roots.find(root => {
      const relative = path.relative(path.resolve(root), file.path);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    const relative = root ? path.relative(path.resolve(root), file.path).split(path.sep).join('/') : file.path;
    try {
      // The existing reader enforces roots, sensitive-file exclusions, binary rejection,
      // change-during-read detection and the 2 MB per-file limit.
      const chunks = await readTextChunks(file.path, config, 2_000_001);
      const lines = chunks.flatMap(chunk => chunk.text.split('\n'));
      const matches = lines.flatMap((line, index) => line.includes(literal) ? [index] : []);
      if (!matches.length) continue;
      matchingFiles++;
      if (results.length < topK) {
        const first = Math.max(0, matches[0]! - 6), last = Math.min(lines.length, matches[0]! + 13);
        // Bound individual lines too: generated/minified text must not inflate the response.
        const snippet = lines.slice(first, last).map(line => {
          if (line.length <= 500) return line;
          const start = Math.max(0, line.indexOf(literal) - 100);
          return `${start ? '… ' : ''}${line.slice(start, start + 500)}${start + 500 < line.length ? ' …' : ''}`;
        }).join('\n');
        results.push({ path: relative, lines: [first + 1, last], snippet, matchingLines: matches.length });
      }
    } catch (error) { errors.push({ id: relative, error: safeError(error) }); }
  }
  return { basis: 'literal' as const, literal, results, matchingFiles, omitted: matchingFiles - results.length,
    matched: found.files.length, judged: 0, chunks: 0, batches: 0, models: [], errors, limitReached,
    coverage: limitReached || errors.length ? 'partial' as const : 'complete' as const,
    usage: { input_tokens: 0, output_tokens: 0, cost: 0 }, durationMs: performance.now() - started,
    guidance: limitReached ? 'Exact-search scope exceeds 5000 files or 32 MB. Narrow files/root_folder or add gitignore exclusions. No contents were searched.'
      : 'Exact case-sensitive text matches, in path order, with context around the first matching line. No relevance model was called. Results are not relevance-ranked; more matches may be omitted. Long lines may be shortened around the match. Read further context or omit literal for semantic evaluation.' };
}
