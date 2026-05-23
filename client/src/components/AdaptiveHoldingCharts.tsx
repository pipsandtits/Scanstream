import React, { Suspense, lazy } from 'react';

const AdaptiveHoldingChartsImpl = lazy(() => import('@/components/AdaptiveHoldingChartsImpl'));

export default function AdaptiveHoldingCharts(props: { holdingProfile?: any }) {
  return (
    <div style={{ width: '100%' }}>
      <Suspense fallback={<div style={{ height: 300 }} />}>
        <AdaptiveHoldingChartsImpl {...props} />
      </Suspense>
    </div>
  );
}
