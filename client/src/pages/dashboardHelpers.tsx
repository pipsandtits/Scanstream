import React from 'react';

export function AgentPips({ buy, hold, sell }: { buy: number; hold: number; sell: number }) {
  const total = 13;
  const empty = Math.max(0, total - buy - hold - sell);
  return (
    <div className="flex gap-px flex-wrap justify-end">
      {Array(buy).fill(null).map((_, i) => (
        <div key={`b${i}`} className="w-1.5 h-1.5 rounded-sm bg-emerald-500 flex-shrink-0" />
      ))}
      {Array(hold).fill(null).map((_, i) => (
        <div key={`h${i}`} className="w-1.5 h-1.5 rounded-sm bg-amber-500 flex-shrink-0" />
      ))}
      {Array(sell).fill(null).map((_, i) => (
        <div key={`s${i}`} className="w-1.5 h-1.5 rounded-sm bg-red-500 flex-shrink-0" />
      ))}
      {Array(empty).fill(null).map((_, i) => (
        <div key={`e${i}`} className="w-1.5 h-1.5 rounded-sm bg-slate-700 flex-shrink-0" />
      ))}
    </div>
  );
}

export function VoteBar({ buy, hold, sell, total = 13 }: { buy: number; hold: number; sell: number; total?: number }) {
  const pct = (n: number) => Math.max(0, Math.min(100, Math.round((n / total) * 100)));
  const pb = pct(buy);
  const ph = pct(hold);
  const ps = pct(sell);

  return (
    <div className="flex h-1.5 rounded overflow-hidden mt-2 bg-slate-700">
      <div className={`bg-emerald-400 h-full w-[${pb}%]`} />
      <div className={`bg-amber-400 h-full w-[${ph}%]`} />
      <div className={`bg-red-400 h-full w-[${ps}%]`} />
    </div>
  );
}

import Sparkline from '@/components/ui/Sparkline';

export function SparklineFromAsset({ asset, width = 60, height = 20 }: { asset: any; width?: number; height?: number }) {
  const prices: number[] = (() => {
    const anyAsset = asset as any;
    if (Array.isArray(anyAsset.history) && anyAsset.history.length > 2) return anyAsset.history.slice(-12).map((p: any) => Number(p.close ?? p));
    const cur = Number(asset.price || 0) || 0;
    const pct = Number(asset.priceChange || 0) / 100;
    const prev = pct !== -1 ? cur / (1 + pct) : cur * 0.99;
    const points = 8;
    const seed = Array.from(String(asset.symbol)).reduce((s, ch) => s + (ch as string).charCodeAt(0), 0);
    const vals: number[] = [];
    for (let i = 0; i < points; i++) {
      const t = i / (points - 1);
      const jitter = ((Math.sin(seed + i * 12.9898) * 43758.5453) % 1) * (cur * 0.002);
      vals.push(prev + (cur - prev) * t + jitter);
    }
    return vals;
  })();

  if (!prices || prices.length < 2) return null;
  return <Sparkline values={prices} width={width} height={height} />;
}

export { SparklineFromAsset as Sparkline };
export { Sparkline as RawSparkline };
