import type { MarketFrame } from './continuous-scanner';
import * as indicators from './indicators';
import TechnicalIndicators from './technical-indicators';
import SignalClassifier from './signal-classifier';
import { SignalClassifier as LibSignalClassifier } from '../../lib/signal-classifier';
import RiskManagement from './risk-management';
import MarketRegimeDetector from './market-regime-detector';
import { getRegimeService } from '../regime-service';
import type { RegimeContext as ArmRegimeContext } from '../../arm-evaluator';
import { QualityGating } from './quality-gating';

export interface MomentumScoreIndicators {
  macdHistLast: number;
  macdHistPrev: number;
  macdMomentum: number;
  rsiLast: number;
  slope: number;
  momentum1d: number;
  momentum7d: number;
  momentum30d: number;
  volRatio: number;
  meanPrice: number;
  vwapLast: number;
  vwapGap: number;
  bbPosition: number;
  bbUpper: number;
  bbLower: number;
  trendStrength: number;
  volatility: number;
  atrPct?: number;
  compositeScore: number;
  fib?: any;
}

export interface MomentumScoreResult {
  score: number; // -1 .. +1
  signal: string; // 'Strong Buy' | 'Buy' | 'Weak Buy' | 'Neutral' | 'Weak Sell' | 'Sell' | 'Strong Sell'
  signalStrength: number; // 0-100
  confidence: number; // 0-1
  reason?: string;
  regime?: string;
  regimeConfidence?: number;
  indicators?: MomentumScoreIndicators;
  
  // === QUALITY GATING ===
  passesQualityGate?: boolean; // true if signal meets quality threshold
  qualityGateReason?: string; // Why it passed or failed
}

/**
 * MomentumScanner - Enhanced with Signal Classification & Regime Detection
 * 
 * Complete port of Python momentum scanner with:
 * - Technical indicator computation (MACD, RSI, Slope, Volume)
 * - Signal classification (Strong Buy/Sell, Buy/Sell, etc.)
 * - Market regime detection (Bull/Bear/Ranging)
 * - Risk management integration
 * - Opportunity scoring
 */
