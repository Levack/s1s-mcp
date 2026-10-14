import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Params } from './params.js';
const exec = promisify(execFile);
export async function extractSourceArchive(source: Readable, target: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-source-archive-'));
  try {
    const archive = path.join(dir, 'source.tar');
    await pipeline(source, createWriteStream(archive));
    await exec('tar', ['-xf', archive, '-C', target], { timeout: 600000 });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function docker(args: string[], timeout = 120000) {
  return (await exec('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
export interface Task { instance_id: string; repo: string; base_commit: string; problem_statement: string; taskNumber?: number; image: string; imageId?: string; sourceBaseImage?: string }
export interface Workspace { shell(command: string, timeout: number): Promise<string>; patch(): Promise<string>; exportSource(target: string, files?: string[]): Promise<void>; exportCurrentSource(target: string): Promise<void>; close(): Promise<void> }
export function sourceArchiveArgs(directory: string, files?: string[]) {
  if (files && (!files.length || files.some(file => !file || path.isAbsolute(file) || file.split('/').includes('..') || file.startsWith('!') || file.includes('\0')))) {
    throw new Error('Source archive patterns must be positive repository-relative globs');
  }
  return ['-C', directory, 'archive', '--format=tar', 'HEAD', ...(files ? ['--', ...files.map(file => `:(glob)${file}`)] : [])];
}
export function currentSourceArchiveArgs(directory: string) {
  return ['-C', directory, '--exclude=./.git', '-cf', '-', '.'];
}
export async function workspace(task: Task, params: Params): Promise<Workspace> {
  const name = `s1s-benchmark-${randomUUID()}`;
  try {
    await docker(['run', '-d', '--platform', 'linux/amd64', '--name', name, '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--cpus', String(params.cpus), '--memory', params.memory,
      '--pids-limit', String(params.pidsLimit), '--workdir', '/testbed', '--entrypoint', '/bin/bash',
      task.imageId ?? task.image, '-c', 'sleep infinity']);
    // Remove history, remotes and setup scripts: the solver gets only the base tree.
    await docker(['exec', name, 'bash', '-c', `set -e
cd /testbed
git reset --hard ${params.bench === 'loc-bench' ? 'HEAD' : task.base_commit}
git clean -fdx
rm -rf .git
rm -f /root/.bash_history /root/.gitconfig /root/.git-credentials /eval.sh /patch.diff /root/setup_repo.sh /root/setup_env.sh /root/setup.sh
git init -q
git add -f .
git -c user.name=Benchmark -c user.email=benchmark@example.invalid commit -qm base
`]);
  } catch (error) { await docker(['rm', '-f', name]).catch(() => {}); throw error; }
  return {
    async shell(command, timeout) {
      try {
        const result = await exec('docker', ['exec', name, 'bash', '-c',
          params.bench === 'loc-bench' ? 'cd /testbed && eval "$1"' : 'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && cd /testbed && eval "$1"', 'benchmark', command],
        { timeout, maxBuffer: 1024 * 1024 });
        return `exit=0\n${result.stdout}${result.stderr}`.slice(0, 30000);
      } catch (error) {
        const e = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
        if (e.killed || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          // docker exec client termination alone does not stop the container command.
          await docker(['kill', name]);
          throw new Error(e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Command output limit; workspace stopped' : 'Command timeout; workspace stopped');
        }
        return `exit=${e.code ?? 'error'}\n${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 30000);
      }
    },
    async patch() {
      return docker(['exec', name, 'bash', '-c', 'cd /testbed && git add -N . && git diff --binary HEAD']);
    },
    // Stream the committed base tree without .git through docker exec. This
    // avoids Docker cp's archive endpoint, which can fail with unexpected EOF.
    async exportSource(target, files) {
      const child = spawn('docker', ['exec', name, 'git', ...sourceArchiveArgs('/testbed', files)],
        { timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
      const completed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`Source archive failed (exit ${code}): ${stderr}`)));
      });
      try { await Promise.all([extractSourceArchive(child.stdout, target), completed]); }
      finally { child.kill(); }
    },
    async exportCurrentSource(target) {
      const child = spawn('docker', ['exec', name, 'tar', ...currentSourceArchiveArgs('/testbed')],
        { timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
      const completed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`Working tree export failed (exit ${code}): ${stderr}`)));
      });
      try { await Promise.all([extractSourceArchive(child.stdout, target), completed]); }
      finally { child.kill(); }
    },
    async close() { await docker(['rm', '-f', name]); },
  };
}
