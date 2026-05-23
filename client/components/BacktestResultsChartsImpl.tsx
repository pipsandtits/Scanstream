import React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

interface Props {
  performanceData: Array<any>;
  tradeBreakdown: Array<any>;
}

const BacktestResultsChartsImpl: React.FC<Props> = ({ performanceData, tradeBreakdown }) => {
  return (
    <>
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-gray-700">Trade Distribution</h4>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={tradeBreakdown}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e5e7eb' }} />
            <Legend />
            <Bar dataKey="trades" fill="#3b82f6" name="Total Trades" />
            <Bar dataKey="wins" fill="#10b981" name="Winning Trades" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-gray-700">Performance Metrics</h4>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={performanceData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e5e7eb' }} />
            <Legend />
            <Bar dataKey="Overall" fill="#3b82f6" name="Overall" />
            <Bar dataKey="Long" fill="#10b981" name="Long" />
            <Bar dataKey="Short" fill="#ef4444" name="Short" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
};

export default BacktestResultsChartsImpl;
