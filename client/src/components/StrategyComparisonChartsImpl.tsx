import React from 'react';
import { ResponsiveContainer, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ComposedChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Line } from 'recharts';

export default function StrategyComparisonChartsImpl({ radarData, equityData, selectedStrategyData, colors, activeTab }: any) {
  if (activeTab === 'radar') {
    return (
      <div className="bg-slate-900/50 rounded-lg p-6 border border-slate-700">
        <ResponsiveContainer width="100%" height={400}>
          <RadarChart data={radarData}>
            <PolarGrid />
            <PolarAngleAxis dataKey="metric" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
            <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fill: '#cbd5e1', fontSize: 10 }} />
            {selectedStrategyData.map((strategy: any, index: number) => (
              <Radar key={strategy.id} name={strategy.name} dataKey={strategy.name} stroke={colors[index]} fill={colors[index]} fillOpacity={0.3} strokeWidth={2} />
            ))}
            <Legend />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (activeTab === 'equity') {
    return (
      <div className="bg-slate-900/50 rounded-lg p-6 border border-slate-700">
        <ResponsiveContainer width="100%" height={400}>
          <ComposedChart data={equityData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
            <XAxis dataKey="date" stroke="#94a3b8" tick={{ fontSize: 12 }} />
            <YAxis stroke="#94a3b8" tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {selectedStrategyData.map((strategy: any, index: number) => (
              <Line key={strategy.id} type="monotone" dataKey={strategy.name} stroke={colors[index]} strokeWidth={2} dot={false} name={strategy.name} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return null;
}
