import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseRange, paramsSchema, taskCount } from '../../benchmark/params.js';
import { interactiveParams } from '../../benchmark/interactive.js';

const exec = promisify(execFile);

it('parses inclusive numbers and ranges, sorts and deduplicates them, and checks each benchmark boundary', () => {
  expect(parseRange('5-8, 1,3, 7-9', 50)).toEqual([1, 3, 5, 6, 7, 8, 9]);
  expect(parseRange('560', 560)).toEqual([560]);
  for (const range of ['', '0', '-1', '3-1', '1-', '1:3', '1,,3', '1.5', '51', '1-999999999999999999999']) {
    expect(() => paramsSchema.parse({ range })).toThrow();
  }
  expect(taskCount(paramsSchema.parse({ bench: 'loc-bench', range: '1-100', limit: 1 }))).toBe(100);
  expect(() => paramsSchema.parse({ range: '1', instanceIds: ['example-1'] })).toThrow();
  expect(() => paramsSchema.parse({ instanceIds: ['example-1', 'example-1'] })).toThrow();
});

it('preserves explicit selection in the wizard without asking for an ignored task limit', async () => {
  const result = await interactiveParams(paramsSchema.parse({ range: '2-4' }), {
    choose: async (message, _choices, value) => message === 'What would you like to do?' ? 'prepare' : value,
    text: async (message, value) => {
      expect(message).not.toMatch(/^Number of /);
      return value;
    },
  });
  expect(result.range).toBe('2-4');
});

it('accepts CLI range and ID flags, records selected numbers, and replaces JSON selectors', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 's1s-range-cli-'));
  try {
    const command = (args: string[]) => exec(process.execPath, ['--import', 'tsx', 'benchmark/cli.ts',
      '--dry-run', '--mode', 'prepare', ...args]);
    const rangeOutput = path.join(output, 'range');
    await command(['--bench', 'loc-bench', '--range', '52-53,51,53', '--limit', '1', '--output', rangeOutput,
      '--params', '{"instanceIds":["ignored-id"]}']);
    const selected = JSON.parse(await readFile(path.join(rangeOutput, 'dataset.json'), 'utf8'));
    expect(selected).toMatchObject({ taskNumbers: [51, 52, 53], instanceIds: ['dry-run-051', 'dry-run-052', 'dry-run-053'] });
    const idsOutput = path.join(output, 'ids');
    await command(['--instance-ids', 'dry-run-005,dry-run-001', '--limit', '1', '--output', idsOutput,
      '--params', '{"range":"2-3"}']);
    expect(JSON.parse(await readFile(path.join(idsOutput, 'dataset.json'), 'utf8')).taskNumbers).toEqual([1, 5]);
    await expect(command(['--range', '51', '--output', path.join(output, 'invalid')])).rejects.toThrow();
    await expect(command(['--range', '1', '--instance-ids', 'dry-run-001'])).rejects.toThrow('Choose --range or --instance-ids');
  } finally { await rm(output, { recursive: true, force: true }); }
});
