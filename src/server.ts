import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { version } from './version.js';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { publicConfig } from './config.js';
import { SystemOne, safeError, type Evaluate } from './system-one.js';
import { searchGuide as guide } from './search-guide.js';
import { FolderSearch, nameSearchSchema, contentSearchSchema } from './folder-search.js';
import type { ScreenStats } from './screen.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { CodeSearch, codeSearchSchema } from './code-search.js';
import { evaluateBoolean, evaluateBooleanSchema, evaluateBooleanOutputSchema,
  evaluateScore, evaluateScoreSchema, evaluateScoreOutputSchema } from './evaluate-data.js';

export function createServer(config: Config, systemOne = new SystemOne(config)) {
  const server = new McpServer({ name: 's1s-mcp', version }, { capabilities: { logging: {} }, instructions: guide });
  const search = new FolderSearch(config, (request, signal) => systemOne.evaluateRequest(request, signal));
  const code = new CodeSearch(config, (request, signal) => systemOne.evaluateRequest(request, signal));
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const handler = (run: (raw: unknown, signal?: AbortSignal, progress?: (completed: number, total: number) => Promise<void>) => Promise<ScreenStats>) =>
    async (input: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      try {
        const token = extra._meta?.progressToken;
        const result = await run(input, extra.signal, token === undefined ? undefined : async (progress, total) => {
          await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total } });
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result },
          ...(result.judged === 0 && !('basis' in result && result.basis === 'literal' && !result.limitReached
              && (result.matched > result.errors.length || !result.errors.length))
            && !('listingComplete' in result && (result.matched === 0 || ('mode' in result && result.mode === 'list'))) ? { isError: true } : {}) };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: safeError(error) }] }; }
    };
  server.registerTool('search_code', { annotations, inputSchema: codeSearchSchema,
    description: 'One-call code search: give the complete question or issue and receive relevant files, line ranges and source evidence. The tool discovers filenames, selects candidates and inspects their contents internally; do not call name search first. Omit root_folder to search the repository. For broad scopes, it inspects up to five likely files and returns up to two relevant chunks per file, plus other candidate paths. Small scopes are read directly. Use this as the primary search operation; returned coverage describes what was actually inspected.' },
    handler((raw, signal) => code.search(raw, signal)));
  server.registerTool('search_file_contents', { annotations, inputSchema: contentSearchSchema,
    description: 'Search code and return paths, line numbers and source context in ONE call. If you know a symbol or exact text, set literal for fast local search with no provider cost (up to 5000 files / 32 MB); no name search is needed first. Otherwise, semantically evaluate all candidate contents (up to 80 files / 800 KB). Omit root_folder for the repository or supply a relative folder; files optionally selects paths/globs. Default topK=5. Literal results are path-ordered; semantic results are relevance-ranked. Read further context when needed.' },
    handler((raw, signal, progress) => search.search(raw, 'contents', signal, progress)));
  server.registerTool('search_file_names', { annotations, inputSchema: nameSearchSchema,
    description: 'Broad conceptual discovery when neither filenames nor exact symbols are known. For a known symbol or string, use search_file_contents with literal instead: it returns source context without provider cost. This tool evaluates every filename with Jev. Set inspect=true to also evaluate the top three files and return source evidence in the same call. Omit root_folder for the repository; never pass an absolute path. Optional gitignore excludes paths. Up to 5000 filenames. Only shortlisted contents are inspected.' },
    handler((raw, signal, progress) => search.search(raw, 'names', signal, progress)));
  const evaluationHandler = (run: typeof evaluateBoolean | typeof evaluateScore) =>
    async (input: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      try {
        const token = extra._meta?.progressToken;
        const result = await run(input, systemOne, extra.signal, token === undefined ? undefined : async (progress, total) => {
          await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total } });
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result,
          ...(result.judged === 0 ? { isError: true } : {}) };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: safeError(error) }] }; }
    };
  server.registerTool('evaluate_boolean', { annotations, inputSchema: evaluateBooleanSchema, outputSchema: evaluateBooleanOutputSchema,
    description: 'Judge supplied web content, arbitrary JSON or candidate answers against a question using boolean criteria. Every successful metric returns value (boolean) and probability (0–1). Low probabilities and false decisions are retained. Source URLs are attribution only; supply actual content.' },
    evaluationHandler(evaluateBoolean));
  server.registerTool('evaluate_score', { annotations, inputSchema: evaluateScoreSchema, outputSchema: evaluateScoreOutputSchema,
    description: 'Score supplied web content, arbitrary JSON or candidate answers against a question on custom ordered scales. Every successful metric returns score (0–1, first to last level) and level (nearest label). All scores are retained. Source URLs are attribution only; supply actual content.' },
    evaluationHandler(evaluateScore));
  server.registerResource('configuration', 's1s://configuration', { mimeType: 'application/json', description: 'Effective configuration without credentials' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(publicConfig(config), null, 2) }],
  }));
  server.registerResource('search-guide', 's1s://search-guide', { mimeType: 'text/plain' }, async uri => ({
    contents: [{ uri: uri.href, text: guide }],
  }));
  server.registerPrompt('system-one-search', {
    description: 'Find relevant files and context by judging many files at once', argsSchema: { purpose: z.string() },
  }, ({ purpose }) => ({ messages: [{ role: 'user', content: { type: 'text', text:
    `Find context for: ${purpose}\n${guide}` } }] }));
  return server;
}
export async function startStdio(config: Config) {
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  return server;
}
export async function startHttp(config: Config, evaluate?: Evaluate) {
  const app = express();
  app.use(localhostHostValidation());
  app.use((req, res, next) => {
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        const validHost = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
        if (!validHost || origin.protocol !== 'http:' || Number(origin.port || 80) !== req.socket.localPort) {
          res.status(403).json({ error: 'Invalid origin' }); return;
        }
      } catch { res.status(403).json({ error: 'Invalid origin' }); return; }
    }
    next();
  });
  app.use(express.json({ limit: '16mb' }));
  const systemOne = new SystemOne(config, evaluate);
  app.get('/health', (_req, res) => res.json({ status: 'ok', name: 's1s-mcp' }));
  app.all('/mcp', async (req, res) => {
    if (config.httpToken) {
      const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const expected = Buffer.from(config.httpToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.status(401).json({ error: 'Invalid bearer token' }); return;
      }
    }
    if (req.method !== 'POST') { res.status(405).set('Allow', 'POST').end(); return; }
    const server = createServer(config, systemOne);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });
  const listener = app.listen(config.port, config.host);
  await new Promise<void>((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  return listener;
}
