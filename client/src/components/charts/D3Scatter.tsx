import React, { useRef, useEffect } from 'react';

interface Point { x: number; y: number }

export default function D3Scatter({ data, width = 600, height = 240 }: { data: Point[]; width?: number; height?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const d3 = await import('d3');
        if (!mounted || !ref.current) return;

        const svg = d3.select(ref.current).append('svg')
          .attr('width', width)
          .attr('height', height);

        const margin = { top: 10, right: 10, bottom: 30, left: 40 };
        const w = width - margin.left - margin.right;
        const h = height - margin.top - margin.bottom;

        const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

        const x = d3.scaleLinear().domain(d3.extent(data, d => d.x) as [number, number]).range([0, w]).nice();
        const y = d3.scaleLinear().domain(d3.extent(data, d => d.y) as [number, number]).range([h, 0]).nice();

        g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(6));
        g.append('g').call(d3.axisLeft(y).ticks(5));

        g.selectAll('circle').data(data).join('circle')
          .attr('cx', d => x(d.x))
          .attr('cy', d => y(d.y))
          .attr('r', 3.5)
          .attr('fill', '#3b82f6')
          .attr('opacity', 0.9);

        cleanup = () => svg.remove();
      } catch (err) {
        console.error('Failed to load d3 for D3Scatter', err);
      }
    })();

    return () => { mounted = false; if (cleanup) cleanup(); };
  }, [data, width, height]);

  return <div ref={ref} />;
}
