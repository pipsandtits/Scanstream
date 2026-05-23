import React from 'react';
import { BarChartCore, ScatterChartCore } from './charts';
import { Cell } from 'recharts';

export default function BacktestCharts({ monthlyHeatmapData, tradeScatterData }: { monthlyHeatmapData?: any[]; tradeScatterData?: any[] }) {
  return (
    <div className="space-y-6">
      <div>
        <BarChartCore data={monthlyHeatmapData || []} height={200}>
          {(monthlyHeatmapData || []).map((entry: any, index: number) => (
            <Cell key={`cell-${index}`} fill={entry.fill} />
          ))}
        </BarChartCore>
      </div>

      <div>
        <ScatterChartCore data={tradeScatterData || []} height={250} />
      </div>
    </div>
  );
}
