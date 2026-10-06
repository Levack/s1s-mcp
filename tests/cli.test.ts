import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJson, savePrivateJson } from '../src/config.js';

it('logs out locally, preserves other credentials, and is safe to repeat or run before login', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-logout-'));
  const credentials = path.join(dir, 'credentials.json');
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--credentials', credentials, 'logout']);
  try {
    await run();
    await expect(stat(credentials)).rejects.toMatchObject({ code: 'ENOENT' });
    await savePrivateJson(credentials, { openrouter: 'test-placeholder', typesafe: 'retained-placeholder' });
    await run();
    expect(await readJson(credentials)).toEqual({ typesafe: 'retained-placeholder' });
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    await run();
    expect(await readJson(credentials)).toEqual({ typesafe: 'retained-placeholder' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('reuses user credentials across projects and keeps project credentials explicitly scoped', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-scopes-'));
  const user = path.join(dir, 'user');
  const project = path.join(dir, 'project');
  const other = path.join(dir, 'other');
  const { mkdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const env = { ...process.env, S1S_HOME: user };
  for (const key of ['S1S_API_KEY', 'OPENROUTER_API_KEY', 'OPEN_ROUTER_API_KEY', 'TYPESAFE_API_KEY', 'TYPE_SAFE_AI_API_KEY', 'S1S_PROVIDER', 'S1S_MODEL']) delete env[key as keyof typeof env];
  const run = (cwd: string, args: string[]) => promisify(execFile)(process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, '--dotenv', path.join(dir, 'missing.env'), ...args], { cwd, env });
  const userCredentials = path.join(user, 'credentials.json');
  const projectCredentials = path.join(project, '.s1s-mcp', 'credentials.json');
  try {
    await mkdir(project); await mkdir(other);
    await savePrivateJson(userCredentials, { openrouter: 'user-placeholder', typesafe: 'user-typesafe-placeholder' });
    expect(JSON.parse((await run(other, ['config'])).stdout)).toMatchObject({ configured: true, roots: [other] });
    await expect(run(project, ['--scope', 'project', 'config'])).rejects.toThrow('No openrouter credentials for project scope');
    await savePrivateJson(projectCredentials, { typesafe: 'project-typesafe-placeholder' });
    await expect(run(project, ['--scope', 'project', 'config'])).rejects.toThrow('No openrouter credentials for project scope');
    expect(JSON.parse((await run(project, ['--scope', 'project', '--provider', 'typesafe', 'config'])).stdout)).toMatchObject({ configured: true, provider: 'typesafe' });
    await run(project, ['--scope', 'project', '--provider', 'typesafe', 'logout']);
    expect(await readJson(projectCredentials)).toEqual({});
    expect(await readJson(userCredentials)).toEqual({ openrouter: 'user-placeholder', typesafe: 'user-typesafe-placeholder' });
    await run(other, ['logout']);
    expect(await readJson(userCredentials)).toEqual({ typesafe: 'user-typesafe-placeholder' });
    await run(other, ['logout']);
    expect((await stat(userCredentials)).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await run(other, ['--credentials', userCredentials, '--provider', 'typesafe', 'config'])).stdout).configured).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

it('layers user and project settings below environment and CLI without pinning roots globally', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-settings-'));
  const user = path.join(dir, 'user');
  const project = path.join(dir, 'project');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (args: string[] = [], variables: Record<string, string> = {}) => promisify(execFile)(process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, '--dotenv', path.join(dir, 'missing.env'), ...args, 'config'],
    { cwd: project, env: { ...process.env, S1S_HOME: user, S1S_PROVIDER: '', S1S_MODEL: '', S1S_CONCURRENCY: '', S1S_ROOTS: '', ...variables } });
  try {
    await savePrivateJson(path.join(user, 'config.json'), { model: 'user-model', concurrency: 2 });
    await savePrivateJson(path.join(project, '.s1s-mcp', 'config.json'), { model: 'project-model' });
    expect(JSON.parse((await run()).stdout)).toMatchObject({ model: 'project-model', concurrency: 2, roots: [project] });
    expect(JSON.parse((await run([], { S1S_MODEL: 'env-model' })).stdout).model).toBe('env-model');
    expect(JSON.parse((await run(['--model', 'cli-model'], { S1S_MODEL: 'env-model' })).stdout).model).toBe('cli-model');
    const explicit = path.join(dir, 'custom.json');
    await savePrivateJson(explicit, { model: 'explicit-model' });
    expect(JSON.parse((await run(['--config', explicit])).stdout)).toMatchObject({ model: 'explicit-model', concurrency: 2 });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

it('accepts provider and API-key options after login and saves each provider in the selected scope', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-login-'));
  const user = path.join(dir, 'user');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => promisify(execFile)(process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, 'login', ...args],
    { cwd: dir, env: { ...process.env, S1S_HOME: user } });
  try {
    await run('--provider', 'openrouter', '--api-key', 'openrouter-placeholder');
    await run('--provider', 'typesafe', '--api-key', 'typesafe-placeholder');
    expect(await readJson(path.join(user, 'credentials.json'))).toEqual({ openrouter: 'openrouter-placeholder', typesafe: 'typesafe-placeholder' });
    expect(await readJson(path.join(user, 'config.json'))).toEqual({ provider: 'typesafe' });
    await run('--scope', 'project', '--provider', 'openrouter', '--api-key', 'project-placeholder');
    expect(await readJson(path.join(dir, '.s1s-mcp', 'credentials.json'))).toEqual({ openrouter: 'project-placeholder' });
    expect((await stat(path.join(dir, '.s1s-mcp', 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect((await readJson(path.join(user, 'credentials.json'))).openrouter).toBe('openrouter-placeholder');
    await expect(run('--provider', 'openrouter', '--auth-method', 'api-key')).rejects.toThrow('API-key login requires a terminal');
    await expect(run('--provider', 'openrouter', '--api-key', ' ')).rejects.toThrow('API key is required');
    expect((await readJson(path.join(user, 'credentials.json'))).openrouter).toBe('openrouter-placeholder');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);
