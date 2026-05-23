/**
 * Adaptive Regime Matcher (ARM) - Evaluates momentum signals based on market regime
 * Integrates with SignalClassifier to provide regime-aware signal classification
 */

import { SignalStrengthLabel, RegimeState, AdditionalIndicators } from './signal-classifier';

export enum RegimeBias {
  BULLISH = 'BULLISH',
  BEARISH = 'BEARISH',
  NEUTRAL = 'NEUTRAL'
}

/**
 * Simple regime persistence helper (hysteresis): only confirm a new regime after N confirmations
 */
export class RegimePersistence {
  private candidate: string | null = null;
  private count = 0;
  constructor(private readonly requiredConfirmations = 3, private readonly minConfidence = 0.6) {}

  propose(regime: string, confidence = 0.0): string | null {
    if (confidence < this.minConfidence) {
      // lower confidence resets transient candidate
      this.candidate = null;
      this.count = 0;
      return null;
    }
    if (this.candidate === regime) {
      this.count += 1;
    } else {
      this.candidate = regime;
      this.count = 1;
    }
    if (this.count >= this.requiredConfirmations) {
      const confirmed = this.candidate as string;
      this.candidate = null;
      this.count = 0;
      return confirmed;
    }
    return null;
  }
}

export enum RegimePhase {
  EARLY = 'EARLY',
  STRONG = 'STRONG',
  PARABOLIC = 'PARABOLIC',
  CAPITULATION = 'CAPITULATION',
  UNKNOWN = 'UNKNOWN'
}

export function deriveRegimeBiasPhase(regime: string | RegimeState | undefined): { bias: RegimeBias; phase: RegimePhase } {
  if (!regime || typeof regime !== 'string') return { bias: RegimeBias.NEUTRAL, phase: RegimePhase.UNKNOWN };
  const r = regime.toUpperCase();
  const bias = r.includes('BULL') ? RegimeBias.BULLISH : r.includes('BEAR') ? RegimeBias.BEARISH : RegimeBias.NEUTRAL;
  let phase = RegimePhase.UNKNOWN;
  if (r.includes('EARLY')) phase = RegimePhase.EARLY;
  else if (r.includes('STRONG')) phase = RegimePhase.STRONG;
  else if (r.includes('PARABOLIC')) phase = RegimePhase.PARABOLIC;
  else if (r.includes('CAPITULATION')) phase = RegimePhase.CAPITULATION;
  return { bias, phase };
}

export interface RegimeContext {
  regime: RegimeState;
  bias?: RegimeBias;
  phase?: RegimePhase;
  volatility: number;
  // trendStrength can be either a number (legacy) or an object with direction
  trendStrength: number | { strength: number; direction: 1 | -1 };
  regimeConfidence: number;
}

export interface ARMConfig {
  enableAdaptiveThresholds: boolean;
  regimeWeighting: Record<string, number>;
  volatilityAdjustment: number;
  trendInfluence: number;
}

export interface MomentumSignalContext {
  momentumShort: number;
  momentumLong: number;
  rsi: number;
  macd: number;
  regimeContext: RegimeContext;
  additionalIndicators: AdditionalIndicators;
}

/**
 * ARM Evaluator - Regime-aware momentum signal evaluation
 */
export class ARMEvaluator {
  private static readonly DEFAULT_CONFIG: ARMConfig = {
    enableAdaptiveThresholds: true,
    regimeWeighting: {
      'BULL_EARLY': 1.1,
      'BULL_STRONG': 1.3,
      'BULL_PARABOLIC': 1.2,
      'BEAR_EARLY': 0.9,
      'BEAR_STRONG': 0.7,
      'BEAR_CAPITULATION': 0.8,
      'NEUTRAL_ACCUM': 1.0,
      'NEUTRAL_DIST': 1.0,
      'NEUTRAL': 1.0,
    },
    volatilityAdjustment: 0.5,
    trendInfluence: 0.3,
  };

