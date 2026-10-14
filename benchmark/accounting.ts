export interface Usage { inputTokens: number | null; outputTokens: number | null; costUSD: number | null; costSource?: 'reported' | 'estimated' }
export class Ledger {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  knownCostUSD = 0;
  missingCostCalls = 0;
  missingTokenCalls = 0;
  estimatedCostCalls = 0;
  add(usage?: Usage) {
    this.calls++;
    if (usage?.costSource === 'estimated') this.estimatedCostCalls++;
    this.inputTokens += usage?.inputTokens ?? 0;
    this.outputTokens += usage?.outputTokens ?? 0;
    this.knownCostUSD += usage?.costUSD ?? 0;
    if (usage?.costUSD == null) this.missingCostCalls++;
    if (usage?.inputTokens == null || usage.outputTokens == null) this.missingTokenCalls++;
  }
  snapshot() {
    return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      knownCostUSD: this.knownCostUSD, costUSD: this.missingCostCalls ? null : this.knownCostUSD,
      missingCostCalls: this.missingCostCalls, missingTokenCalls: this.missingTokenCalls, estimatedCostCalls: this.estimatedCostCalls };
  }
}
export type Accounting = ReturnType<Ledger['snapshot']>;
export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function pricedUsage(input: unknown, output: unknown, cost: unknown, pricing?: { inputUSDPerMillion: number; outputUSDPerMillion: number }): Usage {
  const inputTokens = finite(input), outputTokens = finite(output), reported = finite(cost);
  if (reported !== null) return { inputTokens, outputTokens, costUSD: reported, costSource: 'reported' };
  if (pricing && inputTokens !== null && outputTokens !== null) return { inputTokens, outputTokens,
    costUSD: (inputTokens * pricing.inputUSDPerMillion + outputTokens * pricing.outputUSDPerMillion) / 1e6, costSource: 'estimated' };
  return { inputTokens, outputTokens, costUSD: null };
}
