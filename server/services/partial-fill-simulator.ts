import { randomInt } from 'crypto';

export type PartialFillOptions = {
  typicalDepth?: number; // typical available quantity at NBBO
  aggressiveness?: number; // 0..1, higher => more likely full fills
};

export class PartialFillSimulator {
  private opts: PartialFillOptions;

  constructor(opts?: PartialFillOptions) {
    this.opts = {
      typicalDepth: 1000,
      aggressiveness: 0.6,
      ...opts
    };
  }

  // Simulate a single order fill event. Returns filled amount (<= requested)
  simulateFill(requestAmount: number): number {
    const depth = this.opts.typicalDepth || 1;
    const aggr = Math.max(0, Math.min(1, this.opts.aggressiveness || 0.5));

    // If order is small relative to depth, high chance to fill fully
    const ratio = requestAmount / Math.max(1, depth);
    const baseProbFull = aggr * (1 - Math.min(1, ratio));

    const rnd = Math.random();
    if (rnd < baseProbFull) return requestAmount; // full fill

    // Partial fill: sample a fraction based on depth and randomness
    const minFill = Math.max(1, Math.floor(requestAmount * 0.05));
    const maxFill = Math.min(requestAmount, Math.floor(depth));
    if (maxFill <= minFill) return Math.min(requestAmount, maxFill);

    // draw a fill amount biased towards smaller fills for larger orders
    const bias = Math.pow(1 - Math.random(), 1 + ratio);
    const fill = Math.floor(minFill + bias * (maxFill - minFill));
    return Math.max(0, Math.min(requestAmount, fill));
  }

  // Simulate progressive fill events until order fully filled or timed out.
  simulateProgressiveFills(requestAmount: number, maxEvents = 5): number[] {
    const fills: number[] = [];
    let remaining = requestAmount;
    for (let i = 0; i < maxEvents && remaining > 0; i++) {
      const f = this.simulateFill(Math.ceil(remaining));
      if (f <= 0) break;
      fills.push(f);
      remaining = Math.max(0, remaining - f);
      // reduce aggressiveness slightly after each partial
      this.opts.aggressiveness = Math.max(0, (this.opts.aggressiveness || 0.5) - 0.05);
    }
    return fills;
  }
}

export default PartialFillSimulator;
