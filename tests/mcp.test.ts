import { it, expect } from 'vitest';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, startHttp } from '../src/server.js';
import { SystemOne, type Evaluate } from '../src/system-one.js';
import { configSchema } from '../src/config.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const evaluate: Evaluate = async request => ({ model: 'jev-test', usage: { input_tokens: 10, output_tokens: 1 },
  answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, question.type === 'score'
    ? { type: 'score' as const, score: 1 } : { type: 'noul' as const, noul: 0.9 }])) });
it('exposes search and fixed-contract data evaluation tools', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-two-tools-'));
  const config = configSchema.parse({ roots: [dir] });
  const server = createServer(config, new SystemOne(config, evaluate));
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await writeFile(path.join(dir, 'auth.py'), 'def refresh_token(): pass');
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual(['search_code', 'search_file_contents', 'search_file_names', 'evaluate_boolean', 'evaluate_score']);
    for (const tool of tools.filter(tool => tool.name.startsWith('search_'))) expect(Object.keys(tool.inputSchema.properties!)).toEqual(tool.name === 'search_code'
      ? ['question', 'root_folder', 'gitignore'] : tool.name === 'search_file_contents'
      ? ['question', 'root_folder', 'gitignore', 'literal', 'files', 'topK'] : ['question', 'root_folder', 'gitignore', 'inspect']);
    for (const name of ['evaluate_boolean', 'evaluate_score']) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool.outputSchema).toBeDefined();
      expect(JSON.stringify(tool.inputSchema)).not.toContain('"discriminator"');
      const metric = name === 'evaluate_boolean' ? { id: 'relevant', question: 'Is it relevant?' }
        : { id: 'relevant', question: 'How relevant?', levels: ['low', 'high'] };
      const result = await client.callTool({ name, arguments: { question: 'Authentication',
        items: [{ id: 'web', data: { body: 'Refresh tokens' } }], metrics: [metric] } });
      expect(result.structuredContent).toMatchObject(name === 'evaluate_boolean'
        ? { results: [{ id: 'web', source_url: null, metrics: { relevant: { value: true, probability: 0.9 } } }] }
        : { results: [{ id: 'web', source_url: null, metrics: { relevant: { score: 1, level: 'high' } } }] });
      expect(result.isError).not.toBe(true);
    }
    expect((await client.listResources()).resources).toHaveLength(2);
    await client.ping(); await client.setLoggingLevel('warning');
    expect(client.getInstructions()).toContain('search_file_contents');
    const guide = await client.readResource({ uri: 's1s://search-guide' });
    expect(guide.contents[0]).toMatchObject({ text: client.getInstructions() });
    const names = await client.callTool({ name: 'search_file_names', arguments: { question: 'Find auth', root_folder: '.' } });
    expect(names.structuredContent).toMatchObject({ judged: 1, results: [{ path: 'auth.py', probability: 0.9 }] });
    const updates: number[] = [];
    const contents = await client.callTool({ name: 'search_file_contents', arguments: { question: 'Find auth', root_folder: '.' } }, undefined,
      { onprogress: update => { updates.push(update.progress); } });
    expect(contents.structuredContent).toMatchObject({ judged: 1, results: [{ path: 'auth.py', snippet: expect.stringContaining('refresh_token') }] });
    expect(updates).toEqual([1]);
    expect((await client.callTool({ name: 'search_file_names', arguments: { question: 'x', root_folder: '../' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'search_file_names', arguments: { question: 'x', files: ['*.py'] } })).isError).toBe(true);
    expect((await client.callTool({ name: 'search_file_names', arguments: { question: 'x', root_folder: 'missing' } })).isError).toBe(true);
  } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
it('serves Streamable HTTP with loopback host validation and optional bearer authentication', async () => {
  const token = 'test-token-1234567890';
  const dir = await mkdtemp(path.join(tmpdir(), 's1s-http-search-'));
  await writeFile(path.join(dir, 'a.py'), 'code');
  const listener = await startHttp(configSchema.parse({ port: 0, httpToken: token, roots: [dir] }), evaluate);
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const base = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: 'http-test', version: '1' });
  try {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    const badHost = await new Promise<number | undefined>(resolve => {
      const req = request(`${base}/health`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    expect(badHost).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const result = await client.callTool({ name: 'search_file_names', arguments: { question: 'x', root_folder: '.' } });
    expect(result.structuredContent).toMatchObject({ results: [{ path: 'a.py', probability: 0.9 }] });
  } finally { await client.close(); listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
it('starts the real CLI over stdio with protocol-clean stdout', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', '--dotenv', '/tmp/s1s-nonexistent-env'], stderr: 'pipe' }));
  try {
    expect((await client.listTools()).tools).toHaveLength(5);
    expect((await client.readResource({ uri: 's1s://search-guide' })).contents).toHaveLength(1);
  } finally { await client.close(); }
});
