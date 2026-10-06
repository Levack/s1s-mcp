import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

it('evaluates injected JSON through CLI stdin and an explicit request file', async () => {
  const received: Record<string, unknown>[] = [];
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const input = JSON.parse(body);
    received.push(input);
    expect(req.url).toBe('/v1/systemone');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'jev-test', usage: { input_tokens: 2, output_tokens: 1 },
      answers: Object.fromEntries(Object.entries(input.questions).map(([id, q]) => [id,
        (q as { type: string }).type === 'noul' ? { type: 'noul', noul: 0.8 }
          : { type: 'choice', choice: 'auth', confidence: 1, probabilities: { auth: 1, other: 0 } },
      ])) }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('No test provider address');
  const directory = await mkdtemp(path.join(tmpdir(), 's1s-primitive-cli-'));
  const run = async (args: string[], stdin = '') => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.resolve('src/cli.ts'),
      ...args, '--api-key', 'placeholder', '--base-url', `http://127.0.0.1:${address.port}`, '--retries', '0'],
    { cwd: directory, env: { ...process.env, S1S_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    child.stdin.end(stdin);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    const state = { contents: '認証情報の説明', path: '/nonexistent', url: 'https://invalid.invalid/' };
    expect(await run(['noul'], JSON.stringify({ state, questions: { q: {} } }))).toMatchObject({ answers: { q: { noul: 0.8 } } });
    const requestFile = path.join(directory, 'request.json');
    await writeFile(requestFile, JSON.stringify({ state, questions: { category: { criteria: { auth: 'Authentication', other: null } } } }));
    expect(await run(['choice', requestFile])).toMatchObject({ answers: { category: { choice: 'auth' } } });
    expect(received.map(request => request.state)).toEqual([state, state]);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
