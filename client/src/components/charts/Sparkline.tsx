import React, { Suspense, lazy } from 'react';

const SparklineCore = lazy(() => import('@/components/charts/SparklineCore'));

export default function Sparkline(props: { data?: any[]; height?: number; color?: string }) {
  const { height = 40 } = props;
  return (
    <div style={{ width: '100%', height }}>
      <Suspense fallback={<div className="h-12" />}>
        <SparklineCore {...props} />
      </Suspense>
    </div>
  );
}