export class MomentumScanner {
  static computeScore(frames: MarketFrame[]): MomentumScoreResult {
    if (!frames || frames.length < 5) {
      return this.getDefaultScoreResult('INSUFFICIENT_DATA');
    }

    const { closes, highs, lows, volumes } = TechnicalIndicators.frameArrays(frames);
    const lastIdx = closes.length - 1;

    // === INDICATOR CALCULATION via TechnicalIndicators ===
    const { histogram } = TechnicalIndicators.macd(closes);
    const macdHistLast = Number.isNaN(histogram[lastIdx]) ? 0 : histogram[lastIdx];
    const macdHistPrev = lastIdx - 1 >= 0 && !Number.isNaN(histogram[lastIdx - 1]) ? histogram[lastIdx - 1] : 0;
    const macdMomentum = macdHistLast - macdHistPrev;

    const rsiArr = TechnicalIndicators.rsi(closes);
    const rsiLast = Number.isNaN(rsiArr[lastIdx]) ? 50 : rsiArr[lastIdx];

    const slopeVal = TechnicalIndicators.slope(closes, Math.min(10, closes.length));

    const meanPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
    const volRatio = RiskManagement.calculateVolumeRatio(volumes, 20);

    const momentum1d = closes.length >= 1 ? (closes[lastIdx] - closes[Math.max(0, lastIdx - 1)]) / closes[Math.max(0, lastIdx - 1)] : 0;
    const momentum7d = closes.length >= 7 ? (closes[lastIdx] - closes[Math.max(0, lastIdx - 7)]) / closes[Math.max(0, lastIdx - 7)] : momentum1d;
    const momentum30d = closes.length >= 30 ? (closes[lastIdx] - closes[Math.max(0, lastIdx - 30)]) / closes[Math.max(0, lastIdx - 30)] : momentum7d;

    const bbResult = TechnicalIndicators.bollingerBands(closes, 20, 2);
    const bbUpper = bbResult?.upper?.[lastIdx] ?? meanPrice * 1.02;
    const bbLower = bbResult?.lower?.[lastIdx] ?? meanPrice * 0.98;
    const bbPosition = RiskManagement.calculateBBPosition(closes[lastIdx], bbUpper, bbLower);

    const vwapArr = TechnicalIndicators.vwap(closes, volumes, 20);
    const vwapLast = Number.isNaN(vwapArr[lastIdx]) ? meanPrice : vwapArr[lastIdx];
    const vwapGap = (closes[lastIdx] - vwapLast) / vwapLast;

    const fib = TechnicalIndicators.fibLevels(highs, lows, closes, Math.min(55, closes.length));

    const regimeResult = MarketRegimeDetector.detectRegime(closes, highs, lows, volumes);

    // Signal classification (sync) — allow external regime availability in future
    const signalResult = SignalClassifier.classifyMomentumSignal(
      momentum1d,
      momentum7d,
      rsiLast,
      macdHistLast,
      {
        momentumShort: 0.01,
        rsiMin: 50,
        rsiMax: 70,
        macdMin: 0
      },
      { ichimokuBullish: true }
    );

    const stateResult = SignalClassifier.classifyState(
      momentum1d,
      momentum7d,
      momentum30d,
      rsiLast,
      macdHistLast,
      bbPosition,
      volRatio
    );

    const signalStrength = SignalClassifier.calculateSignalStrength(
      momentum1d,
      momentum7d,
      rsiLast,
      macdHistLast,
      volRatio
    );

    const confidence = SignalClassifier.calculateConfidenceScore(
      momentum1d,
      momentum7d,
      rsiLast,
      macdHistLast,
      regimeResult.trendStrength,
      volRatio
    );

    const compositeScore = SignalClassifier.calculateCompositeScore(
      momentum1d,
      momentum7d,
      rsiLast,
      macdHistLast,
      regimeResult.trendStrength,
      volRatio,
      true,
      0
    );

    const score = (compositeScore / 100 - 0.5) * 2;

    const reasonParts: string[] = [];
    reasonParts.push(`signal:${signalResult.signal}`);
    reasonParts.push(`regime:${regimeResult.regime}`);
    reasonParts.push(`state:${stateResult.state}`);
    reasonParts.push(`macd:${macdHistLast.toFixed(6)}`);
    reasonParts.push(`rsi:${rsiLast.toFixed(1)}`);
    reasonParts.push(`volRatio:${volRatio.toFixed(2)}`);

    const gateResult = QualityGating.passesQualityGate(confidence, signalStrength, (frames[0] as any)?.symbol || 'DEFAULT');

    // Normalize regime volatility to numeric for indicators
    const volNumeric = (() => {
      const v: any = regimeResult.volatility;
      if (typeof v === 'number') return v;
      if (v === 'extreme') return 4;
      if (v === 'high') return 3;
      if (v === 'medium') return 2;
      if (v === 'low') return 1;
      return 0;
    })();

    return {
      score,
      signal: signalResult.signal,
      signalStrength: Math.round(signalStrength),
      confidence,
      reason: reasonParts.join(' | '),
      regime: regimeResult.regime,
      regimeConfidence: regimeResult.confidence / 100,
      passesQualityGate: gateResult.passesGate,
      qualityGateReason: gateResult.rejectionReason || gateResult.reason,
      indicators: {
        macdHistLast,
        macdHistPrev,
        macdMomentum,
        rsiLast,
        slope: slopeVal,
        momentum1d: Math.round(momentum1d * 10000) / 100,
        momentum7d: Math.round(momentum7d * 10000) / 100,
        momentum30d: Math.round(momentum30d * 10000) / 100,
        volRatio: Math.round(volRatio * 100) / 100,
        meanPrice,
        vwapLast,
        vwapGap: Math.round(vwapGap * 10000) / 100,
        bbPosition: Math.round(bbPosition * 100) / 100,
        bbUpper,
        bbLower,
        trendStrength: regimeResult.trendStrength,
        volatility: volNumeric,
        atrPct: regimeResult.atrPct,
        compositeScore,
        fib: {
          direction: fib?.direction || 'bull',
          retracements: (fib?.retracements?.length ?? 0) > 0 ? fib!.retracements![Math.floor(fib!.retracements!.length / 2)].price : meanPrice,
          extensions: (fib?.extensions?.length ?? 0) > 0 ? fib!.extensions![0].price : meanPrice * 1.618
        }
      } as MomentumScoreIndicators
    };
  }

