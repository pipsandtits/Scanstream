import type * as ccxt from 'ccxt';

/**
 * Try to derive a usable USD-equivalent account balance from a CCXT fetchBalance result.
 * This is a best-effort heuristic: prefer stablecoin/fiat totals (USDT, USD, USDC, BUSD),
 * then common top-level equity fields, then numeric totals fallback.
 */
export async function getAccountBalanceUsd(exchange: ccxt.Exchange | null): Promise<number | null> {
  if (!exchange || typeof (exchange as any).fetchBalance !== 'function') return null;

  try {
    const bal: any = await (exchange as any).fetchBalance();

    if (!bal) return null;

    // Common stablecoin/fiat keys in balance.total
    const preferred = ['USDT', 'USD', 'USDC', 'BUSD', 'TUSD'];
    if (bal.total && typeof bal.total === 'object') {
      for (const key of preferred) {
        if (bal.total[key] !== undefined && bal.total[key] !== null) {
          const v = Number(bal.total[key]);
          if (!isNaN(v)) return v;
        }
      }
    }

    // Some exchanges include aggregated equity fields in info
    if (bal.info) {
      const info = bal.info;
      const candidates = ['equity', 'totalWalletBalance', 'total_balance', 'balance'];
      for (const c of candidates) {
        if (info[c] !== undefined && info[c] !== null) {
          const v = Number(info[c]);
          if (!isNaN(v)) return v;
        }
      }
    }

    // If total is numeric (some adapters), use it
    if (typeof bal.total === 'number') return bal.total;

    // As a last resort, sum numeric values in total (WARNING: may mix currencies)
    if (bal.total && typeof bal.total === 'object') {
      let sum = 0;
      for (const v of Object.values(bal.total)) {
        const n = Number(v);
        if (!isNaN(n) && n !== 0) sum += n;
      }
      if (sum > 0) return sum;
    }

    return null;
  } catch (err) {
    return null;
  }
}

export default getAccountBalanceUsd;
