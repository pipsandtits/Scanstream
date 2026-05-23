export const worldTicksKey = ['worldTicks'] as const;
export const marketFramesKey = (exchange = 'default') => ['marketFrames', exchange] as const;
export const orderbookKey = (symbol: string) => ['orderbook', symbol] as const;
export const positionsKey = ['positions'] as const;
export const portfolioSummaryKey = ['portfolio', 'summary'] as const;

export type QueryKeyFactory = typeof marketFramesKey | typeof orderbookKey;
