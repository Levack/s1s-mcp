import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 's1s-package-'));
const npmCache = path.join(temporary, 'npm-cache');
const userStorage = path.join(temporary, 'user-storage');
async function run(command, args, cwd = temporary) {
  return exec(command, args, { cwd, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, S1S_HOME: userStorage, npm_config_cache: npmCache,
      npm_config_cache_dir: path.join(temporary, 'pnpm-cache'),
      npm_config_store_dir: path.join(temporary, 'pnpm-store') } });
}
try {
  await run('pnpm', ['pack', '--pack-destination', temporary], root);
  const tarball = path.join(temporary, (await readdir(temporary)).find(name => name.endsWith('.tgz')));
  const { stdout: listing } = await run('tar', ['-tzf', tarball]);
  const files = listing.trim().split('\n');
  assert(files.includes('package/dist/cli.js'));
  assert(files.includes('package/README.md'));
  assert(files.every(file => /^package\/(?:dist\/|examples\/|package\.json$|README\.md$)/.test(file)), 'Unexpected file in package');
  const { stdout: cli } = await run('tar', ['-xOf', tarball, 'package/dist/cli.js']);
  assert(cli.startsWith('#!/usr/bin/env node\n'), 'Missing executable shebang');
  console.log(`Package contents verified (${files.length} files; no credentials, source, or stores).`);

  const npxArgs = ['--yes', `--package=${tarball}`, 's1s-mcp'];
  const npxVersion = await run('npx', [...npxArgs, '--version']);
  assert.equal(npxVersion.stdout.trim(), manifest.version);
  console.log('npx launches the packed CLI outside the source checkout.');

  const dlxArgs = ['dlx', tarball];
  const dlxVersion = await run('pnpm', [...dlxArgs, '--version']);
  assert.equal(dlxVersion.stdout.trim(), manifest.version);
  console.log('pnpm dlx launches the packed CLI.');

  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ private: true, scripts: { 'search:mcp': 's1s-mcp' } }));
  await run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund', tarball]);
  const scriptedVersion = await run('pnpm', ['run', 'search:mcp', '--version']);
  assert(scriptedVersion.stdout.trim().endsWith(manifest.version));
  const installed = await readFile(path.join(temporary, 'node_modules', manifest.name, 'package.json'), 'utf8');
  assert.equal(JSON.parse(installed).version, manifest.version);
  console.log('Installed package runs through a project script without build/install scripts.');

  await mkdir(userStorage);
  await writeFile(path.join(userStorage, 'credentials.json'), JSON.stringify({ openrouter: 'package-smoke-placeholder' }), { mode: 0o600 });

  const client = new Client({ name: 'package-smoke', version: '1' });
  const transport = new StdioClientTransport({ command: 'npx', args: [...npxArgs, '--roots', temporary], cwd: temporary,
    env: { ...process.env, S1S_HOME: userStorage, npm_config_cache: npmCache,
      npm_config_cache_dir: path.join(temporary, 'pnpm-cache'),
      npm_config_store_dir: path.join(temporary, 'pnpm-store') }, stderr: 'pipe' });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.version, manifest.version);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['noul', 'score', 'choice', 'rank_candidates']);
    const configuration = await client.readResource({ uri: 's1s://configuration' });
    const effective = JSON.parse(configuration.contents[0].text);
    assert.deepEqual(effective.roots, [temporary]);
    assert.equal(effective.configured, true, 'Packed CLI must load the saved user login');
    await client.ping();
    console.log('Packed CLI initializes over npx stdio, exposes tools/resources, and responds to ping.');
  } finally { await client.close(); }
} finally { await rm(temporary, { recursive: true, force: true }); }
