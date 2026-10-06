import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { discoverFiles, readCandidate } from '../src/files.js';

it('discovers brace/glob matches, deduplicates roots, and excludes sensitive paths and symlinks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-discovery-'));
  const outside = await mkdtemp(path.join(tmpdir(), 's1s-outside-'));
  try {
    for (const folder of ['src', 'docs', 'node_modules', 'dist', '.hidden', '.git', '.s1s-mcp']) {
      await mkdir(path.join(dir, folder));
      await writeFile(path.join(dir, folder, 'sample.ts'), 'sample');
    }
    await writeFile(path.join(dir, 'docs', 'guide.md'), 'guide');
    await writeFile(path.join(dir, '.env'), 'placeholder');
    await writeFile(path.join(dir, 'credentials.json'), '{}');
    await writeFile(path.join(outside, 'escape.ts'), 'outside');
    await symlink(outside, path.join(dir, 'linked'));
    await symlink(path.join(dir, 'src', 'sample.ts'), path.join(dir, 'alias.ts'));
    const config = configSchema.parse({ roots: [dir, dir] });
    await expect(readCandidate(path.join(dir, '.s1s-mcp', 'sample.ts'), config)).rejects.toThrow('Sensitive file');
    const result = await discoverFiles(config, ['**/*.{ts,md}', '*.json', '.env'], 100);
    expect(result.files.map(file => path.relative(dir, file.path)).sort()).toEqual(['docs/guide.md', 'docs/sample.ts', 'src/sample.ts']);
    expect(result.limitReached).toBe(false);
    expect((await discoverFiles(config, ['**/*.ts', '!docs/**'], 100)).files.map(file => path.relative(dir, file.path))).toEqual(['src/sample.ts']);
    expect((await discoverFiles(config, ['**/*.ts'], 1)).files).toHaveLength(1);
    expect((await discoverFiles(config, ['**/*.ts'], 1)).limitReached).toBe(true);
    await expect(discoverFiles(config, ['../*.ts'], 100)).rejects.toThrow('relative');
    await expect(discoverFiles(config, [path.join(dir, '*.ts')], 100)).rejects.toThrow('relative');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
