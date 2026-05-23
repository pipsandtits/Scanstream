import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, LineChart, Line, PieChart, Pie, Cell } from 'recharts';

export default function SignalHistoryChartsImpl({ qualityAccuracyData, confidencePnLData, sourceDistribution, COLORS }: any) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="bg-white rounded p-4 border border-gray-200">
        <p className="font-bold text-sm mb-3">Signal Quality vs Accuracy</p>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={qualityAccuracyData || []}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="quality" angle={-45} textAnchor="end" height={80} />
            <YAxis />
            <Tooltip />
            <Bar dataKey="accuracy" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-white rounded p-4 border border-gray-200">
        <p className="font-bold text-sm mb-3">P&L by Confidence Level</p>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={confidencePnLData || []}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="confidence" angle={-45} textAnchor="end" height={80} />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="avgPnL" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-white rounded p-4 border border-gray-200">
        <p className="font-bold text-sm mb-3">Signals by Source</p>
        <ResponsiveContainer width="100%" height={250}>
          <PieChart>
            <Pie data={sourceDistribution || []} cx="50%" cy="50%" outerRadius={80} dataKey="value" label>
              {(sourceDistribution || []).map((entry: any) => (
                <Cell key={`cell-${entry.name}`} fill={COLORS?.[entry.name] || '#ccc'} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
