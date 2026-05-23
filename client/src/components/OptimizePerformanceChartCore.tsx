import React from 'react';
import { ResponsiveContainer, LineChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Line } from 'recharts';

export default function OptimizePerformanceChartCore({ data = [] }: { data?: any[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data || []}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="iteration" stroke="#94a3b8" />
        <YAxis stroke="#94a3b8" />
        <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '8px' }} labelStyle={{ color: '#e2e8f0' }} />
        <Legend />
        <Line type="monotone" dataKey="performance" stroke="#3b82f6" strokeWidth={2} name="Current Performance" />
        <Line type="monotone" dataKey="bestPerformance" stroke="#22c55e" strokeWidth={2} strokeDasharray="5 5" name="Best Performance" />
      </LineChart>
    </ResponsiveContainer>
  );
}
