export type SlippageConfig = {
  mode?: 'percentage' | 'volume' | 'orderbook';
  percent?: number; // e.g. 0.2 means 0.2%
  volumeWindow?: number; // typical depth window for volume-based
  orderBookDepthMultiplier?: number; // multiplier when simulating from orderbook
};

export class SlippageModel {
  private cfg: SlippageConfig;

  constructor(cfg?: SlippageConfig) {
    this.cfg = {
      mode: 'percentage',
      percent: 0.2,
      volumeWindow: 1000,
      orderBookDepthMultiplier: 1.0,
      ...cfg
    };
  }

  // Estimate slippage as a percentage (positive = worse price)
  estimateSlippagePct(price: number, amount: number, liquidityVolume?: number): number {
    const mode = this.cfg.mode;
    if (mode === 'percentage') {
      return (this.cfg.percent || 0) / 100.0; // convert pct to fraction
    }

    if (mode === 'volume') {
      const window = this.cfg.volumeWindow || 1;
      const depth = liquidityVolume && liquidityVolume > 0 ? liquidityVolume : window;
      // larger orders relative to depth => more slippage
      const ratio = amount / Math.max(1, depth);
      // simple non-linear mapping
      return Math.min(1, Math.pow(ratio, 0.8) * ((this.cfg.percent || 0) / 100));
    }

    // orderbook simulation - assume orderBookDepthMultiplier scales slippage
    if (mode === 'orderbook') {
      const mult = this.cfg.orderBookDepthMultiplier || 1.0;
      // fallback to simple percent scaled by multiplier
      return (this.cfg.percent || 0) / 100.0 * mult;
    }

    return 0;
  }

  // Apply slippage to a price: returns adjustedPrice (worse for taker)
  applySlippage(price: number, amount: number, liquidityVolume?: number, side: 'buy' | 'sell' = 'buy'): number {
    const pct = this.estimateSlippagePct(price, amount, liquidityVolume);
    // buy: price increases, sell: price decreases
    const direction = side === 'buy' ? 1 : -1;
    return price * (1 + direction * pct);
  }
}

export default SlippageModel;
