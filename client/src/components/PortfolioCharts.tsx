import React, { Suspense } from 'react';

const LazyWinRate = React.lazy(() => import('./PortfolioChartsImpl').then(m => ({ default: m.WinRateChart })));
const LazyTradeDistribution = React.lazy(() => import('./PortfolioChartsImpl').then(m => ({ default: m.TradeDistributionChart })));
const LazySignalQuality = React.lazy(() => import('./PortfolioChartsImpl').then(m => ({ default: m.SignalQualityChart })));

export function WinRateChart(props: { data?: any[] }) {
  return (
    <Suspense fallback={<div className="h-96 bg-gray-50 rounded" />}>
      <LazyWinRate {...props} />
    </Suspense>
  );
}

export function TradeDistributionChart(props: { data?: any[] }) {
  return (
    <Suspense fallback={<div className="h-48 bg-gray-50 rounded" />}>
      <LazyTradeDistribution {...props} />
    </Suspense>
  );
}

export function SignalQualityChart(props: { data?: any[] }) {
  return (
    <Suspense fallback={<div className="h-96 bg-gray-50 rounded" />}>
      <LazySignalQuality {...props} />
    </Suspense>
  );
}

const defaultExport = {
  WinRateChart,
  TradeDistributionChart,
  SignalQualityChart,
};

export default defaultExport;
