import dotenv from 'dotenv';
import { defaultCredentialsPath, readJson, loadConfig } from '../src/config.js';
import type { Params } from './params.js';

interface AuthOptions {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  credentialsPath?: string;
  envFile?: string;
  login: () => Promise<void>;
  notify?: (message: string) => void;
}
export async function openRouterKey(params: Params, options: AuthOptions): Promise<string> {
  const env = options.env ?? process.env;
  dotenv.config({ path: options.envFile ?? '.env', quiet: true, processEnv: env });
  const key = [env[params.apiKeyEnv], env.OPENROUTER_API_KEY, env.OPEN_ROUTER_API_KEY]
    .map(value => value?.trim()).find(Boolean);
  if (key) return key;
  const credentials = options.credentialsPath ?? defaultCredentialsPath('user', env);
  const savedKey = async () => {
    const saved = (await readJson(credentials)).openrouter;
    return typeof saved === 'string' ? saved.trim() : '';
  };
  const saved = await savedKey();
  if (saved) return saved;
  if (!(options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    throw new Error('OpenRouter API key not found. Run `mise run login-openrouter`, or set OPENROUTER_API_KEY, then run `mise run benchmark` again.');
  }
  (options.notify ?? console.error)('OpenRouter API key not found. Starting OpenRouter browser login; the benchmark will continue after authorization.');
  await options.login();
  const authorized = await savedKey();
  if (!authorized) throw new Error('OpenRouter login did not save an API key. Run `mise run login-openrouter` and try again.');
  return authorized;
}
export function benchmarkConfig(params: Params, key?: string, env = process.env) {
  return loadConfig({ ...params.s1s, provider: 'openrouter', model: params.s1s.model ?? 'jev-latest',
    baseURL: 'https://openrouter.ai/api', apiKey: key, retries: 0 }, env);
}
