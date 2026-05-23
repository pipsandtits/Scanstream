import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, X, Activity, Eye, TrendingUp, TrendingDown } from 'lucide-react';
import StatusTile from '@/components/StatusTile';
import { Sparkline, AgentPips, VoteBar } from './dashboardHelpers';

export default function OverviewView(props: any) {
  const {
    showAdminPanel, setShowAdminPanel, adminStatus,
    handleAdminSecretChange, showAdminSecret, adminSecret,
    clearKillMutation, metrics_dailyPnlPercent, metrics_exposurePercent,
    diagnostics, wsLastMessageAt, openPositions, avgConfidence,
    assets, selectedAssetData, setEntryAsset, setEntrySide, setShowEntryDialog,
    setSelectedAgentDetail, setShowAgentInspector, positionsLoading, positions,
    filteredAlerts, alertFilter, setAlertFilter, criticalCount,
    filteredAssets, setSelectedAsset, showWatchlist, setShowWatchlist,
    listFilter, setListFilter, searchQuery, setSearchQuery, openEntryFromAlert
  } = props;

  return (
    <>
      {/* Admin Panel (dev only) */}
      {import.meta.env.DEV && showAdminPanel && (
        <div className="bg-slate-800 border-b border-slate-700 px-4 py-3">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-amber-400">Admin Panel (dev)</h4>
              <div className="flex items-center gap-2">
                <button className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-300 bg-slate-900/20" onClick={() => window.open('/metrics', '_blank')}>Raw metrics</button>
                <button className="p-1 rounded border border-slate-700 text-slate-400" onClick={() => setShowAdminPanel(false)} title="Close admin panel" aria-label="Close admin panel"><X size={14} /></button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="border border-slate-700 rounded p-3 bg-slate-900/50">
                <div className="text-xs text-slate-400 mb-2 font-semibold">Admin Secret (Dev)</div>
                <div className="flex gap-2 mb-2">
                  <input
                    type={showAdminSecret ? 'text' : 'password'}
                    value={adminSecret}
                    onChange={(e) => handleAdminSecretChange(e.target.value)}
                    placeholder="Saved in localStorage"
                    className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 placeholder-slate-500"
                    aria-label="Admin secret"
                    title="Admin secret (dev)"
                  />
                </div>
                <div className="text-xs text-slate-500">Used for authenticated admin requests (dev only)</div>
              </div>

              <div className="border border-slate-700 rounded p-3 bg-slate-900/50">
                <div className="text-xs text-slate-400 mb-2 font-semibold">Kill Switch Status</div>
                {adminStatus?.kill ? (
                  <div className="space-y-2">
                    <div className={`text-sm font-semibold ${adminStatus.kill.killed ? 'text-red-400' : 'text-emerald-400'}`}>
                      {adminStatus.kill.killed ? '🔴 KILLED' : '🟢 ACTIVE'}
                    </div>
                    {adminStatus.kill.reason && <div className="text-xs text-slate-300">Reason: {adminStatus.kill.reason}</div>}
                    {adminStatus.kill.setBy && <div className="text-xs text-slate-400">By: {adminStatus.kill.setBy}</div>}
                    {adminStatus.kill.timestamp && <div className="text-xs text-slate-500">{new Date(adminStatus.kill.timestamp).toLocaleString()}</div>}
                    {adminStatus.kill.killed && (
                      <div className="pt-2">
                        <button
                          onClick={() => setShowAdminPanel(false)}
                          disabled={clearKillMutation.status === 'pending'}
                          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs px-2 py-1 rounded flex items-center justify-center gap-2"
                          title="Clear kill"
                          aria-label="Clear kill"
                        >
                          Clear Kill
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">No status available</div>
                )}
              </div>

              <div className="border border-slate-700 rounded p-3 bg-slate-900/50">
                <div className="text-xs text-slate-400 mb-2 font-semibold">Metrics Summary</div>
                <div className="space-y-2">
                  <div className={`text-sm font-semibold ${metrics_dailyPnlPercent != null && metrics_dailyPnlPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {metrics_dailyPnlPercent != null ? `${metrics_dailyPnlPercent >= 0 ? '+' : ''}${metrics_dailyPnlPercent.toFixed(2)}% (24h)` : 'n/a'}
                  </div>
                  <div className="text-xs text-slate-400">Exposure: {metrics_exposurePercent != null ? `${Math.round(metrics_exposurePercent)}%` : 'n/a'}</div>
                  <div className="text-xs text-slate-400">Raw metrics: <a href="/metrics" className="underline">/metrics</a></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-7 border-b border-slate-700 flex-shrink-0">
        {/* simplified KPI mapping */}
        <div className="px-4 py-3 border-r border-slate-700/40">
          <div className="text-xs tracking-widest text-slate-400 uppercase mb-1">Active Positions</div>
          <div className="text-xl font-semibold">{openPositions.length}</div>
          <div className="text-xs text-slate-500">Total open</div>
        </div>
        <div className="px-4 py-3 border-r border-slate-700/40">
          <div className="text-xs tracking-widest text-slate-400 uppercase mb-1">High Conviction</div>
          <div className="text-xl font-semibold text-emerald-400">{(assets || []).filter((a:any)=>a.buyAgents>=8).length}</div>
          <div className="text-xs text-slate-500">≥8 agents buy</div>
        </div>
        <div className="px-4 py-3 border-r border-slate-700/40">
          <div className="text-xs tracking-widest text-slate-400 uppercase mb-1">Avg Confidence</div>
          <div className="text-xl font-semibold text-cyan-300">{avgConfidence}%</div>
          <div className="text-xs text-slate-500">13-agent ensemble</div>
        </div>
        <div className="px-4 py-3 border-r border-slate-700/40">
          <div className="text-xs tracking-widest text-slate-400 uppercase mb-1">Integrity Gate</div>
          <div className="text-xl font-semibold">{diagnostics?.mode ? 'valid' : 'unknown'}</div>
          <div className="text-xs text-slate-500">gaps / rejects</div>
        </div>
        <div className="px-4 py-3 border-r border-slate-700/40">
          <div className="text-xs tracking-widest text-slate-400 uppercase mb-1">TruthEngine</div>
          <div className="text-xl font-semibold">{wsLastMessageAt ? 'fresh' : 'stale'}</div>
          <div className="text-xs text-slate-500">last tick</div>
        </div>
        <div className="px-4 py-3 border-r border-slate-700/40">
          <div className="text-xs tracking-widest text-slate-400 uppercase mb-1">Avg ML Conf</div>
          <div className="text-xl font-semibold text-cyan-300">{Math.round(((assets||[]).reduce((s:any,a:any)=>s+(a.avgConfidence||0),0))/Math.max(1,(assets||[]).length))}%</div>
          <div className="text-xs text-slate-500">model ensemble</div>
        </div>
        <div className="px-4 py-3">
          <div className="text-xs tracking-widest text-slate-400 uppercase mb-1">Regime</div>
          <div className="text-xl font-semibold text-emerald-400">{diagnostics?.mode || '—'}</div>
          <div className="text-xs text-slate-500">summary</div>
        </div>
      </div>

      {/* System status tiles */}
      <div className="px-4 py-3 border-b border-slate-700 bg-slate-900 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs tracking-widest text-slate-400 uppercase">System</div>
          <Link to="/metrics-dashboard" className="text-xs text-slate-400 underline">Metrics dashboard</Link>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <StatusTile label="WebSocket" status="unknown" metric="n/a" lastUpdated={null} href="/metrics-dashboard" title="Bridge health + execution stats" />
          <StatusTile label="Mode" status={diagnostics?.mode === 'LIVE' ? 'ok' : diagnostics?.mode ? 'warn' : 'unknown'} metric={diagnostics?.mode ?? 'n/a'} lastUpdated={null} href="/metrics-dashboard" title="Operation mode (LIVE / MIXED / REPLAY)" />
          <StatusTile label="Scanner" status="unknown" metric={''} lastUpdated={null} href="/metrics-dashboard" title="Scanner health and last scan" />
          <StatusTile label="Models (stale)" status={0 ? 'warn' : 'ok'} metric={0} lastUpdated={null} href="/metrics-dashboard" title="Models requiring retraining" />
        </div>
      </div>

      {/* Error banner */}
      {props.showError && (
        <div className="flex items-center gap-3 bg-red-900/40 text-red-200 px-4 py-2 border-b border-red-800/50 flex-shrink-0">
          <AlertTriangle size={13} />
          <span className="flex-1">{props.showError}</span>
          <button className="p-1 rounded border border-red-700 text-red-200" onClick={() => props.setShowError(null)} title="Dismiss error" aria-label="Dismiss error"><X size={12} /></button>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-y-auto px-4 py-3">
        {selectedAssetData ? (
          <>
            <div className="flex items-start justify-between border-b border-slate-700 pb-3">
              <div>
                <div className="flex items-baseline gap-2">
                  <div className="text-lg font-bold">{selectedAssetData.symbol}</div>
                  <div className="text-xs text-slate-400">13-agent consensus</div>
                </div>
                <div className="flex items-center gap-4 mt-1">
                  <div className="text-2xl font-semibold">${selectedAssetData.price.toFixed(2)}</div>
                  <div className={`text-sm ${selectedAssetData.priceChange > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {selectedAssetData.priceChange > 0 ? '+' : ''}{selectedAssetData.priceChange.toFixed(2)}% today
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button className="px-3 py-1 rounded border border-emerald-600 bg-emerald-600/10 text-emerald-300 flex items-center gap-2 text-sm" onClick={() => { setEntryAsset(selectedAssetData); setEntrySide('LONG'); setShowEntryDialog(true); }}>
                  <TrendingUp size={13} /> Long
                </button>
                <button className="px-3 py-1 rounded border border-red-600 bg-red-600/10 text-red-300 flex items-center gap-2 text-sm" onClick={() => { setEntryAsset(selectedAssetData); setEntrySide('SHORT'); setShowEntryDialog(true); }}>
                  <TrendingDown size={13} /> Short
                </button>
                <button className="px-2 py-1 rounded border border-slate-700 text-slate-300" title="Inspect asset" aria-label="Inspect asset"><Eye size={13} /></button>
              </div>
            </div>

            {/* Consensus strip and agent breakdown */}
            <div className="grid grid-cols-4 gap-3 mt-3">
              <div className="bg-slate-800 p-3 rounded border border-slate-700">
                <div className="text-xs text-slate-400 uppercase mb-1">Consensus</div>
                <div className="text-lg font-bold" style={{ color: selectedAssetData.consensusSignal === 'BUY' ? 'var(--q-green)' : selectedAssetData.consensusSignal === 'SELL' ? 'var(--q-red)' : 'var(--q-amber)' }}>
                  {selectedAssetData.consensusSignal}
                </div>
                <VoteBar buy={selectedAssetData.buyAgents} hold={selectedAssetData.holdAgents} sell={selectedAssetData.sellAgents} />
              </div>
              <div className="bg-slate-800 p-3 rounded border border-slate-700">
                <div className="text-xs text-slate-400 uppercase mb-1">Agent vote</div>
                <div className="text-lg font-bold">{selectedAssetData.buyAgents} <span className="text-xs text-slate-400">/ 13</span></div>
                <div className="text-xs text-slate-500">bullish · {selectedAssetData.holdAgents} hold · {selectedAssetData.sellAgents} sell</div>
              </div>
              <div className="bg-slate-800 p-3 rounded border border-slate-700">
                <div className="text-xs text-slate-400 uppercase mb-1">Avg confidence</div>
                <div className="text-lg font-bold text-cyan-300">{selectedAssetData.avgConfidence.toFixed(0)}%</div>
                <div className="text-xs text-slate-500">ensemble weighted</div>
              </div>
              <div className="bg-slate-800 p-3 rounded border border-slate-700">
                <div className="text-xs text-slate-400 uppercase mb-1">Risk score</div>
                <div className={`text-lg font-bold ${selectedAssetData.riskScore === 'LOW' ? 'text-emerald-400' : selectedAssetData.riskScore === 'HIGH' ? 'text-red-400' : 'text-amber-400'}`}>{selectedAssetData.riskScore}</div>
                <div className="text-xs text-slate-500">liquidity nominal</div>
              </div>
            </div>

            <div className="mt-4">
              <div className="text-xs text-slate-400 uppercase mb-2">13-agent breakdown — click any row to inspect</div>
              <div className="space-y-1.5">
                {selectedAssetData.signals.map((signal:any) => (
                  <div key={signal.agentName} className="flex items-center gap-3 p-3 bg-slate-800 rounded border border-slate-700 hover:bg-slate-800/60 cursor-pointer" onClick={() => { setSelectedAgentDetail(signal); setShowAgentInspector(true); }}>
                    <div className="w-28 flex-shrink-0">
                      <div className="font-semibold text-sm">{signal.agentName}</div>
                      <div className="text-xs text-slate-400">{signal.agentType}</div>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold flex-shrink-0 ${signal.signal === 'BUY' ? 'bg-emerald-600/10 text-emerald-300 border border-emerald-600/20' : signal.signal === 'SELL' ? 'bg-red-600/10 text-red-300 border border-red-600/20' : 'bg-amber-500/10 text-amber-300 border border-amber-500/20'}`}>{signal.signal} {signal.confidence.toFixed(0)}%</span>
                    <div className="flex-1 text-sm text-slate-300 truncate">{signal.insights.primary}</div>
                    <div className="w-28 flex-shrink-0">
                      <div className="w-full h-1.5 bg-slate-700 rounded overflow-hidden">
                        <div className="h-full rounded" style={{ width: `${signal.confidence}%`, background: signal.signal === 'BUY' ? 'var(--q-green)' : signal.signal === 'SELL' ? 'var(--q-red)' : 'var(--q-amber)' }} />
                      </div>
                      <div className="text-xs text-slate-400 mt-1">acc {(signal.accuracy * 100).toFixed(0)}%</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="p-8 text-center text-slate-400">Select an asset from the watchlist</div>
        )}
      </div>

      {/* Bottom section: positions + alerts */}
      <div className="grid md:grid-cols-[1fr_280px] gap-4 px-4 pb-4 flex-shrink-0">
        <div className="bg-slate-800 rounded border border-slate-700/40 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-900/30">
            <span className="text-xs tracking-widest text-slate-400 uppercase">Active positions</span>
            <span className="text-xs text-slate-400">paper trading mode</span>
          </div>
          {positionsLoading ? (
            <div className="p-5 text-center text-slate-400 text-sm">loading…</div>
          ) : openPositions.length === 0 ? (
            <div className="p-6 text-center text-slate-400">
              <Activity size={20} className="mx-auto mb-2 text-slate-500" />
              <div className="text-sm">No open trades — use Long entry or Short entry above</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400 uppercase bg-slate-900/30">
                  <tr>{['Symbol','Side','Entry','Current','Size','PnL','PnL%','Agent','Actions'].map(h => (<th key={h} className="px-3 py-2 text-left font-normal">{h}</th>))}</tr>
                </thead>
                <tbody>
                  {openPositions.map((position:any) => (
                    <tr key={position.id} className="border-t border-slate-700/50 hover:bg-slate-800/50">
                      <td className="px-3 py-2 font-semibold">{position.symbol}</td>
                      <td className={`px-3 py-2 font-semibold ${position.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{position.side}</td>
                      <td className="px-3 py-2">${position.entryPrice.toFixed(2)}</td>
                      <td className="px-3 py-2">${position.currentPrice.toFixed(2)}</td>
                      <td className="px-3 py-2">{position.size}</td>
                      <td className="px-3 py-2 font-semibold">${(position.pnl||0).toFixed(2)}</td>
                      <td className="px-3 py-2 font-semibold">{(position.pnlPercent||0).toFixed(2)}%</td>
                      <td className="px-3 py-2"><span className="px-2 py-0.5 rounded text-xs font-semibold bg-slate-700/50 text-slate-200">{position.agentSignal||'N/A'}</span></td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2">
                          <button className="text-xs px-2 py-1 rounded border border-red-700 text-red-300 hover:bg-red-900/20" onClick={() => alert('Close position: ' + position.symbol)}>Close</button>
                          <button className="text-xs px-2 py-1 rounded border border-teal-700 text-teal-300 hover:bg-teal-900/20" onClick={() => alert('Edit SL/TP: ' + position.symbol)}>Edit</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-slate-800 rounded border border-slate-700/40 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-900/30 flex-shrink-0">
            <span className="text-xs tracking-widest text-slate-400 uppercase">Alerts</span>
            {criticalCount > 0 && (<span className="text-xs text-red-400">{criticalCount} critical</span>)}
          </div>
          <div className="px-3 py-2 border-b border-slate-700 flex flex-wrap gap-1 flex-shrink-0">
            {(['ALL', 'HIGH_CONVICTION', 'ENTRY_READY', 'LIQUIDITY_WARNING', 'DIVERGENCE'] as const).map((f:any) => (
              <button key={f} className={`text-xs px-2 py-1 rounded ${alertFilter === f ? 'border border-teal-400 text-teal-300 bg-teal-400/10' : 'text-slate-400 border border-transparent'}`} onClick={() => setAlertFilter(f)}>
                {f === 'ALL' ? 'All' : f === 'HIGH_CONVICTION' ? 'Conviction' : f === 'ENTRY_READY' ? 'Entry' : f === 'LIQUIDITY_WARNING' ? 'Liquidity' : 'Divergence'}
              </button>
            ))}
          </div>
          <div className="overflow-y-auto max-h-80">
            {filteredAlerts.length === 0 ? (
              <div className="p-4 text-center text-slate-400 text-sm">No alerts matching filter</div>
            ) : filteredAlerts.map((alert:any) => (
              <div key={alert.id} className={`px-3 py-3 border-b border-slate-700/50 border-l-4 ${alert.severity==='CRITICAL' ? 'bg-red-900/20 border-l-red-500' : alert.severity==='WARNING' ? 'bg-amber-900/10 border-l-amber-400' : 'bg-slate-800/40 border-l-slate-700'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-slate-100 text-sm">{alert.symbol}</span>
                  <span className="text-xs text-slate-400">{alert.type.replace(/_/g,' ')}</span>
                </div>
                <div className="text-sm text-slate-300 mb-2">{alert.message}</div>
                {alert.actionable && (<button className="text-xs px-2 py-1 rounded border border-teal-600 text-teal-300 hover:bg-teal-900/20" onClick={() => openEntryFromAlert(alert)}>Execute ↗</button>)}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Watchlist panel */}
      <div className={`fixed top-12 right-4 z-40 w-80 h-[80vh] transition-transform duration-200 ${showWatchlist ? 'translate-x-0' : 'translate-x-[calc(100%+2rem)]'}`}>
        <div className="h-full bg-slate-800 rounded border border-slate-700/40 overflow-hidden shadow-xl flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 flex-shrink-0">
            <span className="text-xs tracking-widest text-slate-400 uppercase">Watchlist</span>
            <div className="flex gap-1">
              {(['top-volume', 'top-confidence', 'high-conviction'] as const).map((f:any) => (
                <button key={f} className={`text-xs px-2 py-1 rounded ${listFilter === f ? 'border border-teal-400 text-teal-300 bg-teal-400/10' : 'text-slate-400 border border-transparent hover:border-slate-600'}`} onClick={() => setListFilter(f)}>
                  {f === 'top-volume' ? 'vol' : f === 'top-confidence' ? 'conf' : 'conv'}
                </button>
              ))}
              <button className="text-xs px-2 py-1 rounded text-slate-400 border border-transparent hover:border-slate-600" onClick={() => setShowWatchlist(false)}>✕</button>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700 flex-shrink-0">
            <div className="text-slate-400">🔎</div>
            <input className="flex-1 bg-transparent outline-none text-sm text-slate-100 placeholder-slate-500" placeholder="symbol…" aria-label="Search watchlist symbol" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>
          <div className="grid grid-cols-4 px-3 py-1.5 border-b border-slate-700 text-xs text-slate-400 uppercase flex-shrink-0">
            <div>Symbol</div>
            <div className="text-right">Price</div>
            <div className="text-center">Sig</div>
            <div className="text-right">Agents</div>
          </div>
          <div className="overflow-y-auto flex-1">
            {filteredAssets.map((asset:any) => (
              <div key={asset.symbol} className={`grid grid-cols-4 items-center px-3 py-2 border-b border-slate-700/50 cursor-pointer hover:bg-slate-700/30`} onClick={() => { setSelectedAsset(asset.symbol); setShowWatchlist(false); }}>
                <div>
                  <div className="font-semibold text-sm text-slate-100">{asset.symbol}</div>
                  <div className={`text-xs ${asset.priceChange > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{asset.priceChange > 0 ? '+' : ''}{asset.priceChange.toFixed(2)}%</div>
                  <div className="mt-1"><Sparkline asset={asset} /></div>
                </div>
                <div className="text-sm text-slate-100 text-right">${asset.price >= 1000 ? (asset.price/1000).toFixed(1)+'k' : asset.price.toFixed(2)}</div>
                <div className="text-center"><span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${asset.consensusSignal === 'BUY' ? 'bg-emerald-600/10 text-emerald-300 border border-emerald-600/20' : asset.consensusSignal === 'SELL' ? 'bg-red-600/10 text-red-300 border border-red-600/20' : 'bg-amber-500/10 text-amber-300 border border-amber-500/20'}`}>{asset.consensusSignal}</span></div>
                <div className="flex justify-end"><AgentPips buy={asset.buyAgents} hold={asset.holdAgents} sell={asset.sellAgents} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
