import pLimit from 'p-limit';
import { TypeSafeClient, APIError, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk';
import type { Config } from './config.js';

export type Evaluate = (request: SystemOneRequest, signal?: AbortSignal) => Promise<SystemOneResult<Questions>>;
export function providerEvaluate(config: Config): Evaluate {
  if (!config.apiKey) throw new Error('No provider API key. Set an environment variable or run s1s-mcp login.');
  const client = new TypeSafeClient({ apiKey: config.apiKey, defaultModel: config.model,
    baseURL: config.baseURL ?? (config.provider === 'openrouter' ? 'https://openrouter.ai/api' : 'https://api.typesafe.ai'),
    timeout: config.timeout, retry: { maxRetries: config.retries }, logLevel: 'off' });
  return (request, signal) => client.systemOne(request, { signal });
}
export function safeError(error: unknown): string {
  if (error instanceof APIError) return `Provider HTTP ${error.status}${error.requestId ? ` (request ${error.requestId})` : ''}`;
  if (error instanceof Error && /^(API|TypeSafe)/.test(error.name)) return `Provider request failed (${error.name})`;
  return error instanceof Error ? error.message : 'Evaluation failed';
}

export class SystemOne {
  private readonly limit;
  constructor(readonly config: Config, private readonly evaluate?: Evaluate) { this.limit = pLimit(config.concurrency); }
  async evaluateRequest(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResult<Questions>> {
    if (Buffer.byteLength(JSON.stringify(request)) > this.config.maxBatchBytes) {
      throw new Error('Request exceeds maxBatchBytes');
    }
    signal?.throwIfAborted();
    return this.limit(async () => {
      signal?.throwIfAborted();
      const result = await (this.evaluate ?? providerEvaluate(this.config))(request, signal);
      signal?.throwIfAborted();
      return result;
    });
  }
}
