/**
 * Cross-Exchange Types
 */
import type { Candle } from '../../types/market-data';

export type SymbolUniverse = {
  symbol: string; // "BTC/USDT"
  exchanges: string[]; // ["binance","kraken"]
};

export type AggregatedCandle = {
  symbol: string;
  exchangeCandles: Record<string, Candle | undefined>; // key=exchange
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  /** aligned worldTime or last update */
  timestamp: number;
  /** exchanges that contributed to this aggregate */
  sourcesSeen: string[];
  /** Overall data quality / freshness confidence (0-100) */
  confidence: number;
  /** Volume-weighted average price across venues */
  vwap?: number;
  /** Total volume across all venues in this window */
  totalVolume?: number;
  /** How many exchanges contributed fresh data */
  activeSources?: number;
  /** Last time this aggregate was updated (ms) */
  lastUpdated?: number;
  /** Per-venue health scores (0-1) */
  venueHealthScores?: Record<string, number>;
};

export interface CrossExchangeSignal {
  symbol: string;
  aggregated: AggregatedCandle;
  spreadImpact: number;           // How much spread affects this trade
  venueConsistency: number;       // 0-1 how aligned exchanges are
  recommendation: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  timestamp: number;
}

export type VenueHealth = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'OFFLINE';
