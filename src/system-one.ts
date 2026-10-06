import { z } from 'zod';
import pLimit from 'p-limit';
import { TypeSafeClient, APIError, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk';
import type { Config } from './config.js';

// Jev accepts text, JSON objects/arrays, and null, including structured rubrics.
const entry = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json()), z.null()]);
const instructions = entry.optional();
const questions = <T extends z.ZodType>(question: T) => z.record(z.string().min(1), question)
  .refine(value => Object.keys(value).length > 0, 'Provide at least one question');
const common = { state: entry, model: z.string().min(1).optional() };
export const primitiveSchemas = {
  noul: z.object({ ...common, questions: questions(z.strictObject({
    type: z.literal('noul').optional(), instructions,
    criteria: z.strictObject({ true: entry.optional(), false: entry.optional() }).nullable().optional(),
  })) }).strict(),
  score: z.object({ ...common, questions: questions(z.strictObject({
    type: z.literal('score').optional(), instructions, criteria: z.array(entry).min(2).max(10),
  })) }).strict(),
  choice: z.object({ ...common, questions: questions(z.strictObject({
    type: z.literal('choice').optional(), instructions,
    criteria: z.record(z.string().min(1), entry).refine(value => {
      const count = Object.keys(value).length;
      return count >= 2 && count <= 255;
    }, 'Choice requires 2–255 options'),
  })) }).strict(),
};
export type Primitive = keyof typeof primitiveSchemas;
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
  async run(type: Primitive, raw: unknown, signal?: AbortSignal): Promise<SystemOneResult<Questions>> {
    const input = primitiveSchemas[type].parse(raw);
    const request: SystemOneRequest = { state: input.state, model: input.model ?? this.config.model,
      questions: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => [id, { ...question, type }])) as Questions };
    const result = await this.evaluateRequest(request, signal);
    for (const id of Object.keys(request.questions)) {
      if (result.answers[id]?.type !== type) throw new Error('Provider returned a missing or mismatched answer');
    }
    return result;
  }
  async evaluateRequest(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResult<Questions>> {
    if (Buffer.byteLength(JSON.stringify(request)) > this.config.maxBatchBytes) {
      throw new Error('Request exceeds maxBatchBytes; inject a smaller excerpt or fewer questions');
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
