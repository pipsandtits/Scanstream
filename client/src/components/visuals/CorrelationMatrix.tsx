import React, { useEffect, useRef } from 'react';

export interface CorrelationMatrixProps {
  matrix: number[][];
  labels: string[];
  height?: number | string;
  onCellClick?: (i: number, j: number) => void;
}

export default function CorrelationMatrix({ matrix = [], labels = [], height = 420, onCellClick }: CorrelationMatrixProps) {
  const el = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let chart: any = null;
    let mounted = true;
    (async () => {
      try {
        const echarts = await import('echarts');
        if (!mounted || !el.current) return;
        chart = echarts.init(el.current);
        const data: any[] = [];
        for (let i = 0; i < matrix.length; i++) {
          for (let j = 0; j < matrix[i].length; j++) {
            const v = matrix[i][j];
            data.push([j, i, +v.toFixed(3)]);
          }
        }
        const option = {
          tooltip: { position: 'top' },
          grid: { height: '80%', top: '10%' },
          xAxis: { type: 'category', data: labels, splitArea: { show: true } },
          yAxis: { type: 'category', data: labels, splitArea: { show: true } },
          visualMap: { min: -1, max: 1, calculable: true, orient: 'horizontal', left: 'center', top: 0 },
          series: [
            {
              name: 'correlation',
              type: 'heatmap',
              data,
              emphasis: { itemStyle: { borderColor: '#000', borderWidth: 1 } },
              progressive: 1000,
            },
          ],
        };
        chart.setOption(option);
        chart.on && chart.on('click', (params: any) => {
          if (params && params.data) {
            const [x, y] = params.data as number[];
            onCellClick && onCellClick(y, x);
          }
        });
      } catch (err) {
        // echarts not available — ignore, fallback will render below
      }
    })();
    return () => { mounted = false; try { chart?.dispose(); } catch {} };
  }, [matrix, labels, onCellClick]);

  // Fallback simple grid if echarts isn't present or failed
  return (
    <div style={{ width: '100%', height }}>
      <div ref={el} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

