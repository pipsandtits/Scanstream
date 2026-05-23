import React from 'react';
import { ResponsiveContainer, BarChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Bar } from 'recharts';

interface Props {
  data: Array<any>;
}

const MLConsensusWidgetChartImpl: React.FC<Props> = ({ data }) => {
  return (
    <div className="space-y-3">
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="timeframe" />
          <YAxis yAxisId="left" />
          <YAxis yAxisId="right" orientation="right" />
          <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e5e7eb' }} formatter={(value: any) => (typeof value === 'number' ? value.toFixed(1) : value)} />
          <Legend />
          <Bar yAxisId="left" dataKey="confidence" fill="#3b82f6" name="Confidence %" />
          <Bar yAxisId="right" dataKey="riskScore" fill="#f59e0b" name="Risk Score" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default MLConsensusWidgetChartImpl;
