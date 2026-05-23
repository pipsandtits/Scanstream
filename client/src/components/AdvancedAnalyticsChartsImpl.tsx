import React, { Suspense } from 'react';
import { ResponsiveContainer, ScatterChart, CartesianGrid, XAxis, YAxis, Tooltip, Scatter, Cell } from '@/components/ui/RechartsLazy';
import CorrelationMatrix from './visuals/CorrelationMatrix';
import LiquidityHeatmap from './visuals/LiquidityHeatmap';

export default function AdvancedAnalyticsChartsImpl({ clusterData, clusterColors, colors }: { clusterData?: any; clusterColors?: string[]; colors?: any }) {
  // sample data for heatmap / correlation when clusterData lacks it
  const labels = (clusterData?.symbols) || ['A','B','C','D','E'];
  const matrix = clusterData?.correlationMatrix || (labels.map(() => labels.map(() => Math.random())));
  const liquidity = (clusterData?.liquidity || []).map((d: any) => ({ exchange: d.exchange || 'ex', symbol: d.symbol || 'SYM', depth: d.depth || Math.random()*100 }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="col-span-1 lg:col-span-2">
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke={colors?.border || '#374151'} />
            <XAxis dataKey="volatility" name="Volatility" stroke={colors?.textSecondary || '#9ca3af'} />
            <YAxis dataKey="avgReturn" name="Avg Return" stroke={colors?.textSecondary || '#9ca3af'} />
            <Tooltip contentStyle={{ backgroundColor: colors?.surface || '#111827', border: `1px solid ${colors?.border || '#374151'}`, borderRadius: '8px' }} />
            <Scatter name="Clusters" data={clusterData?.clusters || []} fill={colors?.accent || '#3b82f6'}>
              {(clusterData?.clusters || []).map((entry: any, index: number) => (
                <Cell key={`cell-${index}`} fill={clusterColors ? clusterColors[index % clusterColors.length] : '#3b82f6'} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <div className="col-span-1">
        <div className="rounded-lg border p-2" style={{ backgroundColor: colors?.surface, borderColor: colors?.border }}>
          <h4 className="text-sm font-semibold text-white mb-2">Liquidity Heatmap</h4>
          <Suspense fallback={<div style={{ height: 200 }} /> }>
            <LiquidityHeatmap data={liquidity} height={200} />
          </Suspense>
        </div>
      </div>

      <div className="col-span-1 lg:col-span-3">
        <div className="rounded-lg border p-2 mt-2" style={{ backgroundColor: colors?.surface, borderColor: colors?.border }}>
          <h4 className="text-sm font-semibold text-white mb-2">Correlation Matrix</h4>
          <Suspense fallback={<div style={{ height: 320 }} /> }>
            <CorrelationMatrix matrix={matrix} labels={labels} height={320} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
