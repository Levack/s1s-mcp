import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paramsSchema } from '../../benchmark/params.js';
import { selectRows } from '../../benchmark/dataset.js';
import { buildLocImage, prepareDataset, sweImage } from '../../benchmark/prepare.js';
import { currentSourceArchiveArgs, extractSourceArchive, sourceArchiveArgs } from '../../benchmark/docker.js';
import { Readable } from 'node:stream';

const exec = promisify(execFile);

it('exports the current working tree including edits and new files but excluding git history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's1s-working-tree-'));
  try {
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), 'hidden history');
    await writeFile(path.join(root, 'code.py'), 'edited working tree');
    await writeFile(path.join(root, 'new.txt'), 'untracked addition');
    const archive = await exec('tar', currentSourceArchiveArgs(root), { encoding: 'buffer' });
    const target = await mkdtemp(path.join(tmpdir(), 's1s-working-tree-copy-'));
    try {
      await extractSourceArchive(Readable.from([archive.stdout]), target);
      expect(await readFile(path.join(target, 'code.py'), 'utf8')).toBe('edited working tree');
      expect(await readFile(path.join(target, 'new.txt'), 'utf8')).toBe('untracked addition');
      await expect(readFile(path.join(target, '.git', 'config'))).rejects.toThrow();
    } finally { await rm(target, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
const row = { instance_id: 'owner__repo-1', repo: 'owner/repo', base_commit: 'a'.repeat(40), problem_statement: 'Find a bug', edit_functions: ['code.py:fix'] };

it('extracts the committed source snapshot without history and preserves file bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-export-source-'));
  const source = path.join(dir, 'source'), target = path.join(dir, 'target');
  try {
    await mkdir(source); await mkdir(target);
    const git = (...args: string[]) => exec('git', ['-C', source, ...args]);
    await git('init', '-q');
    const bytes = Buffer.from([0, 1, 255, 10]);
    await writeFile(path.join(source, 'file with spaces.bin'), bytes);
    await writeFile(path.join(source, 'code.py'), 'base source\n');
    await mkdir(path.join(source, 'nested'));
    await writeFile(path.join(source, 'nested', 'module.py'), 'nested source\n');
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    await writeFile(path.join(source, 'code.py'), 'uncommitted change\n');
    const archive = await exec('git', ['-C', source, 'archive', '--format=tar', 'HEAD'], { encoding: 'buffer' });
    await extractSourceArchive(Readable.from([archive.stdout]), target);
    expect(await readFile(path.join(target, 'code.py'), 'utf8')).toBe('base source\n');
    expect(await readFile(path.join(target, 'file with spaces.bin'))).toEqual(bytes);
    await expect(readFile(path.join(target, '.git/HEAD'))).rejects.toThrow();
    const scoped = path.join(dir, 'scoped');
    await mkdir(scoped);
    const partial = await exec('git', sourceArchiveArgs(source, ['**/*.py']), { encoding: 'buffer' });
    await extractSourceArchive(Readable.from([partial.stdout]), scoped);
    expect(await readFile(path.join(scoped, 'code.py'), 'utf8')).toBe('base source\n');
    expect(await readFile(path.join(scoped, 'nested', 'module.py'), 'utf8')).toBe('nested source\n');
    await expect(readFile(path.join(scoped, 'file with spaces.bin'))).rejects.toThrow();
    expect(() => sourceArchiveArgs(source, ['../secret'])).toThrow('relative');
    await expect(extractSourceArchive(Readable.from(['invalid archive']), target)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('selects full sorted dataset positions and IDs without truncating explicit selections', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...row, instance_id: `issue-${String(i + 1).padStart(3, '0')}` })).reverse();
  expect(selectRows(rows, paramsSchema.parse({ bench: 'loc-bench', range: '52-53,51,53', limit: 1 })).map(r => r.taskNumber)).toEqual([51, 52, 53]);
  expect(selectRows(rows, paramsSchema.parse({ instanceIds: ['issue-099', 'issue-001'], limit: 1 })).map(r => r.taskNumber)).toEqual([1, 99]);
  expect(() => selectRows(rows, paramsSchema.parse({ instanceIds: ['missing-id'] }))).toThrow('Unknown instance IDs');
});

it('keeps gold data on the host and publishes prepared tasks only after successful image preparation', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 's1s-ts-prepare-'));
  const load = async () => ({ revision: 'pinned', rows: [{ ...row, taskNumber: 1, patch: 'SECRET PATCH' }] });
  try {
    await prepareDataset(paramsSchema.parse({ bench: 'loc-bench', pullImages: false }), output, load);
    const tasks = await readFile(path.join(output, 'tasks.json'), 'utf8');
    expect(tasks).not.toContain('SECRET PATCH');
    expect(tasks).not.toContain('edit_functions');
    expect(JSON.parse(await readFile(path.join(output, 'dataset.json'), 'utf8')).revision).toBe('pinned');
    await rm(path.join(output, 'tasks.json'));
    await expect(prepareDataset(paramsSchema.parse({}), output, load, vi.fn(async () => { throw new Error('Docker unavailable'); }))).rejects.toThrow('Docker unavailable');
    await expect(readFile(path.join(output, 'tasks.json'))).rejects.toThrow();
    expect(sweImage('django__django-123')).toBe('swebench/sweb.eval.x86_64.django_1776_django-123:latest');
  } finally { await rm(output, { recursive: true, force: true }); }
});

it('archives only the requested commit and excludes source history from the image context', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 's1s-ts-archive-'));
  try {
    const repo = path.join(output, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) => exec('git', ['-C', repo, ...args]);
    await git('init', '-q');
    await writeFile(path.join(repo, 'code.py'), 'base source');
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(path.join(repo, 'code.py'), 'future fix must not leak');
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'future');
    let context = '';
    await buildLocImage({ ...row, base_commit: commit, image: 'local:fixture' }, 'python@sha256:pinned', async args => {
      context = args.at(-1)!;
      expect(await readFile(path.join(context, 'Dockerfile'), 'utf8')).toContain('FROM python@sha256:pinned');
      await expect(readFile(path.join(context, 'source/.git/HEAD'))).rejects.toThrow();
      expect((await exec('tar', ['-tf', path.join(context, 'source.tar')])).stdout.trim()).toBe('code.py');
      expect((await exec('tar', ['-xOf', path.join(context, 'source.tar'), 'code.py'])).stdout).toBe('base source');
      return '';
    }, args => exec('git', args[0] === 'clone' ? [...args.slice(0, 2), repo, args[3]!] : args));
    await expect(readFile(path.join(context, 'Dockerfile'))).rejects.toThrow();
  } finally { await rm(output, { recursive: true, force: true }); }
});
