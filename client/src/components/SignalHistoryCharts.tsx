import React, { Suspense, lazy } from 'react';

const SignalHistoryChartsImpl = lazy(() => import('@/components/SignalHistoryChartsImpl'));

export default function SignalHistoryCharts(props: any) {
  return (
    <div style={{ width: '100%', height: 280 }}>
      <Suspense fallback={<div style={{ height: 280 }} />}>
        <SignalHistoryChartsImpl {...props} />
      </Suspense>
    </div>
  );
}
