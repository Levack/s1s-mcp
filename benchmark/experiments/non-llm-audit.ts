import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../../src/config.js';
import { discoverFiles, readTextChunks } from '../../src/files.js';
import { providerEvaluate } from '../../src/system-one.js';

// Offline probes only. No evaluator is invoked and no API key is loaded.
const root = path.resolve('benchmark/results/delivery-experiments-2026-10-09');
const output = path.join(root, 'non-llm-audit');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), 's1s-audit-'));
const measurements: object[] = [];
async function measure(name: string, run: () => Promise<unknown>, repetitions = 5) {
  const milliseconds: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    const started = performance.now();
    await run();
    milliseconds.push(performance.now() - started);
  }
  measurements.push({ name, milliseconds, meanMs: milliseconds.reduce((a, b) => a + b) / milliseconds.length });
}
try {
  const config = configSchema.parse({ roots: [temporary], apiKey: 'offline-placeholder' });
  await measure('construct_1000_provider_clients_no_requests', async () => {
    for (let i = 0; i < 1000; i++) providerEvaluate(config);
  });
  const files = Array.from({ length: 80 }, (_, i) => `file-${i}.py`);
  const content = 'def example():\n    return "example"\n'.repeat(100);
  await Promise.all(files.map(file => writeFile(path.join(temporary, file), content)));
  for (const count of [3, 40, 80]) {
    const selected = files.slice(0, count);
    await measure(`discover_${count}_explicit_paths`, () => discoverFiles(config, selected, 80));
    await measure(`read_${count}_sequential`, async () => {
      for (const file of selected) await readTextChunks(path.join(temporary, file), config, 5800);
    });
    await measure(`read_${count}_concurrency_8`, async () => {
      for (let i = 0; i < selected.length; i += 8) {
        await Promise.all(selected.slice(i, i + 8).map(file => readTextChunks(path.join(temporary, file), config, 5800)));
      }
    });
  }
  const traces = path.join(root, 'swe-prefetch-lean/traces');
  const traceStats: object[] = [];
  for (const file of (await readdir(traces)).filter(name => name.endsWith('.jsonl')).sort()) {
    const records = (await readFile(path.join(traces, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const completions = records.filter(record => record.kind === 'completion');
    const providers = records.filter(record => record.kind === 's1s_provider');
    const mcp = records.filter(record => record.kind === 'tool' && record.result?.structuredContent);
    traceStats.push({ file, records: records.length, completionRecords: completions.length,
      completionLogBytes: completions.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0),
      providerRecords: providers.length,
      mcpEnvelopeBytes: mcp.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record.result)), 0),
      structuredEvidenceBytes: mcp.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record.result.structuredContent)), 0) });
    await measure(`replay_all_trace_writes:${file}`, async () => {
      const target = path.join(temporary, 'replay.jsonl');
      await writeFile(target, '');
      for (const record of records) await appendFile(target, JSON.stringify(record) + '\n');
    }, 3);
  }
  await writeFile(path.join(output, 'measurements.json'), JSON.stringify({
    design: 'Offline warm local filesystem probes. Five repetitions unless trace replay (three). Reads retain production validation. Replay includes JSON serialization and awaited appendFile but not parsing. Concurrency eight is a prototype, not a production change. Client construction sends no requests. Synthetic source files are 3500 bytes each. No cold disk or transport latency claim.',
    measurements, traceStats,
  }, null, 2));
  console.log(JSON.stringify({ measurements: measurements.map(({ ...row }) => row), traceStats }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
