import React from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

interface DataPoint {
  time: string;
  [key: string]: any;
}

interface LineChartCoreProps {
  data: DataPoint[];
  height?: number;
  lines?: { key: string; color?: string; name?: string }[];
  yDomain?: [number, number] | undefined;
}

export default function LineChartCoreImpl({ data, height = 300, lines = [{ key: 'price', color: '#3b82f6', name: 'Price' }], yDomain }: LineChartCoreProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="time" />
        <YAxis domain={yDomain} />
        <Tooltip formatter={(v: any) => (typeof v === 'number' ? v.toFixed(2) : v)} />
        <Legend />
        {lines.map((l) => (
          <Line key={l.key} type="monotone" dataKey={l.key} stroke={l.color || '#3b82f6'} dot={false} isAnimationActive={false} name={l.name || l.key} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
