import { expect, it } from 'vitest';
import { paramsSchema } from '../../benchmark/params.js';
import { interactiveParams, integerValidator, wantsInteractive, type Prompts } from '../../benchmark/interactive.js';

it('opens the wizard for a bare terminal command or explicit interactive flag, preserving scripted flag execution', () => {
  expect(wantsInteractive([], true)).toBe(true);
  expect(wantsInteractive(['--model', 'example/model'], true)).toBe(false);
  expect(wantsInteractive(['--interactive', '--limit', '3'], true)).toBe(true);
  expect(wantsInteractive([], false)).toBe(false);
  expect(wantsInteractive(['--interactive'], false)).toBe(false);
});

it('validates whole-number limits including empty input, fractions and the 50-task boundary', () => {
  const validate = integerValidator(1, 50);
  expect(validate('1')).toBe(true);
  expect(validate(' 50 ')).toBe(true);
  for (const value of ['', '0', '-1', '51', '1.5', '1e1', 'word']) expect(validate(value)).not.toBe(true);
});

it('uses interactive settings for a paired run, retaining advanced defaults from flags or JSON', async () => {
  const defaults = paramsSchema.parse({ model: 'default/model', limit: 3, seed: 123, s1s: { batchSize: 2 } });
  const answers = ['chosen/model', 'jev-1.13.0', '30', '2', '600', '10', 'benchmark/results/custom'];
  const seenDefaults: string[] = [];
  const prompts: Prompts = {
    choose: async (message, _choices, defaultValue) => {
      expect(defaultValue).toBe(message === 'Which benchmark?' ? 'swe-bench-mini' : 'run'); return defaultValue;
    },
    text: async (_message, defaultValue, validate) => {
      seenDefaults.push(defaultValue);
      const value = answers.shift()!;
      expect(validate?.(value) ?? true).toBe(true);
      return value;
    },
  };
  const result = await interactiveParams(defaults, prompts);
  expect(result).toMatchObject({ mode: 'run', dryRun: false, model: 'chosen/model', limit: 10, maxSteps: 30,
    repetitions: 2, timeoutSeconds: 600, seed: 123, output: 'benchmark/results/custom', s1s: { model: 'jev-1.13.0', batchSize: 2 } });
  expect(seenDefaults[0]).toBe('default/model');
  expect(seenDefaults[5]).toBe('3');
  expect(answers).toHaveLength(0);
});

it('keeps dry runs and preparation free of live model prompts, and requires a report destination', async () => {
  for (const mode of ['dry', 'prepare', 'report']) {
    const questions: string[] = [];
    const result = await interactiveParams(paramsSchema.parse({}), {
      choose: async (message, _choices, defaultValue) => message === 'Which benchmark?' ? defaultValue : mode,
      text: async (message, defaultValue) => {
        questions.push(message);
        return message === 'Results directory' ? 'benchmark/results/example' : defaultValue;
      },
    });
    expect(questions).not.toContain('OpenRouter solver model ID');
    expect(result.dryRun).toBe(mode === 'dry');
    expect(result.mode).toBe(mode === 'dry' ? 'run' : mode);
    expect(result.output).toBe('benchmark/results/example');
  }
});


it('selects Loc-Bench interactively with its own dataset and task limit', async () => {
  const result = await interactiveParams(paramsSchema.parse({}), {
    choose: async message => message === 'Which benchmark?' ? 'loc-bench' : 'prepare',
    text: async (message, defaultValue, validate) => {
      if (message.startsWith('Number of')) {
        expect(message).toContain('Loc-Bench');
        expect(validate?.('560')).toBe(true);
        expect(validate?.('561')).not.toBe(true);
        return '560';
      }
      return defaultValue;
    },
  });
  expect(result).toMatchObject({ bench: 'loc-bench', dataset: 'czlll/Loc-Bench_V1', limit: 560 });
});
