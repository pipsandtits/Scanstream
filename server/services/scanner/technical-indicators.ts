import * as indicators from './indicators';
import { vwap, volumeProfile, fibLevels } from './indicators';
import type { MarketFrame } from './continuous-scanner';

export default class TechnicalIndicators {
  static macd(closes: number[]) {
    return indicators.macd(closes);
  }

  static rsi(closes: number[]) {
    return indicators.rsi(closes);
  }

  static ema(values: number[], period: number) {
    return indicators.ema(values, period);
  }

  static bollingerBands(values: number[], period = 20, std = 2) {
    return indicators.bollingerBands(values, period, std);
  }

  static slope(values: number[], period: number) {
    return indicators.slope(values, period);
  }

  static vwap(closes: number[], volumes: number[], window = 20) {
    return vwap(closes, volumes, window);
  }

  static fibLevels(highs: number[], lows: number[], closes: number[], lookback = 55) {
    return fibLevels(highs, lows, closes, lookback);
  }

  // Convenience: extract arrays from frames
  static frameArrays(frames: MarketFrame[]) {
    const closes = frames.map(f => f.price.close);
    const highs = frames.map(f => f.price.high);
    const lows = frames.map(f => f.price.low);
    const volumes = frames.map(f => f.volume ?? 0);
    return { closes, highs, lows, volumes };
  }
}
