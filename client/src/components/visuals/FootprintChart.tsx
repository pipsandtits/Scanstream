import React, { useEffect, useRef } from 'react';

export type FootprintCandle = {
  ts: number;
  open: number; high: number; low: number; close: number;
  footprint?: { price: number; bid: number; ask: number }[];
};

export default function FootprintChart({ candles = [], width = '100%', height = 220 }: { candles?: FootprintCandle[]; width?: number | string; height?: number | string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (typeof width === 'number') ? width : c.clientWidth;
    const h = (typeof height === 'number') ? height : c.clientHeight;
    c.width = Math.max(1, Math.floor(w * dpr));
    c.height = Math.max(1, Math.floor(h * dpr));
    ctx.scale(dpr, dpr);
    ctx.clearRect(0,0,w,h);

    if (!candles || candles.length === 0) return;
    const pad = 8;
    const innerW = w - pad*2;
    const candleW = Math.max(6, innerW / candles.length * 0.8);
    const prices = candles.flatMap(c => [c.high, c.low]);
    const maxP = Math.max(...prices);
    const minP = Math.min(...prices);
    const priceToY = (p: number) => pad + ( (maxP - p) / (maxP - minP || 1) ) * (h - pad*2);

    candles.forEach((candle, idx) => {
      const cx = pad + idx * (innerW / candles.length) + candleW/2;
      const yOpen = priceToY(candle.open);
      const yClose = priceToY(candle.close);
      const yHigh = priceToY(candle.high);
      const yLow = priceToY(candle.low);
      // wick
      ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, yHigh); ctx.lineTo(cx, yLow); ctx.stroke();
      // body
      const bullish = candle.close >= candle.open;
      ctx.fillStyle = bullish ? '#10b981' : '#ef4444';
      const by = Math.min(yOpen, yClose); const bh = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillRect(cx - candleW/2, by, candleW, bh);

      // footprint bars (bid/ask delta) if provided
      if (candle.footprint && candle.footprint.length) {
        const barMax = Math.max(...candle.footprint.map(f => Math.max(f.bid, f.ask)));
        candle.footprint.forEach((f, i) => {
          const py = priceToY(f.price);
          const bw = (f.bid / (barMax || 1)) * (candleW*1.2);
          const aw = (f.ask / (barMax || 1)) * (candleW*1.2);
          // bid (left)
          ctx.fillStyle = 'rgba(16,185,129,0.7)';
          ctx.fillRect(cx - candleW/2 - bw, py-2, bw, 4);
          // ask (right)
          ctx.fillStyle = 'rgba(239,68,68,0.7)';
          ctx.fillRect(cx + candleW/2, py-2, aw, 4);
        });
      }
    });
  }, [candles, width, height]);

  return (
    <div style={{ width, height }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
