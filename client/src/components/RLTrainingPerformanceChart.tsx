import React, { Suspense, lazy } from 'react';
import { useRLTrainingPerformance } from '@/lib/hooks';

const RLTrainingPerformanceChartImpl = lazy(() => import('./RLTrainingPerformanceChartImpl'));

export default function RLTrainingPerformanceChart(props: { data?: any[]; colors: any }) {
  const { data: incomingData, colors } = props;
  const q = useRLTrainingPerformance();
  const data = incomingData ?? q.data?.data ?? [];

  return (
    <div style={{ width: '100%', height: 300 }}>
      <Suspense fallback={<div style={{ height: 300 }} /> }>
        <RLTrainingPerformanceChartImpl data={data} colors={colors} />
      </Suspense>
      {q.isLoading && <div className="text-sm text-muted-foreground">Loading performance...</div>}
      {q.isError && <div className="text-sm text-destructive">Failed to load RL performance: {String((q.error as Error)?.message)}</div>}
    </div>
  );
}