  static getDefaultScoreResult(reason = 'INSUFFICIENT_DATA'): MomentumScoreResult {
    return {
      score: 0,
      signal: 'Neutral',
      signalStrength: 0,
      confidence: 0,
      reason,
      indicators: {} as any
    } as unknown as MomentumScoreResult;
  }

  /**
   * Async variant that may consult an external RegimeService for enriched regime context.
   */
  static async computeScoreAsync(frames: MarketFrame[], symbol?: string): Promise<MomentumScoreResult> {
    if (!frames || frames.length < 5) return this.getDefaultScoreResult('INSUFFICIENT_DATA');
    // Try to fetch regime context (best-effort)
    try {
      const regimeSvc = getRegimeService();
      if (regimeSvc && typeof regimeSvc.computeRegime === 'function') {
        const tfMinutes = 60; // default; callers can extend to pass timeframe
        const svcCtx = await regimeSvc.computeRegime(symbol || (frames[0] as any)?.symbol || 'UNKNOWN', tfMinutes as any);
        if (svcCtx) {
          // currently we do not deeply merge svcCtx into SignalClassifier calls, but availability is useful
        }
      }
    } catch (e) {
      // non-fatal
    }
    // Fall back to sync computeScore for core logic
    return this.computeScore(frames);
  }

  /**
   * Calculate opportunity score for entry optimization
   * Identifies best entry points, not just momentum
   */
  static calculateOpportunity(frames: MarketFrame[]): number {
    if (!frames || frames.length < 20) return 0;

    const closes = frames.map(f => f.price.close);
    const highs = frames.map(f => f.price.high);
    const lows = frames.map(f => f.price.low);
    const volumes = frames.map(f => f.volume ?? 0);
    const lastIdx = closes.length - 1;

    // Calculate metrics
    const rsiArr = indicators.rsi(closes);
    const rsi = rsiArr[lastIdx];

    const { histogram } = indicators.macd(closes);
    const macd = histogram[lastIdx];

    const momentum1d = (closes[lastIdx] - closes[lastIdx - 1]) / closes[lastIdx - 1];
    const momentum7d = (closes[lastIdx] - closes[Math.max(0, lastIdx - 7)]) / closes[Math.max(0, lastIdx - 7)];

    const trendScore = RiskManagement.calculateTrendScore(closes);
    const volRatio = RiskManagement.calculateVolumeRatio(volumes, 20);

    const bbUpper = closes[lastIdx] * 1.02;
    const bbLower = closes[lastIdx] * 0.98;
    const bbPos = RiskManagement.calculateBBPosition(closes[lastIdx], bbUpper, bbLower);

    return SignalClassifier.calculateOpportunityScore(
      momentum1d,
      momentum7d,
      rsi,
      macd,
      bbPos,
      trendScore,
      volRatio,
      null,
      false
    );
  }

  /**
   * Calculate risk-adjusted entry and exit levels
   */
  static calculateRiskLevels(frames: MarketFrame[], signal: string): any {
    if (!frames || frames.length < 14) return null;

    const closes = frames.map(f => f.price.close);
    const highs = frames.map(f => f.price.high);
    const lows = frames.map(f => f.price.low);
    const currentPrice = closes[closes.length - 1];

    return RiskManagement.calculateStopLossTakeProfit(
      currentPrice,
      { high: highs, low: lows, close: closes },
      signal
    );
  }

