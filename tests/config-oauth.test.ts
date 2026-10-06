import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, savePrivateJson, publicConfig } from '../src/config.js';
import { pkce, exchangeCode } from '../src/oauth.js';
it('resolves CLI > environment > config, supports existing key names and stored OAuth credentials', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-config-'));
  const config = path.join(dir, 'config.json'); const credentials = path.join(dir, 'credentials.json');
  try {
    await savePrivateJson(config, { provider: 'openrouter', model: 'file-model' });
    await savePrivateJson(credentials, { openrouter: 'oauth-secret', typesafe: 'typesafe-secret' });
    const options = { config, credentials, envFile: path.join(dir, 'missing') };
    expect((await loadConfig(options, {})).apiKey).toBe('oauth-secret');
    const loaded = await loadConfig({ ...options, model: 'cli-model' }, { S1S_MODEL: 'env-model', OPEN_ROUTER_API_KEY: 'env-key' });
    expect(loaded.model).toBe('cli-model'); expect(loaded.apiKey).toBe('env-key');
    expect((await loadConfig({ ...options, provider: 'typesafe' }, { TYPE_SAFE_AI_API_KEY: 'direct-key' })).apiKey).toBe('direct-key');
    expect(JSON.stringify(publicConfig(loaded))).not.toContain('env-key');
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
  } finally { await rm(dir, { recursive: true }); }
});
it('generates S256 PKCE and exchanges only against the official endpoint', async () => {
  const { verifier, challenge, state } = pkce();
  expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  expect(verifier.length).toBeGreaterThanOrEqual(43); expect(state.length).toBeGreaterThan(20);
  const key = await exchangeCode('one-time-code', verifier, async (url, init) => {
    expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'one-time-code', code_verifier: verifier, code_challenge_method: 'S256' });
    return new Response(JSON.stringify({ key: 'stored-secret' }));
  });
  expect(key).toBe('stored-secret');
  await expect(exchangeCode('x', verifier, async () => new Response('secret-data', { status: 403 }))).rejects.toThrow('HTTP 403');
});

it('validates real loopback OAuth callbacks, rejects CSRF and returns a valid authorization code', async () => {
  const { createOAuthCallback } = await import('../src/oauth.js');
  const callback = await createOAuthCallback('expected-state');
  const url = `http://127.0.0.1:${callback.port}${callback.callbackPath}`;
  try {
    expect((await fetch(`${url}?state=attacker&code=bad`)).status).toBe(400);
    expect((await fetch(`${url}?state=expected-state&code=valid-code`)).status).toBe(200);
    expect(await callback.codePromise).toBe('valid-code');
  } finally { callback.callback.closeAllConnections(); await new Promise<void>(resolve => callback.callback.close(() => resolve())); }
});
