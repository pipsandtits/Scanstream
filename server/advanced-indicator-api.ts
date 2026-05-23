import type { Express, Request, Response } from "express";
import { z } from 'zod';

type DetectorRaw = boolean | null | undefined | {
  detected?: boolean;
  strength?: number;
  confidence?: number;
  [key: string]: any;
};

type DetectorNormalized = {
  detected: boolean;
  strength: number;
  confidence: number;
  raw: any;
};

type TechnicalIndicatorsType = {
  detectEMACrossover?: (prices: number[]) => Promise<DetectorRaw> | DetectorRaw;
  detectRSIDivergence?: (prices: number[]) => Promise<DetectorRaw> | DetectorRaw;
  detectMACDBullishCross?: (prices: number[]) => Promise<DetectorRaw> | DetectorRaw;
  detectTrendReversal?: (prices: number[]) => Promise<DetectorRaw> | DetectorRaw;
  detectVolumeAcceleration?: (volumes: number[]) => Promise<DetectorRaw> | DetectorRaw;
  overlayHigherTimeframeTrend?: (lowerFrames: any[], higherFrames: any[], higherTimeframe?: string) => any;
  adjustThresholds?: (base: number, sentiment: number, volatility: number) => any;
  adjustThresholdsRegime?: (base: number, sentiment: number, volatility: number) => any;
};

function normalizeDetectorResult(raw: DetectorRaw): DetectorNormalized {
  // If detector already returns an object with detailed scores, use it.
  if (raw && typeof raw === 'object' && ('detected' in raw || 'strength' in raw || 'confidence' in raw)) {
    const r: any = raw;
    return {
      detected: Boolean(r.detected ?? r.detect ?? true),
      strength: typeof r.strength === 'number' ? r.strength : (r.detected ? 1 : 0),
      confidence: typeof r.confidence === 'number' ? r.confidence : (r.detected ? 0.75 : 0.35),
      raw: r
    };
  }
  const detected = Boolean(raw);
  return { detected, strength: detected ? 1 : 0, confidence: detected ? 0.75 : 0.35, raw };
}

