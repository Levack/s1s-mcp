import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import open from 'open';
import { input } from '@inquirer/prompts';

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(24).toString('base64url') };
}
export async function exchangeCode(code: string, verifier: string, fetcher = fetch) {
  const response = await fetcher('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`OAuth code exchange failed (HTTP ${response.status})`);
  const data = await response.json() as { key?: string };
  if (!data.key) throw new Error('OAuth response did not contain a key');
  return data.key;
}
export async function loginOpenRouter(headless: boolean, noBrowser: boolean) {
  const { verifier, challenge, state } = pkce();
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('key_label', 's1s-mcp');
  if (headless) {
    console.error(`Authorize OpenRouter: ${url}`);
    if (!noBrowser) await open(url.href).catch(() => {});
    const code = await input({ message: 'Paste the authorization code:' });
    return exchangeCode(code.trim(), verifier);
  }
  const { callback, callbackPath, port, codePromise, fail } = await createOAuthCallback(state);
  url.searchParams.set('callback_url', `http://127.0.0.1:${port}${callbackPath}`);
  url.searchParams.set('state', state);
  const timer = setTimeout(() => fail(new Error('OAuth timed out after 5 minutes')), 300000);
  const cancelled = () => fail(new Error('OAuth cancelled'));
  process.once('SIGINT', cancelled);
  try {
    console.error(`Authorize OpenRouter: ${url}`);
    if (!noBrowser) await open(url.href).catch(() => {});
    return await exchangeCode(await codePromise, verifier);
  } finally { clearTimeout(timer); process.off('SIGINT', cancelled); callback.close(); }
}

export async function createOAuthCallback(state: string) {
  let finish!: (code: string) => void;
  let fail!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const callbackPath = `/callback/${randomBytes(16).toString('hex')}`;
  const callback = createServer((req, res) => {
    const received = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (received.pathname !== callbackPath || received.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid callback'); return;
    }
    const code = received.searchParams.get('code');
    if (!code) { res.writeHead(400).end('Authorization failed'); fail(new Error('OAuth authorization denied or missing code')); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Authorization received. Return to your terminal.');
    finish(code);
  });
  await new Promise<void>((resolve, reject) => { callback.once('error', reject); callback.listen(0, '127.0.0.1', resolve); });
  const address = callback.address();
  if (!address || typeof address === 'string') throw new Error('Callback listener failed');
  return { callback, callbackPath, port: address.port, codePromise, fail };
}
