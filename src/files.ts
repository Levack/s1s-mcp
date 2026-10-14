import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { glob, open, realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';

const hidden = new Set(['.git', '.aws', '.ssh', '.s1s', '.s1s-mcp', 'node_modules', '.codex', '.agents', '.npmrc', '.netrc']);
export function isSensitive(file: string) {
  return file.split(/[\\/]/).some(part => hidden.has(part) || /^\.env(?:\.|$)/i.test(part)
    || /^(?:credentials|secrets?)(?:\.|$)/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));
}
export async function allowedPath(file: string, roots: string[]) {
  const canonicalRoots = await Promise.all(roots.map(root => realpath(path.resolve(root))));
  return allowedCanonicalPath(file, canonicalRoots);
}
async function allowedCanonicalPath(file: string, canonicalRoots: string[]) {
  const resolved = await realpath(path.resolve(file));
  if (!canonicalRoots.some(root => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  })) throw new Error('File is outside configured roots');
  if (isSensitive(file) || isSensitive(resolved)) throw new Error('Sensitive file is excluded');
  return resolved;
}
const maxSearchFileBytes = 2_000_000;
type TextChunks = ReturnType<typeof chunkText>;
/** Per-reader bounded LRU. Hits require validated file access and matching content. */
export class TextChunkCache {
  private entries = new Map<string, { fingerprint: string; chunks: TextChunks; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxBytes = 16_000_000) {}
  get(key: string, fingerprint: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.bytes -= entry.bytes;
    if (entry.fingerprint !== fingerprint) return;
    this.entries.set(key, entry); this.bytes += entry.bytes;
    return entry.chunks.map(chunk => ({ ...chunk }));
  }
  set(key: string, fingerprint: string, chunks: TextChunks) {
    const previous = this.entries.get(key);
    if (previous) { this.entries.delete(key); this.bytes -= previous.bytes; }
    const bytes = Buffer.byteLength(JSON.stringify(chunks)) + Buffer.byteLength(key) + 128;
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes && this.entries.size) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
    this.entries.set(key, { fingerprint, chunks: chunks.map(chunk => ({ ...chunk })), bytes }); this.bytes += bytes;
  }
}
export async function readTextChunks(file: string, config: Config, chunkBytes: number, cache?: TextChunkCache) {
  const resolved = await allowedPath(file, config.roots);
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error('Path must be a regular file');
    if (info.size > BigInt(maxSearchFileBytes)) throw new Error(`File exceeds ${maxSearchFileBytes} bytes`);
    const fingerprint = (value: typeof info) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
    const key = `${resolved}\0${chunkBytes}`;
    const data = await handle.readFile();
    if (data.length > maxSearchFileBytes) throw new Error(`File exceeds ${maxSearchFileBytes} bytes`);
    const after = await handle.stat({ bigint: true });
    if (fingerprint(info) !== fingerprint(after)) throw new Error('File changed during read; retry the search');
    // Some filesystems preserve timestamps across rapid same-size edits. Hash
    // actual bytes rather than trusting metadata to skip reads. Reuse decoding
    // and chunking only; never reuse relevance judgments.
    const version = cache ? createHash('sha256').update(data).digest('hex') : '';
    const cached = cache?.get(key, version);
    if (cached) return cached;
    if (data.includes(0)) throw new Error('Binary files are unsupported');
    const chunks = chunkText(new TextDecoder('utf-8', { fatal: true }).decode(data), chunkBytes);
    cache?.set(key, version, chunks);
    return chunks;
  } finally { await handle.close(); }
}
// Splits text into line-aligned chunks of at most chunkBytes, so large inputs are still judged in full.
export function chunkText(text: string, chunkBytes: number) {
  const lines = text.split('\n');
  const chunks: { text: string; startLine: number; endLine: number }[] = [];
  let current: string[] = [], bytes = 0, start = 1;
  const flush = (end: number) => { if (current.length) chunks.push({ text: current.join('\n'), startLine: start, endLine: end }); current = []; bytes = 0; start = end + 1; };
  for (const [index, raw] of lines.entries()) {
    let line = raw;
    while (Buffer.byteLength(line) + 1 > chunkBytes) {
      // Very long lines (minified code, data) are cut on character boundaries.
      flush(index);
      let cut = Math.min(line.length, chunkBytes);
      while (Buffer.byteLength(line.slice(0, cut)) > chunkBytes - 1) cut = Math.floor(cut * 0.9);
      chunks.push({ text: line.slice(0, cut), startLine: index + 1, endLine: index + 1 });
      line = line.slice(cut); start = index + 1;
    }
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > chunkBytes) flush(index);
    current.push(line); bytes += size;
  }
  flush(lines.length);
  return chunks.filter(chunk => chunk.text.trim());
}
export async function discoverFiles(config: Config, patterns: string[], limit: number, directory = '.', ignored?: (relative: string, directory: boolean) => boolean) {
  if (path.isAbsolute(directory) || directory.split(/[\\/]/).some(part => part === '..' || (part.startsWith('.') && part !== '.'))) {
    throw new Error('Directory must be a visible path relative to configured roots. Use root_folder="." for the repository root, not an absolute filesystem path.');
  }
  if (patterns.some(p => path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('Patterns must be relative to configured roots');
  const found: { path: string; bytes: number }[] = [];
  const seen = new Set<string>();
  const included = patterns.filter(pattern => !pattern.startsWith('!'));
  const excluded = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));
  // Cache only root resolution within this discovery call; candidates are still
  // resolved and validated individually, and reads revalidate paths separately.
  const canonicalRoots = await Promise.all(config.roots.map(root => realpath(path.resolve(root))));
  let pending: string[] = [];
  const flush = async () => {
    const candidates = await Promise.all(pending.map(async candidate => {
      try {
        const file = await allowedCanonicalPath(candidate, canonicalRoots);
        const info = await stat(file);
        return info.isFile() ? { path: file, bytes: info.size } : undefined;
      } catch { return undefined; }
    }));
    pending = [];
    for (const file of candidates) {
      if (!file || seen.has(file.path)) continue;
      seen.add(file.path);
      if (found.length >= limit) return true;
      found.push(file);
    }
    return false;
  };
  for (const configuredRoot of config.roots) {
    let root: string;
    try { root = await allowedCanonicalPath(path.join(configuredRoot, directory), canonicalRoots); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!(await stat(root)).isDirectory()) throw new Error('Directory must be a directory');
    const entries = glob(included, { cwd: root, withFileTypes: true,
      exclude: entry => entry.name.startsWith('.') || entry.name === 'dist'
        || isSensitive(entry.name) || entry.isSymbolicLink()
        || Boolean(ignored?.(path.relative(root, path.resolve(root, entry.parentPath, entry.name)).split(path.sep).join('/'), entry.isDirectory()))
        || excluded.some(pattern => path.matchesGlob(path.relative(root, path.resolve(root, entry.parentPath, entry.name)), pattern)) });
    for await (const entry of entries) {
      if (!entry.isFile()) continue;
      const candidate = path.resolve(root, entry.parentPath, entry.name);
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      // glob's exclude callback can still yield a matching file in some Node
      // traversal paths. Enforce exclusions again before metadata or evaluation.
      if (relative.split('/').some(part => part.startsWith('.') || part === 'dist')
        || isSensitive(relative) || ignored?.(relative, false)
        || excluded.some(pattern => path.matchesGlob(relative, pattern))) continue;
      pending.push(candidate);
      if (pending.length >= 16 && await flush()) return { files: found, limitReached: true };
    }
    if (pending.length && await flush()) return { files: found, limitReached: true };
  }
  return { files: found, limitReached: false };
}

