import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip } from 'recharts';

export default function StrategyOptimizerChartsImpl({ allocationBreakdown, scenarioAnalysis }: any) {
  return (
    <div className="space-y-6">
      <div className="bg-slate-700/50 rounded-lg p-6 border border-slate-600">
        <h3 className="text-lg font-semibold text-white mb-4">Portfolio Allocation</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie data={allocationBreakdown || []} cx="50%" cy="50%" outerRadius={100} dataKey="allocation" label={({ name, allocation }: any) => `${name}: ${allocation.toFixed(1)}%`}>
              {(allocationBreakdown || []).map((entry: any, index: number) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-slate-700/50 rounded-lg p-6 border border-slate-600">
        <h3 className="text-lg font-semibold text-white mb-4">Scenario Analysis</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={scenarioAnalysis || []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="scenario" stroke="#94a3b8" />
            <YAxis stroke="#94a3b8" />
            <Tooltip />
            <Bar dataKey="return" fill="#10b981" name="Expected Return (%)" />
            <Bar dataKey="volatility" fill="#f59e0b" name="Volatility (%)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
