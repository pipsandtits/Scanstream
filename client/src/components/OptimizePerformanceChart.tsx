import React, { Suspense, lazy } from 'react';

const OptimizePerformanceChartCore = lazy(() => import('@/components/OptimizePerformanceChartCore'));

export default function OptimizePerformanceChart(props: { data?: any[] }) {
  return (
    <div style={{ width: '100%', height: 300 }}>
      <Suspense fallback={<div className="h-72 flex items-center justify-center">Loading chart…</div>}>
        <OptimizePerformanceChartCore {...props} />
      </Suspense>
    </div>
  );
}
