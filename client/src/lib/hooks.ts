import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import fetchJson from './api';

const FeatureImportanceSchema = z.object({
  data: z.array(
    z.object({
      featureName: z.string(),
      importance: z.number(),
      correlationWithSuccess: z.number().optional(),
      usageFrequency: z.number().optional(),
      avgContribution: z.number().optional(),
    })
  )
});

const FeatureSetsSchema = z.object({
  data: z.array(z.any())
});

export function useFeatureImportance() {
  return useQuery(['/api/feature-engineering/importance'], async () => {
    return await fetchJson('/api/feature-engineering/importance', { retries: 2 }, FeatureImportanceSchema);
  }, { retry: 2, staleTime: 1000 * 60 * 5 });
}

export function useFeatureSets() {
  return useQuery(['/api/feature-engineering/feature-sets'], async () => {
    return await fetchJson('/api/feature-engineering/feature-sets', { retries: 2 }, FeatureSetsSchema);
  }, { retry: 1 });
}

const PriceHistorySchema = z.object({ data: z.array(z.object({ time: z.number(), price: z.number() })) });
export function usePriceHistory(positionId?: string) {
  return useQuery(['price-history', positionId], async () => {
    if (!positionId) return { data: [] };
    return await fetchJson(`/api/positions/${positionId}/price-history`, { retries: 2 }, PriceHistorySchema);
  }, { enabled: !!positionId, retry: 2 });
}

const RLTrainingSchema = z.object({ data: z.array(z.any()) });
export function useRLTrainingPerformance() {
  return useQuery(['/api/rl/training/performance'], async () => {
    return await fetchJson('/api/rl/training/performance', { retries: 2 }, RLTrainingSchema);
  }, { retry: 2, staleTime: 1000 * 60 });
}

const ActiveCombosSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    timestamp: z.string(),
    comboName: z.string(),
    agents: z.array(z.string()),
    bonusMultiplier: z.number().optional(),
    description: z.string().optional(),
    impact: z.number().optional(),
    duration: z.number().optional(),
  }))
});

export function useActiveCombos() {
  return useQuery(['active-combos'], async () => {
    return await fetchJson('/api/agents/combos', { retries: 2 }, ActiveCombosSchema);
  }, { refetchInterval: 10000, retry: 1, staleTime: 5000 });
}

const CorrelationSchema = z.object({
  data: z.object({
    symbols: z.array(z.string()),
    correlations: z.array(z.array(z.number())),
  })
});

export function useCorrelationData() {
  return useQuery(['market-correlations'], async () => {
    return await fetchJson('/api/market/correlations', { retries: 1 }, CorrelationSchema);
  }, { retry: 1, staleTime: 1000 * 60 * 2 });
}

const MarketStatusSchema = z.object({
  data: z.object({
    tickers: z.array(z.object({ symbol: z.string(), price: z.number(), change: z.number(), changePercent: z.number() })),
    exchangeStatus: z.object({ isOperational: z.boolean().optional(), latency: z.number().optional() }).optional(),
    volume24h: z.number().optional(),
    portfolioValue: z.number().optional(),
    dayChangePercent: z.number().optional(),
    mdlConnected: z.boolean().optional(),
    mdlRetryInfo: z.any().optional(),
  })
});

export function useMarketStatus() {
  return useQuery(['market-status'], async () => {
    return await fetchJson('/api/market/status', { retries: 1 }, MarketStatusSchema);
  }, { retry: 1, refetchInterval: 5000, staleTime: 2000 });
}

const MLConsensusSchema = z.object({
  symbol: z.string(),
  timestamp: z.number(),
  consensus: z.object({
    direction: z.string(),
    confidence: z.number(),
    strength: z.number(),
    timeframesAgree: z.number(),
    totalTimeframes: z.number(),
  }),
  timeframes: z.array(z.object({
    timeframe: z.string(),
    direction: z.string(),
    confidence: z.number(),
    strength: z.number(),
    probability: z.number().optional(),
    riskScore: z.number().optional(),
    volatility: z.number().optional(),
    weight: z.number().optional(),
  })),
  aggregatedMetrics: z.object({
    avgRiskScore: z.number(),
    maxVolatility: z.number(),
    shortestRegimeDuration: z.string(),
    velocityConfidenceAvg: z.number(),
  }).optional()
});

export function useMLConsensus(symbol?: string) {
  return useQuery(['ml-consensus', symbol], async () => {
    if (!symbol) return null;
    return await fetchJson(`/api/ml/mtf/predictions/${symbol}`, { retries: 2 }, MLConsensusSchema);
  }, { enabled: !!symbol, retry: 2, refetchInterval: 60000, staleTime: 1000 * 30 });
}

const BacktestResultsSchema = z.object({
  stats: z.object({
    symbol: z.string(),
    timeframe: z.string(),
    totalTrades: z.number(),
    winRate: z.string(),
    avgProfit: z.string(),
    totalProfit: z.string(),
    sharpeRatio: z.string(),
    maxDrawdown: z.string(),
    byDirection: z.object({
      long: z.object({ trades: z.number(), wins: z.number(), winRate: z.string(), avgProfit: z.string().optional() }),
      short: z.object({ trades: z.number(), wins: z.number(), winRate: z.string(), avgProfit: z.string().optional() }),
    })
  })
});

export function useBacktestResults(symbol?: string, timeframe?: string) {
  return useQuery(['backtest-results', symbol, timeframe], async () => {
    if (!symbol || !timeframe) return null;
    return await fetchJson(`/api/ml/mtf/backtest?symbol=${symbol}&timeframe=${timeframe}`, { retries: 2 }, BacktestResultsSchema);
  }, { enabled: !!symbol && !!timeframe, retry: 1, refetchInterval: 300000, staleTime: 1000 * 60 * 5 });
}

const ActiveTradesSchema = z.object({
  trades: z.array(z.object({
    id: z.string(),
    symbol: z.string(),
    direction: z.string(),
    entryPrice: z.number(),
    quantity: z.number(),
    positionSize: z.number(),
    stopLoss: z.number().optional(),
    takeProfit: z.number().optional(),
    confidence: z.number().optional(),
    executedAt: z.string().optional(),
    currentPrice: z.number().optional(),
    unrealizedPL: z.number().optional(),
    unrealizedPLPercent: z.number().optional(),
  }))
});

export function useActiveTrades() {
  return useQuery(['active-trades'], async () => {
    return await fetchJson('/api/ml/trades/active', { retries: 1 }, ActiveTradesSchema);
  }, { retry: 1, refetchInterval: 30000, staleTime: 5000 });
}

const TradeStatsSchema = z.object({
  stats: z.object({
    totalTrades: z.number().optional(),
    winningTrades: z.number().optional(),
    losingTrades: z.number().optional(),
    winRate: z.number().optional(),
    averageProfitUSD: z.number().optional(),
    averageLossUSD: z.number().optional(),
    profitFactor: z.number().optional(),
    totalProfitLoss: z.number().optional(),
    largestWin: z.number().optional(),
    largestLoss: z.number().optional(),
  })
});

export function useTradeStats() {
  return useQuery(['trade-stats'], async () => {
    return await fetchJson('/api/ml/trades/statistics', { retries: 1 }, TradeStatsSchema);
  }, { retry: 1, refetchInterval: 30000, staleTime: 5000 });
}
