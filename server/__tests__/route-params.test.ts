import { describe, expect, it } from 'vitest';
import { InvalidRouteParamError, routeParam, routeParamEnum } from '../utils/route-params';

describe('route parameter validation', () => {
  it('returns bounded string parameters without coercing arrays', () => {
    expect(routeParam('BTC/USDT', 'symbol', 64)).toBe('BTC/USDT');
    expect(() => routeParam(['BTC/USDT'], 'symbol', 64)).toThrow(InvalidRouteParamError);
    expect(() => routeParam('x'.repeat(65), 'symbol', 64)).toThrow(InvalidRouteParamError);
  });

  it('narrows allowlisted parameters', () => {
    expect(routeParamEnum('GET', 'method', ['GET', 'POST'] as const)).toBe('GET');
    expect(() => routeParamEnum('TRACE', 'method', ['GET', 'POST'] as const)).toThrow(InvalidRouteParamError);
  });
});
