import React from 'react';
import { ResponsiveContainer, LineChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Line } from 'recharts';

export default function RLTrainingPerformanceChartImpl({ data, colors }: { data?: any[]; colors: any }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data || []}>
        <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
        <XAxis dataKey="episode" stroke={colors.textSecondary} />
        <YAxis stroke={colors.textSecondary} />
        <Tooltip
          contentStyle={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}`, borderRadius: '8px' }}
          labelStyle={{ color: colors.text }}
        />
        <Legend />
        <Line type="monotone" dataKey="reward" stroke={colors.accent} strokeWidth={2} name="Episode Reward" />
        <Line type="monotone" dataKey="avgReturn" stroke={colors.success} strokeWidth={2} strokeDasharray="5 5" name="Avg Return" />
      </LineChart>
    </ResponsiveContainer>
  );
}
