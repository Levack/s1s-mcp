import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { Screener } from '../src/screen.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../src/server.js';

// Only synthetic public texts are sent to the providers.
const types = ['filter', 'rate', 'classify'] as const;
const requests = Object.fromEntries(await Promise.all(types
  .map(async type => [type, JSON.parse(await readFile(`examples/${type}.json`, 'utf8'))]))) as Record<typeof types[number], Record<string, unknown>>;
const check = {
  filter: (r: Record<string, unknown>) => assert.deepEqual((r.results as { id: string }[]).map(x => x.id), ['auth']),
  rate: (r: Record<string, unknown>) => assert.equal((r.results as { id: string }[])[0]?.id, 'notes'),
  classify: (r: Record<string, unknown>) => assert.deepEqual((r.groups as Record<string, { id: string }[]>).auth?.map(x => x.id), ['keys']),
};
for (const provider of ['openrouter', 'typesafe'] as const) {
  const config = await loadConfig({ provider, retries: 0 });
  assert(config.apiKey, `Missing ${provider} key`);
  const screener = new Screener(config);
  for (const type of types) {
    const result = await screener[type](requests[type]);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    check[type](result as unknown as Record<string, unknown>);
    console.log(JSON.stringify({ provider, transport: 'direct', type, ...result }));
  }
}
const fixture = await mkdtemp(path.join(tmpdir(), 's1s-live-files-'));
await writeFile(path.join(fixture, 'auth.py'), 'def refresh_token(): pass');
const searchInput = { question: 'Find token refresh implementation', root_folder: '.' };
try {
const stdio = new Client({ name: 's1s-live', version: '1' });
await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), S1S_ROOTS: fixture }, stderr: 'pipe' }));
try {
  const result = await stdio.callTool({ name: 'search_file_names', arguments: searchInput });
  assert(!result.isError, JSON.stringify(result));
  assert.equal(result.structuredContent?.judged, 1);
  console.log(JSON.stringify({ transport: 'stdio', type: 'search_file_names', ...result.structuredContent }));
} finally { await stdio.close(); }
const listener = await startHttp(await loadConfig({ port: 0, roots: [fixture] }));
const address = listener.address();
assert(address && typeof address !== 'string');
const http = new Client({ name: 's1s-live-http', version: '1' });
try {
  await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const result = await http.callTool({ name: 'search_file_contents', arguments: searchInput });
  assert(!result.isError, JSON.stringify(result));
  assert.equal(result.structuredContent?.judged, 1);
  console.log(JSON.stringify({ transport: 'http', type: 'search_file_contents', ...result.structuredContent }));
} finally {
  await http.close(); listener.closeAllConnections();
  await new Promise<void>(resolve => listener.close(() => resolve()));
}

} finally { await rm(fixture, { recursive: true, force: true }); }
