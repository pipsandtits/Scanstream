import React from 'react';
import { ResponsiveContainer, LineChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Line } from 'recharts';

export default function GatewayMetricsChartsCore({ latencyData, usageData }: { latencyData?: any; usageData?: any }) {
  return (
    <>
      {(latencyData as any)?.success && (
        <div>
          <h3 className="text-lg font-semibold mb-4">Exchange Latency Trends</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={(latencyData as any)?.data || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis 
                dataKey="timestamp" 
                stroke="#9ca3af"
                tickFormatter={(val: any) => new Date(val).toLocaleTimeString()}
              />
              <YAxis stroke="#9ca3af" label={{ value: 'Latency (ms)', angle: -90 }} />
              <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }} />
              <Legend />
              <Line type="monotone" dataKey="exchanges.binance" stroke="#3b82f6" name="Binance" />
              <Line type="monotone" dataKey="exchanges.coinbase" stroke="#10b981" name="Coinbase" />
              <Line type="monotone" dataKey="exchanges.kraken" stroke="#8b5cf6" name="Kraken" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {(usageData as any)?.success && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold mb-4">Rate Limit Usage</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={(usageData as any)?.data || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis 
                dataKey="timestamp" 
                stroke="#9ca3af"
                tickFormatter={(val: any) => new Date(val).toLocaleTimeString()}
              />
              <YAxis stroke="#9ca3af" label={{ value: 'Usage %', angle: -90 }} />
              <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }} />
              <Legend />
              <Line type="monotone" dataKey="exchanges.binance" stroke="#3b82f6" name="Binance" />
              <Line type="monotone" dataKey="exchanges.coinbase" stroke="#10b981" name="Coinbase" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}
