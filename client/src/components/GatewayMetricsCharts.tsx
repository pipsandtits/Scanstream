import React, { Suspense, lazy } from 'react';

const GatewayMetricsChartsCore = lazy(() => import('@/components/GatewayMetricsChartsCore'));

export default function GatewayMetricsCharts(props: { latencyData?: any; usageData?: any }) {
  return (
    <Suspense fallback={<div className="h-72 flex items-center justify-center">Loading charts…</div>}>
      <GatewayMetricsChartsCore {...props} />
    </Suspense>
  );
}
