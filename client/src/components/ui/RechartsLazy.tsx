import React, { lazy, Suspense } from 'react';

const withSuspense = (LazyComp: React.LazyExoticComponent<any>, fallback: React.ReactNode = null) => (props: any) => (
  <Suspense fallback={fallback}>
    <LazyComp {...props} />
  </Suspense>
);

const SuspenseLoader = <div className="flex items-center justify-center p-2 text-sm text-slate-400">Loading chart...</div>;

export const ResponsiveContainer = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.ResponsiveContainer }))), SuspenseLoader);
export const LineChart = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.LineChart }))), SuspenseLoader);
export const BarChart = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.BarChart }))), SuspenseLoader);
export const AreaChart = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.AreaChart }))), SuspenseLoader);
export const ScatterChart = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.ScatterChart }))), SuspenseLoader);
export const PieChart = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.PieChart }))), SuspenseLoader);

export const Line = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.Line }))), null);
export const Bar = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.Bar }))), null);
export const Area = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.Area }))), null);
export const Scatter = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.Scatter }))), null);
export const Pie = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.Pie }))), null);
export const Cell = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.Cell }))), null);

export const XAxis = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.XAxis }))), null);
export const YAxis = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.YAxis }))), null);
export const Tooltip = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.Tooltip }))), null);
export const CartesianGrid = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.CartesianGrid }))), null);
export const Legend = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.Legend }))), null);
export const ReferenceLine = withSuspense(lazy(() => import('recharts').then(m => ({ default: m.ReferenceLine }))), null);

export default null;
