import { z } from 'zod';
import ignore from 'ignore';
import type { Config } from './config.js';
import type { Evaluate } from './system-one.js';
import { discoverFiles } from './files.js';
import { FileFinder } from './find.js';
import { SourceSearch } from './search.js';
import { searchLiteral } from './literal-search.js';

export const folderSearchSchema = z.strictObject({
  question: z.string().min(1).max(8000).describe('The question or issue you need evidence to answer. Include the behavior and relevant context.'),
  root_folder: z.string().min(1).max(512).default('.').describe('Repository-relative folder, e.g. src/auth. Omit for the whole repository (.). Never pass an absolute filesystem path or a filename. Returned paths are repository-relative.'),
  gitignore: z.string().max(16000).optional().describe('Optional exclusion rules as .gitignore text, separated by newlines, relative to root_folder. Supports comments, directory rules, and ! negation. This is pattern text, not a path to a file. Omit for normal server exclusions only.'),
});

export const contentSearchSchema = folderSearchSchema.extend({
  literal: z.string().min(1).max(256).refine(value => !/[\r\n]/.test(value), 'Use single-line text').optional()
    .describe('Known exact symbol or text, e.g. get_data_layer. Searches locally and returns matching lines with context, with ZERO model calls or provider cost. Case-sensitive, not a regex. Omit for semantic content evaluation.'),
  files: z.array(z.string().min(1).max(512)).min(1).max(32).optional()
    .describe('Optional paths/globs within root_folder. Returned repository-relative paths beginning with root_folder are also accepted unchanged. Use root_folder="." for candidates from different folders. Omit for all files in the folder.'),
  topK: z.number().int().min(1).max(10).default(5)
    .describe('Maximum files to return with source chunks. Use a small value when you only need the best evidence; all matching contents are still evaluated.'),
});

export const nameSearchSchema = folderSearchSchema.extend({
  inspect: z.boolean().default(false)
    .describe('Set true to also read and evaluate the top three candidate files, returning source chunks in this same call. Useful when locating implementation rather than only filenames. Only shortlisted contents are read; follow other candidates if needed.'),
});

export class FolderSearch {
  private readonly names: FileFinder;
  private readonly contents: SourceSearch;
  constructor(private readonly config: Config, evaluate: Evaluate) {
    this.names = new FileFinder(config, evaluate);
    this.contents = new SourceSearch(config, evaluate);
  }
  async search(raw: unknown, mode: 'names' | 'contents', signal?: AbortSignal,
    progress?: (completed: number, total: number) => Promise<void>) {
    const content = mode === 'contents' ? contentSearchSchema.parse(raw) : undefined;
    const names = mode === 'names' ? nameSearchSchema.parse(raw) : undefined;
    const input = content ?? names!;
    signal?.throwIfAborted();
    const rules = ignore().add(input.gitignore ?? '');
    const scope = input.root_folder.replace(/^\.\//, '').replace(/\/$/, '');
    const files = (content?.files ?? ['**/*']).map(pattern => {
      const negative = pattern.startsWith('!');
      const value = negative ? pattern.slice(1) : pattern;
      // Name results are repository-relative. Accept those unchanged even when
      // the caller also supplies their containing folder.
      const relative = scope !== '.' && scope && value.startsWith(`${scope}/`) ? value.slice(scope.length + 1) : value;
      return `${negative ? '!' : ''}${relative}`;
    });
    const found = await discoverFiles(this.config, files, mode === 'names' || content?.literal ? 5000 : 80, input.root_folder,
      (relative, directory) => rules.ignores(relative + (directory ? '/' : '')));
    signal?.throwIfAborted();
    if (content?.literal) return { ...await searchLiteral(this.config, found, content.literal, content.topK, signal), root_folder: input.root_folder };
    if (mode === 'names') {
      const result = await this.names.find({ question: input.question, topK: 20, inspect: names?.inspect }, signal, progress, found);
      return { ...result, root_folder: input.root_folder,
        guidance: result.limitReached
          ? 'More than 5000 eligible files. No evaluation was performed. Narrow root_folder or add gitignore exclusions.'
          : names?.inspect ? result.guidance
            : 'All eligible filenames were evaluated; the highest-ranked paths are returned. Names are navigation hints, not content evidence. Read promising files or use search_file_contents on a relevant folder. Null means unknown.' };
    }
    const result = await this.contents.search({ question: input.question, files, maxFiles: 80,
      topK: content?.topK ?? 5 }, signal, progress, found);
    return { ...result, coverage: result.limitReached || result.errors.length ? 'partial' as const : 'complete' as const, root_folder: input.root_folder,
      guidance: result.limitReached
        ? 'The folder exceeds 80 files or 800 KB. No content evaluation was performed. Narrow root_folder or add gitignore exclusions. search_file_names can locate promising paths using names alone.'
        : 'Files were evaluated using their actual contents. Results identify files containing evidence worth reading, with their best source chunks. Low-relevance snippets may be omitted while paths remain available. Chunks may omit surrounding context; read and verify selected files. Failed reads or judgments remain in errors.' };
  }
}
