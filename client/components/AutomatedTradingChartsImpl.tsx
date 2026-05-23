import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';

interface Props {
  stats: any;
}

const AutomatedTradingChartsImpl: React.FC<Props> = ({ stats }) => {
  if (!stats) return null;

  const pieData = [
    { name: 'Wins', value: stats.winningTrades || 0 },
    { name: 'Losses', value: stats.losingTrades || 0 },
  ];

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={pieData}
          cx="50%"
          cy="50%"
          labelLine={false}
          label={({ name, value }) => `${name}: ${value}`}
          outerRadius={80}
          fill="#8884d8"
          dataKey="value"
        >
          <Cell fill="#22c55e" />
          <Cell fill="#ef4444" />
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
};

export default AutomatedTradingChartsImpl;
