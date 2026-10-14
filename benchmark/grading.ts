import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { docker, type Task } from './docker.js';
import { imageIdentity, save } from './prepare.js';
import type { Params } from './params.js';
import type { Arm } from './agent.js';
import type { Grade } from './report.js';

export async function gradeSWE(params: Params, output: string, arm: Arm, repetition: number, harnessImage: string, run = docker) {
  const tasks = JSON.parse(await readFile(path.join(output, 'tasks.json'), 'utf8')) as Task[];
  const predictions = (await readFile(path.join(output, `${arm}-${repetition}.predictions.jsonl`), 'utf8')).trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line) as { instance_id: string; model_patch: string });
  const endpoint = process.env.DOCKER_HOST ?? (await run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).trim();
  if (!endpoint.startsWith('unix://')) throw new Error('Official grading requires a local Unix Docker socket');
  const socket = endpoint.slice('unix://'.length);
  const workdir = path.join(output, `grading-${arm}-${repetition}`);
  await mkdir(workdir, { recursive: true });
  const results: Grade[] = [];
  for (const task of tasks) {
    const started = performance.now();
    const prediction = predictions.find(p => p.instance_id === task.instance_id);
    const result: Grade & { error?: string } = { instance_id: task.instance_id, resolved: false, status: 'empty_patch', gradingMs: 0 };
    const runId = `paired-${randomUUID()}`;
    const name = `s1s-grading-${runId}`;
    try {
      if (prediction?.model_patch.trim()) {
        if (task.imageId && (await imageIdentity(task.image, run)).imageId !== task.imageId) throw new Error('Docker image changed since preparation');
        await run(['run', '--rm', '--platform', 'linux/amd64', '--name', name,
          '--mount', `type=bind,source=${socket},target=/var/run/docker.sock`,
          '--mount', `type=bind,source=${output},target=${output}`,
          '--workdir', workdir, harnessImage, 'python', '-m', 'swebench.harness.run_evaluation',
          '--dataset_name', path.join(output, 'grading-dataset.json'),
          '--predictions_path', path.join(output, `${arm}-${repetition}.predictions.jsonl`),
          '--instance_ids', task.instance_id, '--run_id', runId, '--namespace', 'swebench',
          '--max_workers', '1', '--cache_level', 'instance', '--clean', 'false',
          '--timeout', String(params.gradingTimeoutSeconds)], (params.gradingTimeoutSeconds + 180) * 1000);
        const report = z.record(z.string(), z.object({ resolved: z.boolean() })).parse(JSON.parse(await readFile(
          path.join(workdir, 'logs/run_evaluation', runId, arm, task.instance_id, 'report.json'), 'utf8')));
        if (!report[task.instance_id]) throw new Error('Official grading produced no instance report');
        result.resolved = report[task.instance_id]!.resolved;
        result.status = result.resolved ? 'resolved' : 'unresolved';
      }
    } catch (error) {
      result.status = 'grading_error';
      result.error = error instanceof Error ? error.message : 'Grading failed';
    } finally {
      if (prediction?.model_patch.trim()) {
        await run(['rm', '-f', name]).catch(() => {});
        await run(['rm', '-f', `sweb.eval.${task.instance_id.toLowerCase()}.${runId}`]).catch(() => {});
      }
    }
    result.gradingMs = performance.now() - started;
    results.push(result);
    await save(path.join(output, `${arm}-${repetition}.grades.json`), results);
    console.log(`${arm} ${task.instance_id}: ${result.status}`);
  }
}
