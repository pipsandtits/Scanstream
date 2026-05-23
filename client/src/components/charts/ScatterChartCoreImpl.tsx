import React from 'react';
import { ResponsiveContainer, ScatterChart, Scatter, CartesianGrid, XAxis, YAxis, Tooltip } from 'recharts';

interface ScatterChartCoreProps {
  data?: any[];
  xKey?: string;
  yKey?: string;
  height?: number;
  children?: React.ReactNode;
}

export default function ScatterChartCoreImpl({ data = [], xKey = 'x', yKey = 'y', height = 300 }: ScatterChartCoreProps) {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis type="number" dataKey={xKey} stroke="#94a3b8" />
          <YAxis type="number" dataKey={yKey} stroke="#94a3b8" />
          <Tooltip />
          <Scatter name="Data" data={data} fill="#3b82f6" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
