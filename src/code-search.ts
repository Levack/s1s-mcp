import path from 'node:path';
import ignore from 'ignore';
import type { Config } from './config.js';
import type { Evaluate } from './system-one.js';
import { discoverFiles, readTextChunks } from './files.js';
import { FileFinder } from './find.js';
import { SourceSearch } from './search.js';
import { folderSearchSchema } from './folder-search.js';

export const codeSearchSchema = folderSearchSchema;

/** One client call: discover candidates, select files, inspect contents, return source evidence. */
export class CodeSearch {
  private names: FileFinder;
  private contents: SourceSearch;
  constructor(private config: Config, evaluate: Evaluate) {
    this.names = new FileFinder(config, evaluate);
    this.contents = new SourceSearch({ ...config, maxFileBytes: 3000 }, evaluate);
  }
  async search(raw: unknown, signal?: AbortSignal) {
    const input = codeSearchSchema.parse(raw);
    const started = performance.now();
    const rules = ignore().add(input.gitignore ?? '');
    const inventory = await discoverFiles(this.config, ['**/*'], 5000, input.root_folder,
      (relative, directory) => rules.ignores(relative + (directory ? '/' : '')));
    signal?.throwIfAborted();
    const bytes = inventory.files.reduce((sum, file) => sum + file.bytes, 0);
    if (!inventory.limitReached && inventory.files.length <= 12 && bytes <= 200000) {
      const result = await this.contents.search({ question: input.question, files: ['**/*'], maxFiles: 80,
        topK: 5, snippetsPerFile: 2 }, signal, undefined, inventory);
      return { ...result, basis: 'all_scoped_contents', retrievalComplete: !result.limitReached && !result.errors.length,
        durationMs: performance.now() - started };
    }
    // Exact identifiers supplied by the caller can locate implementation even
    // when a filename (for example __init__.py) carries little semantic meaning.
    const tokens = [...new Set(input.question.match(/\b[A-Za-z]\w*_\w+\b/g) ?? [])]
      .filter(token => token.length >= 4 && token.length <= 100).slice(0, 8);
    const hits: { file: typeof inventory.files[number]; definitions: number; occurrences: number }[] = [];
    const symbolFiles = inventory.files.filter(file => /\.(?:py|[cm]?jsx?|tsx?|go|rs|java|c|cpp|h|hpp|rb|php|cs)$/.test(file.path));
    if (!inventory.limitReached && symbolFiles.reduce((sum, file) => sum + file.bytes, 0) <= 32_000_000 && tokens.length) {
      for (let offset = 0; offset < symbolFiles.length; offset += 16) {
        signal?.throwIfAborted();
        const scanned = await Promise.all(symbolFiles.slice(offset, offset + 16).map(async file => {
          try {
            const text = (await readTextChunks(file.path, this.config, 2_000_001)).map(chunk => chunk.text).join('\n');
            const matched = tokens.filter(token => text.includes(token));
            if (!matched.length) return undefined;
            const definitions = matched.filter(token => new RegExp(`(?:def|class|function)\\s+_?${token}\\b`).test(text)).length;
            return { file, definitions, occurrences: matched.length };
          } catch { return undefined; } // Local hints only; selected content reads still report errors.
        }));
        hits.push(...scanned.filter((hit): hit is NonNullable<typeof hit> => Boolean(hit)));
      }
    }
    hits.sort((a, b) => b.definitions - a.definitions || b.occurrences - a.occurrences || (a.file.path < b.file.path ? -1 : 1));
    const exact = hits.some(hit => hit.definitions > 0);
    const ranked = exact ? undefined : await this.names.find({ question: input.question, topK: 20 }, signal, undefined, inventory);
    const relative = (file: typeof inventory.files[number]) => {
      const root = this.config.roots.find(root => {
        const p = path.relative(path.resolve(root), file.path);
        return p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p);
      });
      return root ? path.relative(path.resolve(root), file.path).split(path.sep).join('/') : file.path;
    };
    const candidatePaths = exact ? hits.slice(0, 20).map(hit => relative(hit.file))
      : ranked!.results.flatMap(candidate => 'path' in candidate ? [candidate.path] : []);
    const selected: typeof inventory.files = [];
    let selectedBytes = 0;
    for (const candidate of candidatePaths) {
      const file = inventory.files.find(file => relative(file) === candidate);
      if (!file || selectedBytes + file.bytes > 800000) continue;
      selected.push(file); selectedBytes += file.bytes;
      if (selected.length === 5) break;
    }
    const content = await this.contents.search({ question: input.question, files: ['**/*'], maxFiles: 80,
      topK: 5, snippetsPerFile: 2, focusTerms: tokens }, signal, undefined, { files: selected, limitReached: inventory.limitReached });
    // Preserve declaration text as evidence so a chunk starting inside a method
    // still has class/function names available to its consumer. This is an
    // outline, not an AST or a claim that every declaration needs modification.
    const results = await Promise.all(content.results.map(async row => {
      if (!('path' in row) || !row.path.endsWith('.py')) return row;
      const file = selected.find(file => relative(file) === row.path);
      if (!file) return row;
      try {
        const text = (await readTextChunks(file.path, this.config, 2_000_001)).map(chunk => chunk.text).join('\n');
        const declarations = text.split('\n').flatMap((line, index) => /^\s*(?:async\s+def|def|class)\s+\w+/.test(line)
          ? [`${index + 1}: ${line.slice(0, 180)}`] : []);
        return { ...row, declarations: declarations.slice(0, 64), declarationsOmitted: Math.max(0, declarations.length - 64) };
      } catch { return row; }
    }));
    const retrievalComplete = !inventory.limitReached && !ranked?.errors.length && !content.errors.length && selected.length > 0;
    return { ...content, results, basis: exact ? 'exact_symbols_then_contents' : 'names_then_contents', matched: inventory.files.length,
      judged: content.judged, nameJudgments: ranked?.judged ?? 0, inspectedFiles: selected.length,
      candidatePaths, exactSymbols: exact ? tokens : [],
      errors: [...ranked?.errors ?? [], ...content.errors], batches: (ranked?.batches ?? 0) + content.batches,
      models: [...new Set([...ranked?.models ?? [], ...content.models])],
      usage: { input_tokens: (ranked?.usage.input_tokens ?? 0) + content.usage.input_tokens,
        output_tokens: (ranked?.usage.output_tokens ?? 0) + content.usage.output_tokens,
        cost: (ranked && ranked.usage.cost === undefined) || content.usage.cost === undefined ? undefined : (ranked?.usage.cost ?? 0) + content.usage.cost },
      coverage: 'partial' as const, retrievalComplete,
      durationMs: performance.now() - started,
      guidance: (retrievalComplete ? 'Discovery and content inspection have completed in this one call. '
        : 'Retrieval is incomplete: scope limits, missing candidates or evaluation errors prevented completion. Narrow the scope or inspect the reported errors. ')
        + 'Up to five files were selected by exact identifiers or filename relevance. When supplied identifiers occur in a file, matching chunks and their neighbours are evaluated; omittedChunks counts other chunks not judged. Other candidatePaths remain unexamined. A completed retrieval is not proof that all relevant code was found. Use source chunks and declaration outlines; read further context only if required.' };
  }
}
