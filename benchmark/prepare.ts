import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { loadDataset } from './dataset.js';
import { docker, type Task } from './docker.js';
import type { Params } from './params.js';

const exec = promisify(execFile);
export const harnessVersion = '4.1.0';
export async function save(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n');
}
export function sweImage(instanceId: string) {
  return `swebench/sweb.eval.x86_64.${instanceId.toLowerCase()}:latest`.replaceAll('__', '_1776_');
}
export async function imageIdentity(image: string, run = docker) {
  const [details] = z.array(z.object({ Id: z.string(), RepoDigests: z.array(z.string()).nullable() }))
    .parse(JSON.parse(await run(['image', 'inspect', image])));
  if (!details) throw new Error(`Image not found: ${image}`);
  return { imageId: details.Id, imageDigests: details.RepoDigests ?? [] };
}
export async function buildLocImage(task: Task, base: string, run = docker,
  git: (args: string[]) => Promise<unknown> = args => exec('git', args, { timeout: 600000, maxBuffer: 16 * 1024 * 1024 })) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(task.repo) || !/^[a-f0-9]{40}$/.test(task.base_commit)) throw new Error('Invalid repository or base commit');
  const context = await mkdtemp(path.join(tmpdir(), 's1s-locbench-'));
  try {
    const source = path.join(context, 'source');
    await git(['clone', '--no-checkout', `https://github.com/${task.repo}.git`, source]);
    await git(['-C', source, 'archive', '--output', path.join(context, 'source.tar'), task.base_commit]);
    await rm(source, { recursive: true });
    await writeFile(path.join(context, 'Dockerfile'), `FROM ${base}\n` +
      'RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/*\n' +
      'WORKDIR /testbed\nADD source.tar /testbed/\n' +
      'RUN git init -q && git add -f . && git -c user.name=Benchmark -c user.email=benchmark@example.invalid commit -qm base\n');
    await run(['build', '--platform', 'linux/amd64', '-t', task.image, context], 600000);
  } finally { await rm(context, { recursive: true, force: true }); }
}
export async function prepareDataset(params: Params, output: string, load = loadDataset, run = docker) {
  const { revision, rows } = await load(params);
  const tasks: Task[] = rows.map(row => {
    if (params.bench === 'loc-bench') z.array(z.string()).min(1).parse(row.edit_functions);
    return { instance_id: row.instance_id, repo: row.repo, base_commit: row.base_commit,
      problem_statement: row.problem_statement, taskNumber: row.taskNumber,
      image: params.bench === 'loc-bench' ? `s1s-locbench:${row.base_commit}` : sweImage(row.instance_id) };
  });
  await save(path.join(output, 'grading-dataset.json'), rows);
  await save(path.join(output, 'dataset.json'), { bench: params.bench, dataset: params.dataset, revision, split: 'test',
    instanceIds: rows.map(row => row.instance_id), taskNumbers: rows.map(row => row.taskNumber),
    ...(params.bench === 'swe-bench-mini' ? { harnessVersion } : {}) });
  if (params.pullImages) {
    await run(['info']);
    let base: string | undefined;
    if (params.bench === 'loc-bench') {
      await run(['pull', '--platform', 'linux/amd64', 'python:3.11-slim'], 600000);
      base = (await imageIdentity('python:3.11-slim', run)).imageDigests[0];
      if (!base) throw new Error('Base image has no immutable digest');
    }
    for (const task of tasks) {
      console.log(`Preparing ${task.image}`);
      if (base) {
        await buildLocImage(task, base, run);
        task.sourceBaseImage = base;
      } else {
        await run(['image', 'inspect', task.image]).catch(() => run(['pull', '--platform', 'linux/amd64', task.image], 600000));
      }
      Object.assign(task, await imageIdentity(task.image, run));
    }
  }
  // Publish the prepared marker only after all requested images are ready.
  await save(path.join(output, 'tasks.json'), tasks);
}

export async function prepareHarness(output: string, run = docker) {
  const image = `s1s-swebench-harness:${harnessVersion}`;
  try { await run(['image', 'inspect', image]); }
  catch {
    const context = await mkdtemp(path.join(tmpdir(), 's1s-harness-'));
    try {
      await writeFile(path.join(context, 'Dockerfile'), 'FROM python:3.11-slim\n' +
        'RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*\n' +
        `RUN pip install --no-cache-dir swebench==${harnessVersion}\n`);
      await run(['build', '--platform', 'linux/amd64', '-t', image, context], 600000);
    } finally { await rm(context, { recursive: true, force: true }); }
  }
  const identity = await imageIdentity(image, run);
  await save(path.join(output, 'harness-image.json'), { image, ...identity, harnessVersion });
  return identity.imageId;
}
