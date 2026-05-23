import React from 'react';
import { ResponsiveContainer, LineChart, Line, Tooltip } from 'recharts';

export default function SparklineCore({ data = [], color = '#60a5fa', height = 40 }: any) {
  if (!data || data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 2, right: 8, left: 0, bottom: 2 }}>
        <Tooltip formatter={(value) => (typeof value === 'number' ? value.toFixed(2) : value)} />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