  /**
   * Evaluates momentum signal considering regime context
   */
  static evaluateMomentumWithRegime(
    context: MomentumSignalContext,
    baseSignal: SignalStrengthLabel,
    config: ARMConfig = ARMEvaluator.DEFAULT_CONFIG,
  ): SignalStrengthLabel {
    if (!config.enableAdaptiveThresholds) {
      return baseSignal;
    }
    const regimeWeight = config.regimeWeighting[context.regimeContext.regime] ?? 1.0;

    // Volatility: prefer ATR ratio when available in additionalIndicators
    let volatilityRatio = 1.0;
    try {
      const add = context.additionalIndicators || {} as AdditionalIndicators;
      // expect add.atrSeries?: number[] where last is current ATR, fallback if not provided
      if (Array.isArray((add as any).atrSeries) && (add as any).atrSeries.length > 0) {
        const atrSeries = (add as any).atrSeries as number[];
        const lastAtr = atrSeries[atrSeries.length - 1] ?? 0.0;
        const smaLen = Math.min(100, atrSeries.length);
        const smaAtr = atrSeries.slice(Math.max(0, atrSeries.length - smaLen)).reduce((a, b) => a + b, 0) / smaLen || 1e-6;
        volatilityRatio = lastAtr / smaAtr;
      } else if ((context.regimeContext && typeof context.regimeContext.volatility === 'number')) {
        volatilityRatio = 1.0 + (context.regimeContext.volatility - 0.5) * config.volatilityAdjustment;
      }
    } catch (e) {
      volatilityRatio = 1.0;
    }

    // Trend: support directional strength
    const trendVal = context.regimeContext.trendStrength;
    const trendStrengthVal = typeof trendVal === 'number' ? trendVal : (trendVal?.strength ?? 0);
    const trendDir = typeof trendVal === 'number' ? (trendVal >= 0 ? 1 : -1) : (trendVal?.direction ?? 1);
    const trendFactor = 1.0 + (trendStrengthVal * config.trendInfluence * (trendDir || 1));

    const combinedWeight = regimeWeight * volatilityRatio * trendFactor;

    return ARMEvaluator.adjustSignalByWeight(baseSignal, combinedWeight, context.regimeContext);
  }

  /**
   * Adjusts signal strength based on combined regime/volatility/trend weight
   */
  private static adjustSignalByWeight(
    signal: SignalStrengthLabel,
    weight: number,
    regimeContext: RegimeContext,
  ): SignalStrengthLabel {
    const signalStrengths: SignalStrengthLabel[] = [
      'Strong Sell',
      'Sell',
      'Weak Sell',
      'Neutral',
      'Weak Buy',
      'Buy',
      'Strong Buy',
    ];

    const currentIndex = signalStrengths.indexOf(signal);
    if (currentIndex === -1) return signal;

    const { bias } = deriveRegimeBiasPhase(regimeContext.regime as any);

    // Continuous scaling of adjustment magnitude
    const rawAdjustmentMagnitude = Math.min(2, Math.round(Math.abs(weight - 1) * 4));
    const sign = Math.sign(weight - 1);

    let newIndex = currentIndex;

    if (bias === RegimeBias.BULLISH) {
      if (currentIndex > 3) {
        // Pro-bull signal -> amplify toward stronger buy
        newIndex = currentIndex + (sign > 0 ? rawAdjustmentMagnitude : -rawAdjustmentMagnitude);
      } else if (currentIndex < 3) {
        // Counter-trend sell signals -> dampen toward neutral
        const damp = Math.max(0, Math.round(rawAdjustmentMagnitude * 0.75));
        newIndex = currentIndex + damp; // move up toward neutral/buy
      }
    } else if (bias === RegimeBias.BEARISH) {
      if (currentIndex < 3) {
        // Pro-bear signal -> amplify toward stronger sell
        newIndex = currentIndex - (sign > 0 ? rawAdjustmentMagnitude : -rawAdjustmentMagnitude);
      } else if (currentIndex > 3) {
        // Counter-trend buy signals -> dampen toward neutral
        const damp = Math.max(0, Math.round(rawAdjustmentMagnitude * 0.75));
        newIndex = currentIndex - damp; // move down toward neutral/sell
      }
    } else {
      // Neutral regime: small moderation toward weight direction
      newIndex = currentIndex + Math.round((weight - 1) * 2);
    }

    // Clamp index
    newIndex = Math.max(0, Math.min(signalStrengths.length - 1, newIndex));
    return signalStrengths[newIndex];
  }

