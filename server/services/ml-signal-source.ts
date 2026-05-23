/**
 * ML Signal Source for Consensus Engine
 * 
 * Converts LSTM predictions into consensus-compatible signals
 * Feeds ML source into 3-source voting (Scanner + ML + RL)
 */

import { LSTMInferenceEngine, LSTMPredictionOutput, lstmInferenceEngine } from './lstm-inference-engine';
import { MLPredictions } from './ml-predictions';

export interface MLConsensusSignal {
  symbol: string;
  source: 'ml-lstm';
  timestamp: number;
  
  // Consensus fields
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0-1
  strength: number; // 0-100
  // Prediction horizon (in candles) and uncertainty bands (optional)
  predictionHorizon?: number;
  uncertaintyBands?: { lower: number; upper: number } | null;
  
  // Prediction details
  predictions: {
    lstm: LSTMPredictionOutput | null;
    classical: MLPredictions | null;
  };
  
  // Reasoning
  reasoning: string[];
  
  // Quality metadata
  dataPoints: number;
  modelsUsed: string[];
}

/**
 * ML Signal Source - Generates consensus signals from ML predictions
 */
export class MLSignalSource {
  constructor(
    private lstmEngine: LSTMInferenceEngine
  ) {}

  // lightweight usage/accuracy tracking per symbol (placeholder for future evaluation)
  private symbolStats: Map<string, { trials: number; generated: number }> = new Map();