// Read immediate entry names and sizes, never file contents. Stable sorting
// supports paging without provider evaluation.
export async function listPathEntries(config: Config, scope: string, offset = 0, limit = Infinity) {
  if (path.isAbsolute(scope) || scope.split(/[\\/]/).includes('..')) throw new Error('Scope must be relative to configured roots');
  if (scope.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.')) throw new Error('Hidden paths are excluded');
  const entries = new Map<string, { path: string; kind: 'file' | 'directory'; absolute: string }>();
  for (const root of config.roots) {
    let directory: string;
    try { directory = await allowedPath(path.join(root, scope), config.roots); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'dist' || isSensitive(entry.name) || entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const relative = path.join(scope, entry.name).split(path.sep).join('/');
      entries.set(relative, { path: relative, kind: entry.isDirectory() ? 'directory' : 'file', absolute: path.join(directory, entry.name) });
    }
  }
  const selected = [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).slice(offset, offset + limit);
  const page = [];
  for (let i = 0; i < selected.length; i += 8) {
    page.push(...await Promise.all(selected.slice(i, i + 8).map(async ({ absolute, ...entry }) => ({ ...entry,
      bytes: entry.kind === 'file' ? (await stat(await allowedPath(absolute, config.roots))).size : null }))));
  }
  return { entries: page, totalEntries: entries.size };
}
