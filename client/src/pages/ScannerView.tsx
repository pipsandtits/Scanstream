import React from 'react';

export default function ScannerView({ assets, onSelect }: { assets?: any[]; onSelect?: (s:string)=>void }) {
  return (
    <div className="p-4">
      <h3 className="text-sm font-semibold text-slate-200 mb-3">Scanner</h3>
      <div className="grid grid-cols-2 gap-3">
        {(assets || []).map(a => (
          <div key={a.symbol} className="p-3 bg-slate-800 rounded border border-slate-700/40 cursor-pointer" onClick={() => onSelect && onSelect(a.symbol)}>
            <div className="font-semibold">{a.symbol}</div>
            <div className="text-xs text-slate-400">{a.consensusSignal} · {Math.round(a.avgConfidence || 0)}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}
