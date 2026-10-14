import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { paramsSchema } from '../../benchmark/params.js';
import { openRouterKey, benchmarkConfig } from '../../benchmark/auth.js';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 's1s-benchmark-auth-'));
  return { directory, credentialsPath: path.join(directory, 'credentials.json'),
    envFile: path.join(directory, 'missing.env'), dispose: () => rm(directory, { recursive: true, force: true }) };
}

it('shares an environment OpenRouter key without starting login, preferring it over saved credentials', async () => {
  const f = await fixture(), login = vi.fn(async () => {});
  try {
    await writeFile(f.credentialsPath, JSON.stringify({ openrouter: 'saved-key', typesafe: 'other-provider-key' }));
    const key = await openRouterKey(paramsSchema.parse({}), { ...f, login, interactive: true, env: { OPENROUTER_API_KEY: ' env-key ' } });
    expect(key).toBe('env-key');
    expect(login).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

it('loads the project dotenv key and supports a custom OpenRouter key variable', async () => {
  const f = await fixture(), login = vi.fn(async () => {});
  try {
    await writeFile(f.envFile, 'BENCH_OPENROUTER_KEY=dotenv-key\n');
    const key = await openRouterKey(paramsSchema.parse({ apiKeyEnv: 'BENCH_OPENROUTER_KEY' }), { ...f, login, env: {} });
    expect(key).toBe('dotenv-key');
    expect(login).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

it('reuses saved OpenRouter credentials when env is absent, ignoring TypeSafe credentials', async () => {
  const f = await fixture(), login = vi.fn(async () => {});
  try {
    await writeFile(f.credentialsPath, JSON.stringify({ openrouter: 'saved-key', typesafe: 'other-provider-key' }));
    const key = await openRouterKey(paramsSchema.parse({}), { ...f, login, interactive: false, env: { OPENROUTER_API_KEY: ' ' } });
    expect(key).toBe('saved-key');
    expect(login).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

it('starts interactive OpenRouter login once and uses its saved key', async () => {
  const f = await fixture(), notify = vi.fn();
  try {
    const login = vi.fn(async () => { await writeFile(f.credentialsPath, JSON.stringify({ openrouter: 'authorized-key' })); });
    const key = await openRouterKey(paramsSchema.parse({}), { ...f, login, notify, interactive: true, env: {} });
    expect(key).toBe('authorized-key');
    expect(login).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Starting OpenRouter browser login'));
    expect(notify.mock.calls.flat().join(' ')).not.toContain('authorized-key');
  } finally { await f.dispose(); }
});

it('guides noninteractive callers to login, and stops if interactive login fails to save credentials', async () => {
  const f = await fixture(), login = vi.fn(async () => {});
  try {
    await writeFile(f.credentialsPath, JSON.stringify({ typesafe: 'other-provider-key' }));
    await expect(openRouterKey(paramsSchema.parse({}), { ...f, login, interactive: false, env: {} }))
      .rejects.toThrow('mise run login-openrouter');
    expect(login).not.toHaveBeenCalled();
    await expect(openRouterKey(paramsSchema.parse({}), { ...f, login, notify: () => {}, interactive: true, env: {} }))
      .rejects.toThrow('did not save an API key');
    expect(login).toHaveBeenCalledOnce();
  } finally { await f.dispose(); }
});

it('routes Jev to OpenRouter with the solver key despite conflicting ambient TypeSafe settings', async () => {
  const params = paramsSchema.parse({});
  const config = await benchmarkConfig(params, 'shared-openrouter-key', {
    S1S_PROVIDER: 'typesafe', S1S_API_KEY: 'typesafe-key', S1S_BASE_URL: 'https://api.typesafe.ai', S1S_MODEL: 'typesafe/jev-preview',
  });
  expect(config).toMatchObject({ provider: 'openrouter', apiKey: 'shared-openrouter-key', baseURL: 'https://openrouter.ai/api', model: 'jev-latest', retries: 0 });
  expect(() => paramsSchema.parse({ s1s: { provider: 'typesafe' } })).toThrow();
});
