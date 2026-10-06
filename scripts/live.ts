import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { SystemOne, type Primitive } from '../src/system-one.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../src/server.js';

// Acquire only synthetic public contents on the caller side, then inject state.
const requests = Object.fromEntries(await Promise.all((['noul', 'score', 'choice'] as const)
  .map(async type => [type, JSON.parse(await readFile(`examples/${type}.json`, 'utf8'))]))) as Record<Primitive, Record<string, unknown>>;
const ranking = JSON.parse(await readFile('examples/rank.json', 'utf8'));
for (const provider of ['openrouter', 'typesafe'] as const) {
  const config = await loadConfig({ provider, retries: 0 });
  assert(config.apiKey, `Missing ${provider} key`);
  const systemOne = new SystemOne(config);
  for (const type of ['noul', 'score', 'choice'] as const) {
    const result = await systemOne.run(type, requests[type]);
    assert(Object.values(result.answers).every(answer => answer.type === type));
    if (type === 'noul') assert(result.answers.relevant?.type === 'noul' && result.answers.relevant.noul > 0.5);
    if (type === 'choice') assert(result.answers.category?.type === 'choice' && result.answers.category.choice === 'auth');
    console.log(JSON.stringify({ provider, transport: 'direct', type, ...result }));
  }
}
const stdio = new Client({ name: 's1s-live', version: '1' });
await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], cwd: process.cwd(), stderr: 'pipe' }));
try {
  const result = await stdio.callTool({ name: 'noul', arguments: requests.noul });
  assert(!result.isError, JSON.stringify(result));
  assert((result.structuredContent as { answers: { relevant: { noul: number } } }).answers.relevant.noul > 0.5);
  console.log(JSON.stringify({ transport: 'stdio', ...result.structuredContent }));
  const ranked = await stdio.callTool({ name: 'rank_candidates', arguments: ranking });
  assert(!ranked.isError, JSON.stringify(ranked));
  assert.equal((ranked.structuredContent as { results: { id: string }[] }).results[0]?.id, 'auth');
  console.log(JSON.stringify({ transport: 'stdio', type: 'rank_candidates', ...ranked.structuredContent }));
} finally { await stdio.close(); }
const listener = await startHttp(await loadConfig({ port: 0 }));
const address = listener.address();
assert(address && typeof address !== 'string');
const http = new Client({ name: 's1s-live-http', version: '1' });
try {
  await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const result = await http.callTool({ name: 'choice', arguments: requests.choice });
  assert(!result.isError, JSON.stringify(result));
  assert.equal((result.structuredContent as { answers: { category: { choice: string } } }).answers.category.choice, 'auth');
  console.log(JSON.stringify({ transport: 'http', ...result.structuredContent }));
  const ranked = await http.callTool({ name: 'rank_candidates', arguments: ranking });
  assert(!ranked.isError, JSON.stringify(ranked));
  assert.equal((ranked.structuredContent as { results: { id: string }[] }).results[0]?.id, 'auth');
  console.log(JSON.stringify({ transport: 'http', type: 'rank_candidates', ...ranked.structuredContent }));
} finally {
  await http.close(); listener.closeAllConnections();
  await new Promise<void>(resolve => listener.close(() => resolve()));
}