export function registerAdvancedIndicatorApi(app: Express) {
  // Advanced Indicator/Pattern Detection API
  console.log('Registering POST /api/indicators/detect-pattern');
  const detectSchema = z.object({ prices: z.array(z.number()).min(10), volumes: z.array(z.number()).optional(), meta: z.record(z.string(), z.any()).optional() });

  app.post("/api/indicators/detect-pattern", async (req: Request, res: Response) => {
    const parsed = detectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { prices, volumes } = parsed.data;
    try {
      const { TechnicalIndicators } = await import('./trading-engine') as { TechnicalIndicators?: TechnicalIndicatorsType };
      const TI = (TechnicalIndicators ?? {}) as TechnicalIndicatorsType;

      const detectorsFns: Array<() => Promise<{ name: string; out: any }>> = [
        async () => ({ name: 'emaCrossover', out: TI.detectEMACrossover ? await Promise.resolve(TI.detectEMACrossover(prices)) : null }),
        async () => ({ name: 'rsiDivergence', out: TI.detectRSIDivergence ? await Promise.resolve(TI.detectRSIDivergence(prices)) : null }),
        async () => ({ name: 'macdBullishCross', out: TI.detectMACDBullishCross ? await Promise.resolve(TI.detectMACDBullishCross(prices)) : null }),
        async () => ({ name: 'trendReversal', out: TI.detectTrendReversal ? await Promise.resolve(TI.detectTrendReversal(prices)) : null }),
        async () => ({ name: 'volumeAcceleration', out: (volumes && TI.detectVolumeAcceleration) ? await Promise.resolve(TI.detectVolumeAcceleration(volumes)) : null }),
      ];

      const rawResults = await Promise.all(detectorsFns.map(fn => fn().catch(err => ({ name: 'error', out: { error: String(err) } }))));

      const normalized: Record<string, DetectorNormalized> = {};
      for (const r of rawResults) {
        if (!r || !r.name) continue;
        normalized[r.name] = normalizeDetectorResult(r.out as DetectorRaw);
      }

      // Aggregate intelligence
      const strengths = Object.values(normalized).map((v: any) => v.strength ?? 0);
      const confidences = Object.values(normalized).map((v: any) => v.confidence ?? 0);
      const avgStrength = strengths.length ? strengths.reduce((a: number, b: number) => a + b, 0) / strengths.length : 0;
      const avgConfidence = confidences.length ? confidences.reduce((a: number, b: number) => a + b, 0) / confidences.length : 0;

      const bullishSignals = ['emaCrossover', 'macdBullishCross', 'rsiDivergence'].filter(k => normalized[k] && normalized[k].detected).length;
      const bearishSignals = 0;
      const directional_bias = bullishSignals > bearishSignals ? 'bullish' : (bearishSignals > bullishSignals ? 'bearish' : 'neutral');

      let featureVector: any = null;
      try {
        const indicatorsModule = await import('./services/scanner/indicators');
        const indicators = (indicatorsModule && (indicatorsModule.default || indicatorsModule)) as any;
        if (indicators && typeof indicators.buildFeatureVector === 'function') {
          featureVector = indicators.buildFeatureVector(prices, volumes);
        }
      } catch (e) {
        // ignore feature vector errors
      }

      const intelligence = {
        market_state: avgStrength > 0.7 ? 'trend_expansion' : 'uncertain',
        directional_bias,
        confidence: Number(avgConfidence.toFixed(2)),
        signal_quality: avgStrength > 0.6 ? 'high' : avgStrength > 0.3 ? 'medium' : 'low',
        confluence: { trend: normalized.emaCrossover?.strength ?? 0, momentum: normalized.macdBullishCross?.strength ?? 0, volume: normalized.volumeAcceleration?.strength ?? 0 },
        execution_window: avgStrength > 0.8 ? 'short_swing' : 'entry_window',
        detectors: normalized,
        features: featureVector
      };

      res.json(intelligence);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Higher Timeframe Trend Overlay API -> Context Engine
  console.log('Registering POST /api/indicators/overlay-trend');
  const overlaySchema = z.object({ lowerFrames: z.array(z.any()), higherFrames: z.array(z.any()), higherTimeframe: z.string().optional() });
  app.post("/api/indicators/overlay-trend", async (req: Request, res: Response) => {
    const parsed = overlaySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const { TechnicalIndicators } = await import('./trading-engine') as { TechnicalIndicators?: TechnicalIndicatorsType };
      const TI = (TechnicalIndicators ?? {}) as TechnicalIndicatorsType;
      const overlayed = await Promise.resolve(TI.overlayHigherTimeframeTrend ? TI.overlayHigherTimeframeTrend(parsed.data.lowerFrames, parsed.data.higherFrames, parsed.data.higherTimeframe) : null);
      const context = {
        lower_timeframe_signal: overlayed?.signal ?? 'neutral',
        higher_timeframe_bias: overlayed?.bias ?? 'neutral',
        alignment_score: overlayed?.alignment ?? 0,
        execution_permission: Boolean(overlayed?.alignment && overlayed.alignment > 0.6),
        risk_modifier: overlayed?.riskModifier ?? 1.0,
        raw: overlayed
      };
      res.json(context);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Dynamic Threshold Adjustment API -> Regime-aware thresholds
  console.log('Registering POST /api/indicators/adjust-thresholds');
  const adjustSchema = z.object({ base: z.number(), sentiment: z.number(), volatility: z.number() });
  app.post("/api/indicators/adjust-thresholds", async (req: Request, res: Response) => {
    const parsed = adjustSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const { TechnicalIndicators } = await import('./trading-engine') as { TechnicalIndicators?: TechnicalIndicatorsType };
      const TI = (TechnicalIndicators ?? {}) as TechnicalIndicatorsType;
      let adjusted;
      if (TI.adjustThresholdsRegime) {
        adjusted = await Promise.resolve(TI.adjustThresholdsRegime(parsed.data.base, parsed.data.sentiment, parsed.data.volatility));
      } else if (TI.adjustThresholds) {
        adjusted = await Promise.resolve(TI.adjustThresholds(parsed.data.base, parsed.data.sentiment, parsed.data.volatility));
      } else {
        adjusted = { error: 'no adjustThresholds implementation available' };
      }
      res.json({ adjusted });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
