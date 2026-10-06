#!/usr/bin/env node
import { Command, Option } from 'commander';
import { version } from './version.js';
import { password, select } from '@inquirer/prompts';
import { readFile } from 'node:fs/promises';
import { loadConfig, storagePaths, readJson, savePrivateJson, publicConfig } from './config.js';
import { loginOpenRouter } from './oauth.js';
import { startStdio, startHttp } from './server.js';
import { Ranker } from './rank.js';
import { SystemOne, safeError, type Primitive } from './system-one.js';

const program = new Command().name('s1s-mcp').version(version).description('Filter and rank client-acquired context with System One');
const configOptions = () => ({ ...program.opts(), baseURL: program.opts().baseUrl, envFile: program.opts().dotenv });
program
  .option('--config <file>', 'Explicit JSON configuration file')
  .option('--credentials <file>', 'Explicit private credentials file')
  .addOption(new Option('--scope <scope>', 'Credential scope and login/logout storage location').choices(['user', 'project']).default('user'))
  .option('--dotenv <file>', 'dotenv path', '.env')
  .addOption(new Option('--provider <name>', 'Model provider').choices(['openrouter', 'typesafe']))
  .option('--model <id>', 'System One model ID')
  .option('--api-key <key>', 'Provider API key (prefer env to avoid shell history)')
  .option('--base-url <url>', 'Compatible System One API root')
  .addOption(new Option('--transport <name>', 'MCP transport').choices(['stdio', 'http']))
  .option('--host <host>', 'Loopback bind address')
  .option('--port <number>', 'HTTP port')
  .option('--roots <paths...>', 'Allowed file roots for the direct rank command')
  .option('--concurrency <number>', 'Maximum concurrent model calls')
  .option('--batch-size <number>', 'Maximum candidates per request')
  .option('--max-file-bytes <number>', 'Maximum UTF-8 candidate size')
  .option('--max-batch-bytes <number>', 'Maximum encoded provider request size')
  .option('--timeout <ms>', 'Timeout per model attempt')
  .option('--retries <number>', 'Retry limit')
  .option('--http-token <token>', 'Optional HTTP bearer secret')
  .action(async () => {
    const config = await loadConfig(configOptions());
    if (config.transport === 'stdio') {
      const server = await startStdio(config);
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
    } else {
      const listener = await startHttp(config);
      const address = listener.address();
      console.error(`s1s-mcp listening at http://${config.host}:${typeof address === 'object' ? address?.port : config.port}/mcp`);
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
        listener.close(() => process.exit(0));
        listener.closeAllConnections();
      });
    }
  });
program.command('config').description('Print effective configuration without secrets').action(async () => {
  console.log(JSON.stringify(publicConfig(await loadConfig(configOptions())), null, 2));
});
program.command('login').description('Log in with OpenRouter browser authorization or a provider API key')
  .option('--headless', 'Paste authorization code instead of localhost callback')
  .option('--no-browser', 'Print URL without launching a browser')
  .addOption(new Option('--auth-method <method>', 'OpenRouter authentication method').choices(['oauth', 'api-key']))
  .action(async (options: { headless?: boolean; browser: boolean; authMethod?: string }) => {
    const provider = program.opts().provider ?? (process.stdin.isTTY
      ? await select({ message: 'Provider', choices: [{ name: 'OpenRouter', value: 'openrouter' }, { name: 'TypeSafe AI', value: 'typesafe' }] })
      : 'openrouter');
    const suppliedKey = program.opts().apiKey;
    const method = suppliedKey !== undefined || provider === 'typesafe' ? 'api-key'
      : options.authMethod ?? (process.stdin.isTTY && !options.headless
        ? await select({ message: 'OpenRouter authentication', choices: [
          { name: 'Browser authorization (OAuth)', value: 'oauth' },
          { name: 'API key', value: 'api-key' },
        ] }) : 'oauth');
    if (method === 'api-key' && suppliedKey === undefined && !process.stdin.isTTY) {
      throw new Error('API-key login requires a terminal for masked input or an explicit --api-key. For scripts, provider API-key environment variables are also supported.');
    }
    const key = method === 'oauth' ? await loginOpenRouter(Boolean(options.headless), !options.browser)
      : String(suppliedKey ?? await password({ message: `${provider} API key (masked):`, mask: '*' })).trim();
    if (!key) throw new Error('API key is required');
    const { credentials, config } = storagePaths(program.opts());
    await savePrivateJson(credentials, { ...await readJson(credentials), [provider]: key });
    await savePrivateJson(config, { ...await readJson(config), provider });
    console.error(`${provider} credentials saved to ${credentials} with mode 0600.`);
  });
program.command('logout').description('Remove saved credentials for the selected provider and scope').action(async () => {
  const { credentials } = storagePaths(program.opts());
  const provider = program.opts().provider ?? 'openrouter';
  const stored = await readJson(credentials);
  if (Object.hasOwn(stored, provider)) {
    delete stored[provider];
    await savePrivateJson(credentials, stored);
  }
  console.error(`Locally saved ${provider} credentials removed from ${credentials}. Environment and config API keys still apply; revoke the provider key to invalidate it.`);
});
program.command('rank <json-file>').description('Run a ranking request directly from JSON').action(async file => {
  const config = await loadConfig(configOptions());
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const result = await new Ranker(config).rank(JSON.parse(await readFile(file, 'utf8')), controller.signal);
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
  } finally { process.off('SIGINT', cancel); }
});
for (const type of ['noul', 'score', 'choice'] as const satisfies readonly Primitive[]) {
  program.command(`${type} [json-file]`).description(`Evaluate ${type} questions from JSON; omit the file or use - for stdin`)
    .action(async (file = '-') => {
      const config = await loadConfig(configOptions());
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      try {
        let text = '';
        if (file === '-') {
          process.stdin.setEncoding('utf8');
          for await (const chunk of process.stdin) {
            text += chunk.toString();
            if (Buffer.byteLength(text) > config.maxBatchBytes) throw new Error('Input exceeds maxBatchBytes');
          }
        } else text = await readFile(file, 'utf8');
        const result = await new SystemOne(config).run(type, JSON.parse(text), controller.signal);
        console.log(JSON.stringify(result, null, 2));
      } finally { process.off('SIGINT', cancel); }
    });
}
try { await program.parseAsync(); }
catch (error) {
  // Do not print provider response bodies, candidate contents, or credentials.
  if (error instanceof Error && error.name === 'ZodError') console.error('Invalid configuration or request; check documented field constraints.');
  else console.error(safeError(error));
  process.exitCode = 1;
}
