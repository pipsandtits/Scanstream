import React, { Suspense, lazy } from 'react';

const AreaChartCoreImpl = lazy(() => import('@/components/charts/AreaChartCoreImpl'));

export default function AreaChartCore(props: any) {
  const { height = 200 } = props;
  return (
    <div style={{ width: '100%', height }}>
      <Suspense fallback={<div style={{ height }} />}>
        <AreaChartCoreImpl {...props} />
      </Suspense>
    </div>
  );
}
