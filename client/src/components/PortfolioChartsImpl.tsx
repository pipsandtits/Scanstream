import React from 'react';
import { ResponsiveContainer, ComposedChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Area, Line, PieChart, Pie, Cell } from 'recharts';

export function WinRateChart({ data }: { data?: any[] }) {
  return (
    <ResponsiveContainer width="100%" height={350}>
      <ComposedChart data={data || []}>
        <defs>
          <linearGradient id="winRateGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/>
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
        <XAxis dataKey="trade" stroke="#94a3b8" style={{ fontSize: '12px' }} label={{ value: 'Trade Number', position: 'insideBottom', offset: -5 }} />
        <YAxis stroke="#94a3b8" style={{ fontSize: '12px' }} label={{ value: 'Win Rate %', angle: -90, position: 'insideLeft' }} />
        <Tooltip />
        <Legend />
        <Area type="monotone" dataKey="winRate" fill="url(#winRateGradient)" stroke="#22c55e" strokeWidth={2} name="Rolling Win Rate (20 trades)" />
        <Line type="monotone" dataKey="cumulativeWinRate" stroke="#3b82f6" strokeWidth={2} dot={false} name="Cumulative Win Rate" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function TradeDistributionChart({ data }: { data?: any[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie data={data || []} cx="50%" cy="50%" labelLine={false} label={({ name, percent }: any) => `${name.split('(')[0]}: ${((percent || 0) * 100).toFixed(0)}%`} outerRadius={100} fill="#8884d8" dataKey="count">
          {(data || []).map((entry: any, index: number) => (
            <Cell key={`cell-${index}`} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function SignalQualityChart({ data }: { data?: any[] }) {
  return (
    <ResponsiveContainer width="100%" height={350}>
      <ComposedChart data={data || []}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
        <XAxis dataKey="trade" stroke="#94a3b8" style={{ fontSize: '12px' }} />
        <YAxis stroke="#94a3b8" style={{ fontSize: '12px' }} />
        <Tooltip />
        <Legend />
        <Area type="monotone" dataKey="returnPct" fill="#3b82f6" stroke="#3b82f6" fillOpacity={0.2} name="Return %" />
        <Line type="monotone" dataKey="avgReturn" stroke="#22c55e" strokeWidth={2} dot={false} name="Average Return" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

const defaultExport = {
  WinRateChart,
  TradeDistributionChart,
  SignalQualityChart
};

export default defaultExport;
