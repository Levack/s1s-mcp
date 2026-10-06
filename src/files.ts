import { constants } from 'node:fs';
import { glob, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';

const hidden = new Set(['.git', '.aws', '.ssh', '.s1s', '.s1s-mcp', 'node_modules', '.codex', '.agents', '.npmrc', '.netrc']);
export function isSensitive(file: string) {
  return file.split(/[\\/]/).some(part => hidden.has(part) || /^\.env(?:\.|$)/i.test(part)
    || /^(?:credentials|secrets?)(?:\.|$)/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));
}
export async function allowedPath(file: string, roots: string[]) {
  const resolved = await realpath(path.resolve(file));
  const canonicalRoots = await Promise.all(roots.map(root => realpath(path.resolve(root))));
  if (!canonicalRoots.some(root => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  })) throw new Error('File is outside configured roots');
  if (isSensitive(file) || isSensitive(resolved)) throw new Error('Sensitive file is excluded');
  return resolved;
}
export async function readCandidate(file: string, config: Config) {
  const resolved = await allowedPath(file, config.roots);
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Candidate must be a regular file');
    if (info.size > config.maxFileBytes) throw new Error(`File exceeds maxFileBytes (${config.maxFileBytes}); send an explicit excerpt instead`);
    const buffer = Buffer.alloc(config.maxFileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > config.maxFileBytes) throw new Error('File exceeds maxFileBytes');
    const data = buffer.subarray(0, bytesRead);
    if (data.includes(0)) throw new Error('Binary files are unsupported; provide extracted text');
    return { path: resolved, content: new TextDecoder('utf-8', { fatal: true }).decode(data) };
  } finally { await handle.close(); }
}
export async function discoverFiles(config: Config, patterns: string[], limit: number) {
  if (patterns.some(p => path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('Patterns must be relative to configured roots');
  const found: { path: string; bytes: number }[] = [];
  const seen = new Set<string>();
  const included = patterns.filter(pattern => !pattern.startsWith('!'));
  const excluded = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));
  for (const root of config.roots) {
    const entries = glob(included, { cwd: root, withFileTypes: true,
      exclude: entry => entry.name.startsWith('.') || entry.name === 'dist'
        || isSensitive(entry.name) || entry.isSymbolicLink()
        || excluded.some(pattern => path.matchesGlob(path.relative(root, path.join(entry.parentPath, entry.name)), pattern)) });
    for await (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const file = await allowedPath(path.join(entry.parentPath, entry.name), config.roots);
        if (seen.has(file)) continue;
        seen.add(file);
        found.push({ path: file, bytes: (await stat(file)).size });
        if (found.length >= limit) return { files: found, limitReached: true };
      } catch { /* Excluded or inaccessible paths are not candidates. */ }
    }
  }
  return { files: found, limitReached: false };
}
