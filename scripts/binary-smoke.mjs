import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const binary = path.resolve(process.argv[2] ?? '.s1s/bin/s1s-mcp');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 's1s-binary-'));
const env = { ...process.env, S1S_HOME: path.join(temporary, 'user') };
for (const key of Object.keys(env)) {
  if (key.startsWith('S1S_') && key !== 'S1S_HOME' || /^(OPENROUTER_|OPEN_ROUTER_|TYPESAFE_|TYPE_SAFE_AI_)/.test(key)) delete env[key];
}
const run = promisify(execFile);
const options = { cwd: temporary, env, timeout: 15000 };
const client = new Client({ name: 'binary-smoke', version: '1' });
try {
  assert.equal((await run(binary, ['--version'], options)).stdout.trim(), version);
  assert.match((await run(binary, ['--help'], options)).stdout, /login/);
  await run(binary, ['login', '--provider', 'openrouter', '--api-key', 'binary-smoke-placeholder'], options);
  const config = JSON.parse((await run(binary, ['config'], options)).stdout);
  assert.equal(config.configured, true);
  assert.deepEqual(config.roots, [temporary]);
  await client.connect(new StdioClientTransport({ command: binary, cwd: temporary, env, stderr: 'pipe' }), { timeout: 15000 });
  assert.equal(client.getServerVersion()?.version, version);
  assert((await client.listTools()).tools.length > 0, 'The binary must expose MCP tools');
  assert.equal((await client.readResource({ uri: 's1s://configuration' })).contents.length, 1);
  await client.ping();
  await client.close();
  await run(binary, ['logout'], options);
  assert.deepEqual(JSON.parse(await readFile(path.join(env.S1S_HOME, 'credentials.json'), 'utf8')), {});
  console.log('Standalone binary: version, help, login/config/logout, and MCP stdio passed outside the checkout.');
} finally {
  await client.close();
  await rm(temporary, { recursive: true, force: true });
}