  /**
   * SCANNER SOURCE IMPLEMENTATION - Real multi-pattern detection for consensus engine
   * 
   * Detects multiple trading patterns from live market data frames.
   * This is the LIVE SCANNER SOURCE that feeds into the 3-source consensus engine.
   * 
   * Returns multi-pattern classification with confidence scores.
   */
  static classifyPatterns(frames: MarketFrame[]) {
    if (!frames || frames.length < 14) {
      return {
        patterns: [],
        primaryPattern: null,
        overallConfidence: 0,
        overallStrength: 0,
        reasoning: [],
        patternDetails: []
      };
    }

    const closes = frames.map(f => f.price.close);
    const highs = frames.map(f => f.price.high);
    const lows = frames.map(f => f.price.low);
    const volumes = frames.map(f => f.volume ?? 0);
    const lastIdx = closes.length - 1;
    const currentPrice = closes[lastIdx];
    const prevPrice = closes[Math.max(0, lastIdx - 1)];

    // === Calculate all technical indicators ===
    const rsiArr = indicators.rsi(closes);
    const rsiLast = Number.isNaN(rsiArr[lastIdx]) ? 50 : rsiArr[lastIdx];
    
    const { histogram: macdHist } = indicators.macd(closes);
    const macdHistLast = Number.isNaN(macdHist[lastIdx]) ? 0 : macdHist[lastIdx];
    
    const emaArr20 = indicators.ema(closes, 20);
    const ema20 = emaArr20[lastIdx] ?? currentPrice;
    
    const emaArr50 = indicators.ema(closes, 50);
    const ema50 = emaArr50[lastIdx] ?? currentPrice;
    
    const meanPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
    const bbResult2 = indicators.bollingerBands(closes, 20, 2);
    const bbUpper = bbResult2?.upper?.[lastIdx] ?? meanPrice * 1.02;
    const bbLower = bbResult2?.lower?.[lastIdx] ?? meanPrice * 0.98;
    
    const volRatio = RiskManagement.calculateVolumeRatio(volumes, 20);
    const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length || 1);

    // === Support/Resistance Levels ===
    let support = Math.min(...lows.slice(-20));
    let resistance = Math.max(...highs.slice(-20));

    // === Build indicator package for classifier ===
    const indicatorPackage = {
      price: currentPrice,
      prevPrice: prevPrice,
      rsi: rsiLast,
      macd: { histogram: macdHistLast },
      ema20: ema20,
      ema50: ema50,
      bollingerBands: { upper: bbUpper, middle: meanPrice, lower: bbLower },
      support: support,
      resistance: resistance,
      volume: volumes[lastIdx],
      prevVolume: volumes[Math.max(0, lastIdx - 1)],
      divergence: false // TODO: Implement divergence detection
    };

    // === Call full multi-pattern classifier ===
    const classifier = new LibSignalClassifier();
    const classificationResult = classifier.classifySignal(indicatorPackage);

    // === Add pattern-specific metadata ===
    const enrichedPatterns = classificationResult.patterns.map(p => ({
      ...p,
      // Can add historical accuracy adjustments here later
      levels: this.getPatternLevels(p.pattern, support, resistance, currentPrice)
    }));

    // === QUALITY GATING for patterns ===
    const patternGateResult = QualityGating.passesPatternQualityGate(
      classificationResult.overallConfidence,
      classificationResult.overallStrength,
      classificationResult.patterns.length,
      (frames[0] as any)?.symbol || 'DEFAULT'
    );

    return {
      patterns: classificationResult.classifications,
      primaryPattern: classificationResult.primaryPattern,
      overallConfidence: classificationResult.overallConfidence,
      overallStrength: classificationResult.overallStrength,
      reasoning: classificationResult.reasoning,
      patternDetails: enrichedPatterns,
      passesQualityGate: patternGateResult.passesGate,
      qualityGateReason: patternGateResult.rejectionReason || patternGateResult.reason,
      // Additional context for consensus
      sourceContext: {
        technicalScore: Math.round(classificationResult.overallStrength),
        confidenceScore: classificationResult.overallConfidence,
        patternCount: classificationResult.patterns.length,
        volumeRatio: volRatio,
        regime: 'LIVE' // Will be enriched with actual regime from RegimeService
      }
    };
  }

  /**
   * Extract key support/resistance levels for a pattern
   */
  private static getPatternLevels(pattern: string, support: number, resistance: number, price: number): Array<{name: string; value: number}> {
    const levels: Array<{name: string; value: number}> = [];
    
    switch (pattern) {
      case 'BREAKOUT':
        levels.push({ name: 'breakoutLevel', value: resistance });
        break;
      case 'SUPPORT_BOUNCE':
        levels.push({ name: 'supportLevel', value: support });
        break;
      case 'RESISTANCE_BREAK':
        levels.push({ name: 'resistanceLevel', value: resistance });
        break;
      case 'CONSOLIDATION_BREAK':
        levels.push({ name: 'consolidationHigh', value: resistance });
        levels.push({ name: 'consolidationLow', value: support });
        break;
      default:
        levels.push({ name: 'price', value: price });
    }
    
    return levels;
  }
}

export default MomentumScanner;
