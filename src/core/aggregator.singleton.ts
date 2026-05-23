import { ExchangeAggregator } from '../../server/services/gateway/exchange-aggregator';
import { CacheManager } from '../../server/services/gateway/cache-manager';
import { RateLimiter } from '../../server/services/gateway/rate-limiter';

let _instance: ExchangeAggregator | null = null;

export async function initAggregator(cacheManager: CacheManager, rateLimiter: RateLimiter): Promise<ExchangeAggregator> {
  if (_instance) return _instance;
  _instance = new ExchangeAggregator(cacheManager, rateLimiter);
  await _instance.initialize();
  return _instance;
}

export function getAggregator(): ExchangeAggregator {
  if (!_instance) throw new Error('Aggregator not initialized — call initAggregator() first');
  return _instance;
}

export function resetAggregator(): void {
  _instance = null;
}