  /**
   * Generate ML consensus signal
   */
  async generateSignal(
    symbol: string,
    classicalPredictions?: MLPredictions
  ): Promise<MLConsensusSignal | null> {
    try {
      // Generate LSTM prediction
      const lstmPrediction = await this.lstmEngine.predict({
        symbol,
        timeframe: '1h',
        lookbackCandles: 100
      });

      // If prediction missing or low-confidence, return HOLD early
      if (!lstmPrediction || (lstmPrediction.direction && lstmPrediction.direction.confidence < 0.4)) {
        console.warn(`[ML Signal Source] Low/No LSTM prediction for ${symbol}, emitting HOLD`);
        return this.createHoldSignal(symbol, lstmPrediction || null, classicalPredictions);
      }

      // Combine LSTM + classical predictions using ensemble weighting
      const signal = this.aggregateSignals(lstmPrediction, classicalPredictions, symbol);
      // record usage
      const s = this.symbolStats.get(symbol) || { trials: 0, generated: 0 };
      s.trials += 1;
      if (signal) s.generated += 1;
      this.symbolStats.set(symbol, s);
      
      return signal;

    } catch (error) {
      console.error(`[ML Signal Source] Error generating signal for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Aggregate LSTM + classical ML predictions
   */
  private aggregateSignals(
    lstm: LSTMPredictionOutput,
    classical: MLPredictions | undefined,
    symbol: string
  ): MLConsensusSignal {
    const reasoning: string[] = [];
    const modelsUsed: string[] = ['LSTM'];

    // LSTM base mapping with stronger threshold
    const lstmWeight = 0.6;
    const classicalWeight = classical ? 0.4 : 0;

    const lstmDir = lstm.direction.prediction === 'BULLISH' ? 1 : -1;
    const lstmConf = lstm.direction.confidence || 0;
    // enforce stronger LSTM threshold for single-model actions
    let rawLstmSignal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    if (lstmConf > 0.68) rawLstmSignal = lstmDir === 1 ? 'BUY' : 'SELL';

    let classicalDir = 0;
    let classicalConf = 0;
    if (classical) {
      modelsUsed.push('Classical-ML');
      const cp = (String(classical.direction.prediction || '')).toUpperCase();
      classicalDir = (cp === 'BULLISH' || cp === 'BULL') ? 1 : -1;
      classicalConf = classical.direction.confidence || 0;
    }

    // Ensemble scoring: +1 BUY, -1 SELL, 0 HOLD
    const lstmScore = rawLstmSignal === 'BUY' ? (lstmConf) : rawLstmSignal === 'SELL' ? (-lstmConf) : 0;
    const classicalScore = classical ? (classicalDir * classicalConf) : 0;
    const ensembleScore = lstmScore * lstmWeight + classicalScore * classicalWeight;

    // Final decision thresholds
    const ensembleThreshold = 0.55;
    let finalSignal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    if (ensembleScore >= ensembleThreshold) finalSignal = 'BUY';
    else if (ensembleScore <= -ensembleThreshold) finalSignal = 'SELL';

    // Combined confidence and strength
    const combinedConfidence = Math.min(1, Math.max(0, (lstmConf * lstmWeight) + (classicalConf * classicalWeight)));
    const combinedStrength = Math.round(((lstm.direction.strength || 50) * lstmWeight) + ((classical?.direction.strength || 50) * classicalWeight));

    // Reasoning and metadata
    reasoning.push(`LSTM: ${lstm.direction.prediction} ${(lstmConf * 100).toFixed(1)}%`);
    reasoning.push(`Price Target: $${(lstm.price?.predicted ?? 0).toFixed(2)}`);
    if (lstm.regimeDuration) reasoning.push(`RegimeDuration: ~${lstm.regimeDuration.candles}c`);
    reasoning.push(`Volatility: ${(lstm.volatility?.level ?? 'unknown').toUpperCase()}`);
    if (lstm.riskAssessment?.factors?.length) reasoning.push(`Risk: ${lstm.riskAssessment.factors.join(', ')}`);

    // Hold for low ensemble confidence
    if (Math.abs(ensembleScore) < ensembleThreshold) {
      finalSignal = 'HOLD';
      reasoning.push('Ensemble score below threshold -> HOLD');
    }

    // Force HOLD under extreme volatility
    if (lstm.volatility && lstm.volatility.level === 'extreme') {
      finalSignal = 'HOLD';
      reasoning.push('Extreme volatility detected');
    }

    // uncertainty bands and horizon if available on LSTM output
    const predictionHorizon = (lstm.regimeDuration && lstm.regimeDuration.candles) ? lstm.regimeDuration.candles : undefined;
    const uncertaintyBands = (lstm.price && (typeof lstm.price.high === 'number' && typeof lstm.price.low === 'number')) ? { lower: lstm.price.low, upper: lstm.price.high } : null;

    return {
      symbol,
      source: 'ml-lstm',
      timestamp: Date.now(),
      signal: finalSignal,
      confidence: combinedConfidence,
      strength: combinedStrength,
      predictionHorizon,
      uncertaintyBands,
      predictions: {
        lstm,
        classical: classical || null
      },
      reasoning,
      dataPoints: 100,
      modelsUsed
    };
  }

  private createHoldSignal(symbol: string, lstm: LSTMPredictionOutput | null, classical?: MLPredictions): MLConsensusSignal {
    const modelsUsed = ['LSTM'] as string[];
    if (classical) modelsUsed.push('Classical-ML');

    const lstmConf = lstm?.direction?.confidence || 0;
    const classicalConf = classical?.direction?.confidence || 0;
    const combinedConfidence = Math.min(1, (lstmConf * 0.6) + (classicalConf * (classical ? 0.4 : 0)));

    const predictionHorizon = (lstm && lstm.regimeDuration && lstm.regimeDuration.candles) ? lstm.regimeDuration.candles : undefined;
    const uncertaintyBands = (lstm && lstm.price && (typeof lstm.price.high === 'number' && typeof lstm.price.low === 'number')) ? { lower: lstm.price.low, upper: lstm.price.high } : null;

    return {
      symbol,
      source: 'ml-lstm',
      timestamp: Date.now(),
      signal: 'HOLD',
      confidence: Math.min(1, Math.max(0, combinedConfidence)),
      strength: 0,
      predictionHorizon,
      uncertaintyBands,
      predictions: {
        lstm: lstm || null,
        classical: classical || null
      },
      reasoning: ['Insufficient or low-confidence ML prediction — HOLD'],
      dataPoints: 100,
      modelsUsed
    };
  }

  /**
   * Batch generate signals for multiple symbols
   */
  async generateSignalBatch(
    symbols: string[],
    classicalPredictions?: Record<string, MLPredictions>
  ): Promise<MLConsensusSignal[]> {
    // Run generation in parallel but limit concurrency if needed in future
    const settled = await Promise.allSettled(symbols.map(s => this.generateSignal(s, classicalPredictions?.[s])));
    const signals: MLConsensusSignal[] = [];
    for (const res of settled) {
      if (res.status === 'fulfilled' && res.value) signals.push(res.value);
      else if (res.status === 'rejected') console.error('[ML Signal Source] batch error', res.reason);
    }
    return signals;
  }

  /**
   * Score ML signal for position sizing
   */
  scoreSignal(signal: MLConsensusSignal): {
    positionSizePercent: number; // 0-1
    confidence: number;
    riskLevel: string;
  } {
    const baseScore = signal.confidence * signal.strength / 100;
    
    let positionSizePercent = baseScore;
    let riskLevel: string;

    // Scale position based on confidence
    if (signal.confidence > 0.85) {
      positionSizePercent = Math.min(1, baseScore * 1.2);
      riskLevel = 'low';
    } else if (signal.confidence > 0.70) {
      positionSizePercent = baseScore;
      riskLevel = 'medium';
    } else if (signal.confidence > 0.55) {
      positionSizePercent = baseScore * 0.7;
      riskLevel = 'medium-high';
    } else {
      positionSizePercent = baseScore * 0.5;
      riskLevel = 'high';
    }

    // Reduce position for extreme volatility
    if (signal.predictions.lstm?.volatility.level === 'extreme') {
      positionSizePercent *= 0.5;
      riskLevel = 'extreme';
    }

    return {
      positionSizePercent: Math.min(1, Math.max(0, positionSizePercent)),
      confidence: signal.confidence,
      riskLevel
    };
  }
}

export const mlSignalSource = new MLSignalSource(lstmInferenceEngine);
