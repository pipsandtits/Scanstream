import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, PieChart, Pie, Cell } from 'recharts';

export default function AdaptiveHoldingChartsImpl({ holdingProfile }: { holdingProfile?: any }) {
  if (!holdingProfile) return null;

  const holdingData = [
    { name: '1-2 days', value: holdingProfile.regime1DayCount },
    { name: '3 days', value: holdingProfile.regime3DayCount },
    { name: '5-9 days', value: holdingProfile.regime7DayCount },
    { name: '10-16 days', value: holdingProfile.regime14DayCount },
    { name: '17-21 days', value: holdingProfile.regime21DayCount },
  ];

  const volData = [
    { name: 'Low Vol', value: holdingProfile.volatilityProfile.low },
    { name: 'Medium Vol', value: holdingProfile.volatilityProfile.medium },
    { name: 'High Vol', value: holdingProfile.volatilityProfile.high },
  ];

  return (
    <div className="space-y-4">
      <div>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={holdingData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Bar dataKey="value" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div>
        <ResponsiveContainer width="100%" height={250}>
          <PieChart>
            <Pie data={volData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label>
              <Cell fill="#3b82f6" />
              <Cell fill="#10b981" />
              <Cell fill="#f59e0b" />
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
