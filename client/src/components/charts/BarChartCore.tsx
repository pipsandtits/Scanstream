import React, { Suspense, lazy } from 'react';

const BarChartCoreImpl = lazy(() => import('@/components/charts/BarChartCoreImpl'));

export default function BarChartCore(props: any) {
  const { height = 300, barSeries } = props;
  return (
    <div style={{ width: '100%', height }}>
      <Suspense fallback={<div style={{ height }} />}>
        <BarChartCoreImpl {...props} barSeries={barSeries} />
      </Suspense>
    </div>
  );
}
 
