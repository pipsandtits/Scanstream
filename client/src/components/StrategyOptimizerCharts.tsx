import React, { Suspense, lazy } from 'react';

const StrategyOptimizerChartsImpl = lazy(() => import('@/components/StrategyOptimizerChartsImpl'));

export default function StrategyOptimizerCharts(props: any) {
  return (
    <div style={{ width: '100%', height: 400 }}>
      <Suspense fallback={<div style={{ height: 400 }} />}>
        <StrategyOptimizerChartsImpl {...props} />
      </Suspense>
    </div>
  );
}
