import React, { Suspense, lazy } from 'react';

const AdvancedAnalyticsChartsImpl = lazy(() => import('@/components/AdvancedAnalyticsChartsImpl'));

export default function AdvancedAnalyticsCharts(props: { clusterData?: any; clusterColors?: string[]; colors?: any }) {
  return (
    <div style={{ width: '100%', height: 300 }}>
      <Suspense fallback={<div style={{ height: 300 }} />}>
        <AdvancedAnalyticsChartsImpl {...props} />
      </Suspense>
    </div>
  );
}
