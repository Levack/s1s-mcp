import { readFile, writeFile } from 'node:fs/promises';

interface Receipt { label: string; reservedUSD: number; costUSD: number | null; error?: string; failureStatus?: number; coveredRejection?: boolean }
interface State { limitUSD: number; receipts: Receipt[] }

/** Shared across all experiment stages. Unknown billing stops subsequent calls. */
export class ExperimentBudget {
  private state: State;
  private writing = Promise.resolve();
  private halted = false;
  private constructor(private file: string, state: State) {
    this.state = state;
    this.halted = state.receipts.some(r => r.costUSD === null && !r.coveredRejection);
  }
  static async open(file: string, limitUSD = 4) {
    let state: State = { limitUSD, receipts: [] };
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (state.limitUSD !== limitUSD) throw new Error('Budget limit changed');
    return new ExperimentBudget(file, state);
  }
  get spentUSD() { return this.state.receipts.reduce((sum, r) => sum + (r.costUSD ?? r.reservedUSD), 0); }
  get stopped() { return this.halted || this.spentUSD >= this.state.limitUSD; }
  /** Explicitly retain the full allowance for a rejected request with unknown billing. */
  async coverRejectedRequest(label: string) {
    const receipt = this.state.receipts.findLast(r => r.label === label && r.costUSD === null && !r.coveredRejection);
    const knownValidation = receipt?.error?.includes('max_tokens_exceeded')
      || (receipt?.error?.includes('invalid_union') && receipt.error.includes('criteria') && receipt.error.includes('received null'));
    if (!receipt || receipt.failureStatus !== 400 || !knownValidation) {
      throw new Error('Only a recorded token-limit or null-criteria rejection can be covered');
    }
    receipt.coveredRejection = true;
    this.halted = this.state.receipts.some(r => (r.costUSD === null && !r.coveredRejection) || (r.costUSD !== null && r.costUSD > r.reservedUSD));
    await this.save();
  }
  async call<T>(label: string, reserveUSD: number, run: () => Promise<T>, cost: (value: T) => unknown): Promise<T> {
    if (!Number.isFinite(reserveUSD) || reserveUSD <= 0) throw new Error('Invalid request reservation');
    if (this.stopped || this.spentUSD + reserveUSD > this.state.limitUSD) throw new Error('Experiment budget stopped');
    // Persist in-flight liabilities before sending requests, including interrupted runs.
    const receipt: Receipt = { label, reservedUSD: reserveUSD, costUSD: null };
    this.state.receipts.push(receipt);
    await this.save();
    try {
      const value = await run();
      const reported = cost(value);
      if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
        this.halted = true;
        receipt.error = 'Missing provider-reported cost; no further paid calls';
      } else {
        receipt.costUSD = reported;
        if (reported > reserveUSD) { this.halted = true; receipt.error = 'Request exceeded conservative reservation'; }
      }
      return value;
    } catch (error) {
      this.halted = true;
      receipt.error = error instanceof Error ? error.message : 'Request failed';
      receipt.failureStatus = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
      throw error;
    } finally { await this.save(); }
  }
  private save() {
    this.writing = this.writing.then(() => writeFile(this.file, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 }));
    return this.writing;
  }
}
