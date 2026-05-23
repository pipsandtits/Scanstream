import React from 'react';

export default function PositionsView({ positions }: { positions?: any[] }) {
  return (
    <div className="p-4">
      <h3 className="text-sm font-semibold text-slate-200 mb-3">Positions</h3>
      {(!positions || positions.length === 0) ? (
        <div className="text-sm text-slate-400">No positions</div>
      ) : (
        <div className="space-y-2">
          {positions.map(p => (
            <div key={p.id} className="p-3 bg-slate-800 rounded border border-slate-700/40">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{p.symbol}</div>
                  <div className="text-xs text-slate-400">{p.side} · {p.size}</div>
                </div>
                <div className="text-right">
                  <div className={`font-semibold ${p.pnl>=0 ? 'text-emerald-400' : 'text-red-400'}`}>${(p.pnl||0).toFixed(2)}</div>
                  <div className="text-xs text-slate-400">{(p.pnlPercent||0).toFixed(2)}%</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
