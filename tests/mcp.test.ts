import { it, expect } from 'vitest';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, startHttp } from '../src/server.js';
import { SystemOne, type Evaluate } from '../src/system-one.js';
import { configSchema } from '../src/config.js';
const evaluate: Evaluate = async request => ({ model: 'jev-test', usage: { input_tokens: 10, output_tokens: 1 },
  answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul' as const, noul: 0.9 }])) });
it('exposes evaluation tools and resources, validates schemas and returns raw MCP results', async () => {
  const config = configSchema.parse({});
  const server = createServer(config, new SystemOne(config, evaluate));
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['noul', 'score', 'choice', 'rank_candidates']);
    expect((await client.listResources()).resources).toHaveLength(2);
    await client.ping();
    await client.setLoggingLevel('warning');
    const resource = await client.readResource({ uri: 's1s://configuration' });
    expect(resource.contents[0]).toMatchObject({ text: expect.stringContaining('configured') });
    expect((await client.getPrompt({ name: 'system-one-search', arguments: { purpose: 'API auth' } })).messages[0]?.content)
      .toMatchObject({ text: expect.stringContaining('API auth') });
    const result = await client.callTool({ name: 'noul', arguments: { state: 'Bearer auth', questions: { relevant: { instructions: 'Does this explain authentication?' } } } });
    expect(result.structuredContent).toMatchObject({ answers: { relevant: { type: 'noul', noul: 0.9 } } });
    const invalid = await client.callTool({ name: 'noul', arguments: { state: 'Auth', questions: {} } });
    expect(invalid.isError).toBe(true);
    const updates: number[] = [];
    const ranked = await client.callTool({ name: 'rank_candidates', arguments: {
      purpose: 'Find authentication context', candidates: [{ id: 'auth', content: 'Bearer auth' }], topK: 1,
    } }, undefined, { onprogress: update => { updates.push(update.progress); } });
    expect(ranked.structuredContent).toMatchObject({ results: [{ id: 'auth', score: 0.9 }], evaluatedCandidates: 1 });
    expect(updates).toEqual([1]);
    const pathInput = await client.callTool({ name: 'rank_candidates', arguments: {
      purpose: 'Find authentication context', candidates: [{ id: 'secret', path: '/etc/passwd' }],
    } });
    expect(pathInput.isError).toBe(true);
    const mixedInput = await client.callTool({ name: 'rank_candidates', arguments: {
      purpose: 'Find authentication context', candidates: [{ id: 'secret', content: 'x', path: '/etc/passwd' }],
    } });
    expect(mixedInput.isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});
it('serves Streamable HTTP with loopback host validation and optional bearer authentication', async () => {
  const token = 'test-token-1234567890';
  const listener = await startHttp(configSchema.parse({ port: 0, httpToken: token }), evaluate);
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
    const result = await client.callTool({ name: 'noul', arguments: { state: 'x', questions: { a: {} } } });
    expect(result.structuredContent).toMatchObject({ answers: { a: { noul: 0.9 } } });
  } finally { await client.close(); listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
});
it('starts the real CLI over stdio with protocol-clean stdout', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', '--dotenv', '/tmp/s1s-nonexistent-env'], stderr: 'pipe' }));
  try {
    expect((await client.listTools()).tools).toHaveLength(4);
    expect((await client.readResource({ uri: 's1s://search-guide' })).contents).toHaveLength(1);
  } finally { await client.close(); }
});
