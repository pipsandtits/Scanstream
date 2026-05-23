import React, { useMemo } from 'react';

interface Level { price: number; size: number }

export default function OrderbookDepth({ bids = [], asks = [], maxWidth = 220 }: { bids?: Level[]; asks?: Level[]; maxWidth?: number }) {
  // compute cumulative
  const cumBids = useMemo(() => {
    const out: { price: number; size: number; cum: number }[] = [];
    let cum = 0;
    bids.slice().sort((a,b)=>b.price-a.price).forEach(l=>{ cum += l.size; out.push({ price: l.price, size: l.size, cum }); });
    return out;
  }, [bids]);

  const cumAsks = useMemo(() => {
    const out: { price: number; size: number; cum: number }[] = [];
    let cum = 0;
    asks.slice().sort((a,b)=>a.price-b.price).forEach(l=>{ cum += l.size; out.push({ price: l.price, size: l.size, cum }); });
    return out;
  }, [asks]);

  const maxCum = Math.max(
    cumBids.length ? cumBids[cumBids.length-1].cum : 0,
    cumAsks.length ? cumAsks[cumAsks.length-1].cum : 0,
    1
  );

  return (
    <div className="w-full flex gap-4">
      {/* Bids (left) */}
      <div className="flex-1">
        <div className="text-xs text-slate-400 mb-2">Bids</div>
        <div className="space-y-1">
          {cumBids.map((l, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <div className="w-16 text-right text-slate-300">{l.price.toFixed(2)}</div>
              <div className="h-4 bg-slate-700 rounded overflow-hidden flex-1">
                <div className="h-full bg-emerald-500" style={{ width: `${(l.cum / maxCum) * 100}%` }} />
              </div>
              <div className="w-20 text-right text-slate-400">{l.size}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Asks (right) */}
      <div className="flex-1">
        <div className="text-xs text-slate-400 mb-2">Asks</div>
        <div className="space-y-1">
          {cumAsks.map((l, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <div className="w-16 text-right text-slate-300">{l.price.toFixed(2)}</div>
              <div className="h-4 bg-slate-700 rounded overflow-hidden flex-1">
                <div className="h-full bg-red-500" style={{ width: `${(l.cum / maxCum) * 100}%` }} />
              </div>
              <div className="w-20 text-right text-slate-400">{l.size}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
