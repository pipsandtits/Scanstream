import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Cell } from 'recharts';

interface BarChartCoreProps {
  data: Record<string, unknown>[];
  dataKey: string;
  layout?: 'vertical' | 'horizontal';
  height?: number;
  children?: React.ReactNode;
  cellColors?: string[];
  barProps?: Record<string, unknown>;
  xAxisProps?: Record<string, unknown>;
  yAxisProps?: Record<string, unknown>;
  gridProps?: Record<string, unknown>;
  tooltipProps?: Record<string, unknown>;
  legendProps?: Record<string, unknown>;
}

export default function BarChartCoreImpl({
  data,
  dataKey,
  layout = 'horizontal',
  height = 200,
  children,
  cellColors,
  barProps,
  xAxisProps,
  yAxisProps,
  gridProps,
  tooltipProps,
  legendProps,
}: BarChartCoreProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout={layout}>
        <CartesianGrid {...(gridProps || { strokeDasharray: '3 3', stroke: '#334155' })} />
        <XAxis {...(xAxisProps || { dataKey: layout === 'vertical' ? undefined : 'timestamp', stroke: '#94a3b8' })} />
        <YAxis {...(yAxisProps || { stroke: '#94a3b8' })} />
        <Tooltip {...(tooltipProps || {})} />
        <Legend {...(legendProps || {})} />
        {children ?? (
          <Bar dataKey={dataKey} fill="#3b82f6" {...barProps}>
            {cellColors && cellColors.length > 0 && cellColors.map((c, i) => <Cell key={i} fill={c} />)}
          </Bar>
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
