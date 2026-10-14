import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface ToolUsage { calls: number; errors: number; durationMs: number }
export type Tools = Record<string, ToolUsage>;

export function recordTool(tools: Tools, name: string, durationMs: number, result: unknown) {
  const entry = Object.hasOwn(tools, name) ? tools[name]! : (tools[name] = { calls: 0, errors: 0, durationMs: 0 });
  entry.calls++;
  const failed = typeof result === 'object' && result !== null
    && (('isError' in result && result.isError === true) || ('error' in result));
  // Shell nonzero exit codes are also failed invocations; the agent may recover.
  const shellFailed = typeof result === 'string' && /^exit=(?!0(?:\n|$))[^\n]+(?:\n|$)/.test(result);
  entry.errors += Number(failed || shellFailed);
  entry.durationMs += durationMs;
}

export async function toolsFromTrace(file: string): Promise<Tools> {
  const tools: Tools = Object.create(null);
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.kind === 'tool') recordTool(tools, event.name, event.durationMs, event.result);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally { lines.close(); }
  return tools;
}

export function summarizeTools(attempts: { tools?: Tools }[]) {
  const tools: Record<string, ToolUsage & { usedAttempts: number }> = Object.create(null);
  for (const attempt of attempts) for (const [name, usage] of Object.entries(attempt.tools ?? {})) {
    const entry = Object.hasOwn(tools, name) ? tools[name]! : (tools[name] = { calls: 0, errors: 0, durationMs: 0, usedAttempts: 0 });
    entry.calls += usage.calls; entry.errors += usage.errors; entry.durationMs += usage.durationMs;
    entry.usedAttempts += Number(usage.calls > 0);
  }
  return tools;
}
