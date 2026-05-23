import React, { useEffect, useRef } from 'react';

type Cell = { exchange: string; symbol: string; depth: number };

export default function LiquidityHeatmap({ data = [], height = 420 }: { data?: Cell[]; height?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let chart: any = null;
    (async () => {
      try {
        const echarts = await import('echarts');
        if (disposed || !ref.current) return;
        chart = echarts.init(ref.current as HTMLDivElement);

        const exchanges = Array.from(new Set((data || []).map(d => d.exchange)));
        const symbols = Array.from(new Set((data || []).map(d => d.symbol)));
        const seriesData: [number, number, number][] = (data || []).map(d => [symbols.indexOf(d.symbol), exchanges.indexOf(d.exchange), d.depth]);

        const option = {
          tooltip: { position: 'top' },
          xAxis: { type: 'category', data: symbols, splitArea: { show: true } },
          yAxis: { type: 'category', data: exchanges, splitArea: { show: true } },
          visualMap: { min: 0, max: Math.max(...(data || []).map(d => d.depth), 1), orient: 'horizontal', left: 'center', bottom: 0 },
          series: [{ name: 'liquidity', type: 'heatmap', data: seriesData }]
        };

        chart.setOption(option);
      } catch (err) {
        // ignore
      }
    })();

    return () => { disposed = true; if (chart && chart.dispose) chart.dispose(); };
  }, [data]);

  return (
    <div style={{ height }}>
      <div ref={ref} style={{ width: '100%', height: '100%' }} />
      {(!data || data.length === 0) && <div className="text-sm text-slate-400">No liquidity data</div>}
    </div>
  );
}
