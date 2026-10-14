import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gradeSWE } from '../../benchmark/grading.js';
import { paramsSchema } from '../../benchmark/params.js';
import { save } from '../../benchmark/prepare.js';

it('runs the pinned official harness in Docker, reads its reports, and retains grading failures', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 's1s-ts-grade-'));
  const ids = ['example-1', 'example-2', 'example-3', 'example-4'];
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'context') return 'unix:///var/run/docker.sock';
    if (args[0] === 'image') return JSON.stringify([{ Id: 'snapshot', RepoDigests: [] }]);
    if (args[0] === 'run') {
      expect(args).toContain('pinned-harness-id');
      expect(args).toContain('swebench.harness.run_evaluation');
      const id = args[args.indexOf('--instance_ids') + 1]!;
      if (id === 'example-3') throw new Error('Official harness failure');
      const runId = args[args.indexOf('--run_id') + 1]!;
      const directory = path.join(output, 'grading-baseline-0/logs/run_evaluation', runId, 'baseline', id);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'report.json'), JSON.stringify({ [id]: { resolved: true } }));
    }
    return '';
  });
  try {
    await save(path.join(output, 'tasks.json'), ids.map(instance_id => ({ instance_id, image: 'fixture', imageId: 'snapshot' })));
    await writeFile(path.join(output, 'baseline-0.predictions.jsonl'), ids.map((instance_id, i) => JSON.stringify({ instance_id, model_patch: i === 3 ? '' : 'a patch' })).join('\n'));
    await gradeSWE(paramsSchema.parse({}), output, 'baseline', 0, 'pinned-harness-id', run);
    expect(JSON.parse(await readFile(path.join(output, 'baseline-0.grades.json'), 'utf8'))).toMatchObject([
      { resolved: true, status: 'resolved' }, { resolved: true, status: 'resolved' },
      { resolved: false, status: 'grading_error' }, { resolved: false, status: 'empty_patch' },
    ]);
    expect(run.mock.calls.filter(([args]) => args[0] === 'run')).toHaveLength(3);
    expect(run.mock.calls.filter(([args]) => args[0] === 'rm')).toHaveLength(6);
  } finally { await rm(output, { recursive: true, force: true }); }
});
