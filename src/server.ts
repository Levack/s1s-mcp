import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { version } from './version.js';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { publicConfig } from './config.js';
import { SystemOne, primitiveSchemas, safeError, type Evaluate, type Primitive } from './system-one.js';
import { Ranker, inlineRankSchema } from './rank.js';

export function createServer(config: Config, systemOne = new SystemOne(config)) {
  const server = new McpServer({ name: 's1s-mcp', version }, {
    capabilities: { logging: {} },
    instructions: 'Filter and rank candidate contents acquired by the client CLI within its permission scope. Use rank_candidates for bulk context selection, noul for inclusion probabilities, score for relevance rubrics, and choice for context categories. Read files or fetch web pages using the client CLI permission-controlled tools, then inject their contents. Paths and URLs in state are ordinary text; this server does not read or fetch them. Contents are sent to the configured provider.',
  });
  const descriptions: Record<Primitive, string> = {
    noul: 'Evaluate yes/no questions with Jev and return each raw noul probability (0–1).',
    score: 'Evaluate ordered rubrics with Jev. Criteria contain 2–10 levels; raw scores range from 0 to the last level index, without normalization.',
    choice: 'Evaluate categorical questions with Jev. Criteria map 2–255 option labels to descriptions; return selected labels, probabilities, and confidence.',
  };
  for (const type of ['noul', 'score', 'choice'] as const) {
    server.registerTool(type, {
      description: `${descriptions[type]} Supply state and a map of questions keyed by answer ID. Inject contents obtained by the client CLI; no file paths or URLs are dereferenced.`,
      inputSchema: primitiveSchemas[type],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (input: unknown, extra: Parameters<ToolCallback<typeof primitiveSchemas.noul>>[1]) => {
      try {
        const result = await systemOne.run(type, input, extra.signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result } };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: safeError(error) }] }; }
    });
  }
  const ranker = new Ranker(config, (request, signal) => systemOne.evaluateRequest(request, signal));
  server.registerTool('rank_candidates', {
    description: 'Filter and rank contents already obtained by the client CLI under its permissions. Supply purpose, candidate IDs and actual content, plus optional Noul/Score rubrics, threshold and topK. File paths and URL-only inputs are not supported. Return ranked IDs, normalized ranking values, raw evaluations, and candidate errors.',
    inputSchema: inlineRankSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    try {
      const token = extra._meta?.progressToken;
      const result = await ranker.rank(input, extra.signal, token === undefined ? undefined : async (progress, total) => {
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total } });
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result },
        ...(result.evaluatedCandidates === 0 ? { isError: true } : {}) };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: safeError(error) }] }; }
  });
  server.registerResource('configuration', 's1s://configuration', { mimeType: 'application/json', description: 'Effective configuration without credentials' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(publicConfig(config), null, 2) }],
  }));
  server.registerResource('search-guide', 's1s://search-guide', { mimeType: 'text/plain' }, async uri => ({
    contents: [{ uri: uri.href, text: '1. Retrieve a shortlist of files or pages with your client CLI tools and permissions.\n2. Pass actual contents to rank_candidates with a purpose and rubric to filter and rank context.\n3. Use noul, score, or choice against injected state when you need individual inclusion, relevance, or category judgments.\n4. Inspect errors and uncertainty before selecting context. The server never retrieves file or web contents.' }],
  }));
  server.registerPrompt('system-one-search', {
    description: 'Filter and rank context acquired by the client CLI', argsSchema: { purpose: z.string() },
  }, ({ purpose }) => ({ messages: [{ role: 'user', content: { type: 'text', text:
    `Find context for: ${purpose}\nUse your client CLI file and Web tools within their permissions to obtain a shortlist. Inject the actual contents into rank_candidates with explicit criteria. Use noul, score, or choice for inclusion, relevance, or category judgments as needed. Inspect errors and uncertainty before selecting context. MCP does not acquire additional content.` } }] }));
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
