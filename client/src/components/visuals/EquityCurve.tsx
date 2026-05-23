import React, { useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

export interface EquityPoint { timestamp: number; equity: number }

export default function EquityCurve({ data = [], height = 220 }: { data?: EquityPoint[]; height?: number }) {
  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    let peak = -Infinity;
    return data.map(d => {
      peak = Math.max(peak, d.equity);
      const drawdown = peak > 0 ? (d.equity - peak) / peak : 0;
      return { ...d, drawdown };
    });
  }, [data]);

  if (!chartData.length) return <div className="text-sm text-slate-400">No equity data</div>;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.06} />
          <XAxis
            dataKey="timestamp"
            tickFormatter={(t) => new Date(t).toLocaleDateString()}
            stroke="#94a3b8"
            tick={{ fontSize: 11 }}
          />
          <YAxis
            tickFormatter={(v) => v.toFixed(0)}
            stroke="#94a3b8"
            tick={{ fontSize: 11 }}
            width={80}
          />
          <Tooltip labelFormatter={(l) => new Date(Number(l)).toLocaleString()} />

          {/* Equity line */}
          <Area type="monotone" dataKey="equity" stroke="#06b6d4" fillOpacity={0.12} fill="#06b6d4" />

          {/* Drawdown area (negative values) */}
          <Area
            type="monotone"
            dataKey={(d: any) => Math.min(0, d.drawdown * 100)}
            name="Drawdown%"
            stroke="transparent"
            fill="#ef4444"
            fillOpacity={0.12}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
