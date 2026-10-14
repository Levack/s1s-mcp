import { input, select } from '@inquirer/prompts';
import { benches, paramsSchema, type Params } from './params.js';

export interface Prompts {
  choose(message: string, choices: { name: string; value: string }[], defaultValue: string): Promise<string>;
  text(message: string, defaultValue: string, validate?: (value: string) => true | string): Promise<string>;
}
const terminal: Prompts = {
  choose: (message, choices, defaultValue) => select({ message, choices, default: defaultValue }),
  text: (message, defaultValue, validate) => input({ message, default: defaultValue, validate }),
};
export function wantsInteractive(args: string[], tty: boolean) {
  return tty && (args.length === 0 || args.includes('--interactive'));
}
export function integerValidator(min: number, max: number) {
  return (value: string): true | string => /^\d+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max
    ? true : `Enter an integer from ${min} to ${max}.`;
}
export async function interactiveParams(base: Params, prompts: Prompts = terminal): Promise<Params> {
  const mode = await prompts.choose('What would you like to do?', [
    { name: 'Run the paired benchmark (with and without s1s)', value: 'run' },
    { name: 'Prepare dataset and Docker images', value: 'prepare' },
    { name: 'Dry run (no API calls)', value: 'dry' },
    { name: 'Regenerate an existing report', value: 'report' },
  ], base.dryRun ? 'dry' : base.mode);
  const bench = mode === 'report' ? base.bench : await prompts.choose('Which benchmark?',
    Object.entries(benches).map(([value, b]) => ({ name: `${b.name} (${b.size} tasks)`, value })), base.bench) as Params['bench'];
  let result = { ...base, bench, dataset: benches[bench].dataset, limit: Math.min(base.limit, benches[bench].size), mode: mode === 'dry' ? 'run' : mode, dryRun: mode === 'dry' };
  if (mode === 'run') {
    const model = (await prompts.text('OpenRouter solver model ID', base.model, value => value.trim() ? true : 'Enter a model ID.')).trim();
    const s1sModel = (await prompts.text('OpenRouter Jev model', base.s1s.model ?? 'jev-latest', value => value.trim() ? true : 'Enter a model ID.')).trim();
    const maxSteps = Number(await prompts.text('Maximum solver calls per attempt', String(base.maxSteps), integerValidator(1, 1000)));
    const repetitions = Number(await prompts.text('Paired repetitions', String(base.repetitions), integerValidator(1, 20)));
    const timeoutSeconds = Number(await prompts.text('Solving time limit per attempt (seconds)', String(base.timeoutSeconds), integerValidator(1, 86400)));
    result = { ...result, model, s1s: { ...base.s1s, model: s1sModel }, maxSteps, repetitions, timeoutSeconds };
  }
  if ((mode === 'run' || mode === 'prepare') && !result.range && !result.instanceIds) {
    result.limit = Number(await prompts.text(`Number of ${benches[bench].name} tasks (each runs in both conditions)`, String(result.limit), integerValidator(1, benches[bench].size)));
  }
  const defaultOutput = base.output ?? (mode === 'report' ? '' : `benchmark/results/${new Date().toISOString().replaceAll(':', '-')}${mode === 'dry' ? '-dry' : ''}`);
  result.output = (await prompts.text('Results directory', defaultOutput, value => value.trim() ? true : 'Enter a results directory.')).trim();
  return paramsSchema.parse(result);
}
