import { z } from 'zod';
import type { Config } from './config.js';
import { listPathEntries } from './files.js';
import { Screener } from './screen.js';

export const exploreSchema = z.strictObject({
  question: z.string().min(1).max(8000).describe('What directory metadata you need. For locating code relevant to an issue, use search_code or find_files.'),
  mode: z.enum(['list', 'rank']).default('list').describe('list returns metadata without provider calls. Use rank only when names are ambiguous and optional name relevance scoring would help.'),
  directReadBytes: z.number().int().min(1).max(2_000_000).default(8192).describe('Advisory size threshold in bytes: short files suggest direct reading; longer files suggest screening only if relevance is uncertain.'),
  scope: z.string().max(512).default('.').describe('Repository-relative directory to expand, e.g. . then django then django/contrib/auth. No glob patterns.'),
  offset: z.number().int().min(0).default(0).describe('Use nextOffset from a previous result to inspect the next page of this directory.'),
  limit: z.number().int().min(1).max(128).default(64).describe('Number of immediate entries per page. Contents are not read.'),
});

export class PathExplorer {
  constructor(private readonly config: Config, private readonly screener: Screener) {}

  async explore(raw: unknown, signal?: AbortSignal, progress?: (completed: number, total: number) => Promise<void>) {
    const started = performance.now();
    const input = exploreSchema.parse(raw);
    signal?.throwIfAborted();
    const { entries: page, totalEntries } = await listPathEntries(this.config, input.scope, input.offset, input.limit);
    const result = input.mode === 'rank' && page.length ? await this.screener.filter({
      question: input.question,
      yes: 'Based only on the path and entry type, this could be a useful place to inspect for the question, including indirect dependencies and tests. This is a navigation hint, not a content judgment.',
      no: 'The name suggests little connection to the question. An uncertain name is not proof that this location is irrelevant.',
      texts: page.map(entry => ({ id: entry.path, content: `${entry.kind === 'directory' ? 'Directory' : 'File'}: ${entry.path}` })),
      threshold: 0, topK: input.limit,
    }, signal, progress, false, { capacityBatching: true }) : { results: [], rejected: 0, matched: 0, judged: 0, chunks: 0, limitReached: false,
      errors: [], batches: 0, models: [], usage: { input_tokens: 0, output_tokens: 0 }, durationMs: 0 };
    const scores = new Map(result.results.map(item => ['id' in item ? item.id : '', item.probability]));
    const candidates = page.map(entry => ({ ...entry,
      recommendedAction: entry.kind === 'directory' ? 'expand' : (entry.bytes ?? 0) <= input.directReadBytes ? 'read_directly' : 'screen_if_uncertain',
      ...(input.mode === 'rank' ? { probability: scores.get(entry.path) ?? null } : {}),
    }))
      .sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1));
    const nextOffset = input.offset + page.length < totalEntries ? input.offset + page.length : null;
    const { results: _results, rejected: _rejected, ...stats } = result;
    return { ...stats, durationMs: performance.now() - started, matched: page.length, mode: input.mode, directReadBytes: input.directReadBytes, scope: input.scope, totalEntries, nextOffset, listingComplete: nextOffset === null,
      candidates, guidance: 'Choose paths yourself using names and sizes. Expand directories; read short files directly with your read/shell tool. Use content screening for long candidates only when their relevance is uncertain; read a known target or exact symbol directly even in a long file. Size is an advisory heuristic, not a relevance or text-format judgment. Optional rank mode scores names only and retains all page entries. Follow dependencies and later pages when needed.' };
  }
}
