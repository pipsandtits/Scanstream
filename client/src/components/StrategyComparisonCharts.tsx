import React, { Suspense, lazy } from 'react';

const StrategyComparisonChartsImpl = lazy(() => import('@/components/StrategyComparisonChartsImpl'));

export default function StrategyComparisonCharts(props: any) {
  return (
    <div style={{ width: '100%', height: 420 }}>
      <Suspense fallback={<div style={{ height: 420 }} />}>
        <StrategyComparisonChartsImpl {...props} />
      </Suspense>
    </div>
  );
}
