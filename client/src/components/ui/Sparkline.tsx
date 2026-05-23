import React from 'react';

export default function Sparkline({ values = [], width = 60, height = 20 }: { values?: number[]; width?: number; height?: number }) {
  const prices = values && values.length > 0 ? values : [];
  if (!prices || prices.length < 2) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const step = width / (prices.length - 1);
  const d = prices.map((p, i) => {
    const x = Math.round(i * step);
    const y = Math.round(height - ((p - min) / range) * height);
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  const stroke = prices[prices.length - 1] >= prices[0] ? '#34d399' : '#fb7185';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block align-middle">
      <path d={d} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />
    </svg>
  );
}
