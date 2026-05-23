export interface ChartDataPoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  rsi?: number | null;
  macd?: number | null;
  ema?: number | null;
}

export type ChartSeries = ChartDataPoint[];

export default ChartDataPoint;
