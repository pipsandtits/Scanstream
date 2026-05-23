import React, { Suspense, lazy } from 'react';

const ScatterChartCoreImpl = lazy(() => import('@/components/charts/ScatterChartCoreImpl'));

export default function ScatterChartCore(props: any) {
  const { height = 300 } = props;
  return (
    <div style={{ width: '100%', height }}>
      <Suspense fallback={<div style={{ height }} />}>
        <ScatterChartCoreImpl {...props} />
      </Suspense>
    </div>
  );
}
