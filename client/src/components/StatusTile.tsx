import React from 'react';

export default function StatusTile({
  label,
  status,
  metric,
  lastUpdated,
  href,
  title,
}: {
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'unknown';
  metric?: string | number | null;
  lastUpdated?: number | null;
  href?: string;
  title?: string;
}) {
  const bg = status === 'ok'
    ? 'bg-emerald-600/10 text-emerald-300 border border-emerald-600/20'
    : status === 'warn'
    ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
    : status === 'fail'
    ? 'bg-red-600/10 text-red-300 border border-red-600/20'
    : 'bg-slate-700/10 text-slate-300 border border-slate-700/20';

  return (
    <a href={href || '#'} title={title} className={`flex flex-col p-3 rounded ${bg} min-w-[160px]`}>
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-400 uppercase">{label}</div>
        <div className="text-xs text-slate-300">{metric ?? ''}</div>
      </div>
      <div className="text-xs text-slate-500 mt-2">{lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : 'n/a'}</div>
    </a>
  );
}