  /**
   * Calculates regime confidence based on momentum consistency
   */
  static calculateRegimeConfidence(
    momentumShort: number,
    momentumLong: number,
    rsi: number,
  ): number {
    // High confidence when short-term momentum aligns with long-term
    const alignmentScore = Math.abs(Math.sign(momentumShort) - Math.sign(momentumLong)) === 0 ? 1.0 : 0.5;
    
    // RSI extremes indicate strong conviction
    const rsiScore = (Math.abs(rsi - 50) / 50) * 0.5 + 0.5;
    
    return Math.min(1.0, (alignmentScore + rsiScore) / 2.0);
  }

  /**
   * Evaluates trend strength and direction
   */
  static evaluateTrendStrength(
    momentumLong: number,
    macd: number,
    rsi: number,
  ): { strength: number; direction: 1 | -1 } {
    // Preserve sign of momentum for direction
    const normMomentum = Math.tanh(momentumLong);
    const momDir = normMomentum >= 0 ? 1 : -1;
    const momStrength = Math.min(1, Math.abs(normMomentum));

    // MACD alignment: sign(macd) supports momentum direction
    const macdSign = Math.sign(macd) || 1;
    const macdStrength = Math.min(1, Math.tanh(Math.abs(macd) * 0.1));

    // RSI distance from neutral as contributor
    const rsiStrength = Math.min(1, Math.abs(rsi - 50) / 50);

    const strength = (momStrength * 0.5) + (macdStrength * 0.3) + (rsiStrength * 0.2);
    const direction = momDir * (macdSign >= 0 ? 1 : -1) as 1 | -1;
    return { strength: Number(strength.toFixed(3)), direction };
  }

  /**
   * Evaluates volatility environment
   */
  static evaluateVolatility(
    momentumShort: number,
    rsi: number,
    additionalIndicators: AdditionalIndicators,
  ): number {
    // Prefer ATR ratio when series available (atrSeries expected as number[])
    try {
      if (Array.isArray((additionalIndicators as any).atrSeries) && (additionalIndicators as any).atrSeries.length > 0) {
        const atrSeries = (additionalIndicators as any).atrSeries as number[];
        const lastAtr = atrSeries[atrSeries.length - 1] ?? 0.0;
        const smaLen = Math.min(100, atrSeries.length);
        const smaAtr = atrSeries.slice(Math.max(0, atrSeries.length - smaLen)).reduce((a, b) => a + b, 0) / smaLen || 1e-6;
        const volRatio = lastAtr / smaAtr;
        // normalize: 1 => normal, >1 high, <1 compressed. Map to 0-1 with 1 => 0.5 baseline
        const volScore = Math.tanh((volRatio - 1) * 0.8) * 0.5 + 0.5;
        return Number(Math.max(0, Math.min(1, volScore)).toFixed(3));
      }
    } catch (e) {
      // fallthrough to fallback model
    }

    // Fallback: normalized momentum-based and RSI
    const momVol = Math.min(1.0, Math.abs(momentumShort) / 0.1);
    const rsiVol = (Math.abs(rsi - 50) / 50) * 0.5;
    let additionalVol = 0;
    if (typeof (additionalIndicators as any).atr === 'number') {
      additionalVol = Math.min(1.0, ((additionalIndicators as any).atr as number) / 0.05);
    }
    return Number(((momVol + rsiVol + additionalVol) / 3.0).toFixed(3));
  }
}
