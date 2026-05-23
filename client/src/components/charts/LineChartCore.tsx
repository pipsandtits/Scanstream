import React, { Suspense, lazy } from 'react';

const LineChartCoreImpl = lazy(() => import('@/components/charts/LineChartCoreImpl'));

export default function LineChartCore(props: any) {
  const { height = 300 } = props;
  return (
    <div style={{ width: '100%', height }}>
      <Suspense fallback={<div style={{ height }} />}> 
        <LineChartCoreImpl {...props} />
      </Suspense>
    </div>
  );
}
