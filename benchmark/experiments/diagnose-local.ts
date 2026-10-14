import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileFinder } from '../../src/find.js';
import { configSchema } from '../../src/config.js';

// Offline only: isolate local enumeration/packing from provider latency.
const root = path.resolve('benchmark/results/delivery-experiments-2026-10-09');
const stage = process.argv[2] ?? 'mcp-diagnosis';
if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid stage');
const output = path.join(root, stage);
await mkdir(output, { recursive: true });
const trace = (await readFile(path.join(root, 'swe-prefetch-compact/traces/django__django-11848-0-s1s.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const filenameRequests = trace.filter(r => r.kind === 's1s_provider' && r.request.state?.task).map(r => r.request);
const allNames = filenameRequests.flatMap(r => Object.keys(r.questions)).sort();
const smaller = JSON.parse(await readFile(path.join(root, 'filename-micro-single/BerriAI__litellm-6563-inventory.json'), 'utf8')) as string[];
const rows: object[] = [];
for (const names of [smaller, allNames]) {
  const directory = await mkdtemp(path.join(tmpdir(), 's1s-local-diagnosis-'));
  try {
    for (const name of names) {
      if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Invalid path');
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), '');
    }
    for (let repetition = 0; repetition < 3; repetition++) {
      let firstProviderMs: number | undefined;
      let calls = 0;
      let started = 0;
      const finder = new FileFinder(configSchema.parse({ roots: [directory], maxBatchBytes: 128000 }), async request => {
        firstProviderMs ??= performance.now() - started;
        calls++;
        return { model: 'offline-stub', usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
          answers: Object.fromEntries(Object.keys(request.questions).map(name => [name, { type: 'noul', noul: 0.5 }])) };
      });
      started = performance.now();
      const result = await finder.find({ question: filenameRequests[0].state.question, files: ['**/*.py'], inspect: false });
      const row = { candidates: names.length, repetition, firstProviderMs, totalMs: performance.now() - started, calls, judged: result.judged };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
await writeFile(path.join(output, 'local-overhead.json'), JSON.stringify({
  design: 'Actual FileFinder with empty files matching recorded inventories and immediate zero-cost provider stubs. File creation is outside timing. Same recorded Django issue for both sizes. Time before first callback includes filesystem discovery and synchronous request packing. This is not a live provider benchmark.', rows,
}, null, 2));

const build = (names: string[]) => ({ ...filenameRequests[0], questions: Object.fromEntries(names.map(name => [name, { type: 'noul', instructions: name }])) });
const packing: object[] = [];
for (let repetition = 0; repetition < 3; repetition++) {
  const started = performance.now();
  const original: string[][] = [];
  let group: string[] = [];
  for (const name of allNames) {
    if (group.length && Buffer.byteLength(JSON.stringify(build([...group, name]))) > 128000) { original.push(group); group = []; }
    if (Buffer.byteLength(JSON.stringify(build([name]))) > 128000) throw new Error('Too large');
    group.push(name);
  }
  if (group.length) original.push(group);
  const originalMs = performance.now() - started;
  const fastStarted = performance.now();
  const baseBytes = Buffer.byteLength(JSON.stringify(build([])));
  const incremental: string[][] = [];
  group = [];
  let bytes = baseBytes;
  for (const name of allNames) {
    const entryBytes = Buffer.byteLength(JSON.stringify({ [name]: { type: 'noul', instructions: name } })) - 2;
    if (baseBytes + entryBytes > 128000) throw new Error('Too large');
    if (group.length && bytes + entryBytes + 1 > 128000) { incremental.push(group); group = []; bytes = baseBytes; }
    bytes += entryBytes + (group.length ? 1 : 0);
    group.push(name);
  }
  if (group.length) incremental.push(group);
  const incrementalMs = performance.now() - fastStarted;
  if (JSON.stringify(original) !== JSON.stringify(incremental)) throw new Error('Packing changed');
  const row = { repetition, candidates: allNames.length, originalMs, incrementalMs, identicalBatches: true };
  packing.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(path.join(output, 'packing-comparison.json'), JSON.stringify({
  design: 'Offline construction-only comparison of the current packing loop and an incremental byte counter. Identical batches asserted. Proposed algorithm is not applied to production.', rows: packing,
}, null, 2));
