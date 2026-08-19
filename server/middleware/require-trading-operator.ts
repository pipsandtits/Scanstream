/**
 * Guard for capital-moving endpoints (start/stop live trading, config changes,
 * order execution, position closes, flatten-all).
 *
 * The application has no working session auth on these routes today (`req.user`
 * is never populated), which means anything that can reach the port can place
 * live orders. Until real auth exists, these routes require an operator token.
 *
 * Fail closed: if `TRADING_OPERATOR_TOKEN` is not configured, the endpoints are
 * unavailable rather than open.
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireTradingOperator(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.TRADING_OPERATOR_TOKEN;

  if (!expected) {
    return res.status(503).json({
      success: false,
      error:
        'Trading control endpoints are disabled: TRADING_OPERATOR_TOKEN is not configured on the server',
    });
  }

  const header = req.headers['x-trading-operator-token'];
  const provided = Array.isArray(header) ? header[0] : header;

  if (!provided || !timingSafeEqual(String(provided), expected)) {
    // Never log the provided value.
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid operator token' });
  }

  next();
}

export default requireTradingOperator;
