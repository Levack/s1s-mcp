import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import dotenv from 'dotenv';
import { z } from 'zod';

export const configSchema = z.object({
  provider: z.enum(['typesafe', 'openrouter']).default('openrouter'),
  model: z.string().min(1).default('jev-latest'),
  apiKey: z.string().min(1).optional(),
  baseURL: z.url().optional(),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  port: z.coerce.number().int().min(0).max(65535).default(3100),
  roots: z.array(z.string().min(1)).min(1).default([process.cwd()]),
  concurrency: z.coerce.number().int().min(1).max(32).default(4),
  batchSize: z.coerce.number().int().min(1).max(64).default(8),
  maxBatchBytes: z.coerce.number().int().min(1024).max(200000).default(48000),
  maxFileBytes: z.coerce.number().int().min(1).max(100000).default(24000),
  timeout: z.coerce.number().int().min(100).max(300000).default(30000),
  retries: z.coerce.number().int().min(0).max(5).default(1),
  httpToken: z.string().min(16).optional(),
});
export type Config = z.infer<typeof configSchema>;
export type StorageScope = 'user' | 'project';
export const userDirectory = (env = process.env) => path.resolve(env.S1S_HOME || path.join(homedir(), '.s1s-mcp'));
export const defaultConfigPath = (scope: StorageScope = 'user', env = process.env) =>
  path.join(scope === 'project' ? path.resolve('.s1s-mcp') : userDirectory(env), 'config.json');
export const defaultCredentialsPath = (scope: StorageScope = 'user', env = process.env) =>
  path.join(scope === 'project' ? path.resolve('.s1s-mcp') : userDirectory(env), 'credentials.json');
export function storagePaths(options: Record<string, unknown> = {}, env = process.env) {
  const scope = z.enum(['user', 'project']).parse(options.scope ?? 'user');
  return {
    config: path.resolve(String(options.config ?? defaultConfigPath(scope, env))),
    credentials: path.resolve(String(options.credentials ?? defaultCredentialsPath(scope, env))),
  };
}

export async function readJson(file: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read JSON configuration: ${file}`);
  }
}
export async function savePrivateJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const { rename, chmod } = await import('node:fs/promises');
  await rename(temporary, file);
  await chmod(file, 0o600);
}
export async function loadConfig(options: Record<string, unknown> = {}, env = process.env): Promise<Config> {
  dotenv.config({ path: String(options.envFile ?? '.env'), quiet: true, processEnv: env });
  const paths = storagePaths(options, env);
  const userConfig = await readJson(defaultConfigPath('user', env));
  const projectConfig = await readJson(String(options.config ?? defaultConfigPath('project', env)));
  const file = { ...userConfig, ...projectConfig };
  const credentials = await readJson(paths.credentials);
  const envConfig: Record<string, unknown> = {
    provider: env.S1S_PROVIDER, model: env.S1S_MODEL, baseURL: env.S1S_BASE_URL,
    transport: env.S1S_TRANSPORT, host: env.S1S_HOST, port: env.S1S_PORT,
    roots: env.S1S_ROOTS ? env.S1S_ROOTS.split(path.delimiter) : undefined, concurrency: env.S1S_CONCURRENCY,
    batchSize: env.S1S_BATCH_SIZE, maxFileBytes: env.S1S_MAX_FILE_BYTES,
    maxBatchBytes: env.S1S_MAX_BATCH_BYTES, timeout: env.S1S_TIMEOUT,
    retries: env.S1S_RETRIES, httpToken: env.S1S_HTTP_TOKEN,
  };
  const defined = (obj: Record<string, unknown>) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));
  const merged = { ...file, ...defined(envConfig), ...defined(options) };
  const provider = merged.provider ?? 'openrouter';
  merged.apiKey = options.apiKey || env.S1S_API_KEY || (provider === 'openrouter'
    ? env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY
    : env.TYPESAFE_API_KEY || env.TYPE_SAFE_AI_API_KEY)
    || (options.scope === 'project' ? projectConfig.apiKey : file.apiKey) || credentials[String(provider)];
  const result = configSchema.parse(merged);
  if (options.scope === 'project' && !result.apiKey) {
    throw new Error(`No ${result.provider} credentials for project scope. Run s1s-mcp login --scope project --provider ${result.provider}.`);
  }
  if (result.provider === 'typesafe' && result.model.startsWith('typesafe/')) result.model = result.model.slice(9);
  return result;
}
export function publicConfig(config: Config) {
  const { apiKey, httpToken, ...rest } = config;
  return { ...rest, configured: Boolean(apiKey), httpAuthenticated: Boolean(httpToken) };
}
