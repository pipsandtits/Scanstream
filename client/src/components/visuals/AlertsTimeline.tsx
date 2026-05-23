import React from 'react';

export type AlertEvent = { id?: string | number; ts: number; type: string; level?: 'info' | 'warning' | 'error' | 'signal'; message: string };

export default function AlertsTimeline({ events = [], onEventClick }: { events?: AlertEvent[]; onEventClick?: (e: AlertEvent) => void }) {
  const sorted = (events || []).slice().sort((a,b)=>a.ts - b.ts);
  return (
    <div className="space-y-2">
      {sorted.map(e => (
        <div key={e.id ?? `${e.ts}-${e.type}`} className="flex items-start gap-3 p-2 rounded-lg hover:bg-slate-800/30 cursor-pointer" onClick={()=>onEventClick && onEventClick(e)}>
          <div className="w-10 text-xs text-slate-400">{new Date(e.ts).toLocaleTimeString()}</div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-white">{e.type}</div>
              <div className={`text-xs ${e.level === 'error' ? 'text-red-400' : e.level === 'warning' ? 'text-orange-400' : 'text-slate-400'}`}>{e.level || 'info'}</div>
            </div>
            <div className="text-sm text-slate-300">{e.message}</div>
          </div>
        </div>
      ))}
      {sorted.length === 0 && <div className="text-sm text-slate-400 p-3">No alerts</div>}
    </div>
  );
}
