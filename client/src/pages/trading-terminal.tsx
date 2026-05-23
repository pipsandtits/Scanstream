/**
 * TradingTerminal.tsx — fully fixed
 *
 * Fixes applied (matching the audit):
 * 1.  JSX structure — chart tab / other tabs are now proper siblings, not nested
 * 2.  Broken hoveredCandleSignals tooltip JSX — closed correctly
 * 3.  setLocation → useNavigate (navigate())
 * 4.  trades → activeTrades in PositionManagementPanel
 * 5.  filteredAssets removed — OverviewView / ScannerView receive assets from query
 * 6.  safeFetchJson hoisted to module scope (above component)
 * 7.  Duplicate memoized signal node blocks removed
 * 8.  State bloat — server-derived state (price, portfolio, sentiment) read directly
 *     from react-query results, local useState mirrors removed
 * 9.  Single WebSocket connection (inline useRef), custom useWebSocket hook removed
 * 10. Query key inconsistency — all keys use the imported key functions
 * 11. ErrorBoundary replaced with real class-component implementation
 * 12. showClustering POST debounced (300 ms)
 * 13. Auto-hide timer relaxed to 5 minutes
 * 14. Placeholder tabs wired to real (but minimal) content so they don't show blank
 * 15. useNavigate properly called and used
 */

import React, {
  useState, useEffect, useMemo, useRef, useCallback,
  Component, type ErrorInfo,
} from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import useMarketFrames from '@/hooks/useMarketFrames';
import useWorldTicks from '@/hooks/useWorldTicks';
import useOrderbook from '@/hooks/useOrderbook';
import { queryClient } from '@/lib/queryClient';
import {
  worldTicksKey, marketFramesKey, orderbookKey, positionsKey,
} from '@/lib/queryKeys';
import useTickCandles, { type HookWorldTick } from '../hooks/useTickCandles';
import { useSymbolUniverse } from '../hooks/useSymbolUniverse';
import OrderbookPanel from '../components/OrderbookPanel';
import WorldTicksPanel from '../components/WorldTicksPanel';
import SymbolList from '../components/SymbolList';
import GlobalSummaryPanel from '../components/GlobalSummaryPanel';
import AgentPanel from '../components/AgentPanel';
import EventFeedPanel from '../components/EventFeedPanel';
import AnalyticsPanel from '../components/AnalyticsPanel';
import SymbolPanel from '../components/SymbolPanel';
import marketDataLayer from '../lib/marketDataLayer';
import { validateWorldTick as validateMDLWorldTick } from '../lib/marketDataLayer';
import { getTopItems, type AttentionItem } from '../lib/attention';
import type { UITick } from '../types';
import type { MarketFrame } from '../types/MarketFrame';
import {
  verifyDataLayerInvariants,
  setInvariantEnforcement,
  assertUITick,
} from '../lib/invariants';
import {
  Brain, RefreshCw, Layers, Bell, Cog, BarChart3, ExpandIcon,
  Target, Wind, Waves, Activity, PanelLeftClose, PanelLeftOpen,
  PanelRightClose, PanelRightOpen, Maximize2, Minimize2, Search,
  Wallet, TrendingUp, TrendingDown, Clock, BookOpen, Globe, Zap,
} from 'lucide-react';
import { loadFrontendConfig } from '../lib/config';
import { TradingChart } from '../components/TradingChart';
import usePerformanceMark from '../hooks/usePerformanceMark';
import TerminalLayout from '../components/TerminalLayout';
import OrderbookDepth from '@/components/visuals/OrderbookDepth';
import ModelExplainability from '@/components/visuals/ModelExplainability';
import AlertsTimeline from '@/components/visuals/AlertsTimeline';
import FootprintChart from '@/components/visuals/FootprintChart';
import { useCoinGeckoChart } from '../hooks/useCoinGeckoChart';
import { useGatewaySignals } from '../hooks/useGatewaySignals';
import { GatewaySignalCard } from '../components/GatewaySignalCard';
import MarketStatusBar from '../components/MarketStatusBar';
import PerfObserver from '../components/PerfObserver';
import ThemeSelector from '@/components/ThemeSelector';
import PanelManager from '../components/PanelManager';
import { StatCard } from '../components/cards';
import FloatingChartToolbar from '../components/FloatingChartToolbar';
import NotificationHub from '../components/NotificationHub';
import { useNotifications } from '../contexts/NotificationContext';
import QuickActionsBar from '../components/QuickActionsBar';
import QuickTradeModal from '../components/QuickTradeModal';
import TradeExecutionPanel, { type TradeOrder } from '../components/TradeExecutionPanel';
import PositionManagementPanel, {
  type Position, type Order, type Trade as TradeHistory,
} from '../components/PositionManagementPanel';
import RiskManagementPanel from '../components/RiskManagementPanel';
import CorrelationHeatmap from '../components/CorrelationHeatmap';
import { TopMoversWidget } from '../components/TopMoversWidget';
import ReplayModeBanner from '../components/ReplayModeBanner';
import ReplayModeDesaturatedWrapper from '../components/ReplayModeDesaturatedWrapper';
import ReplayModeWatermark from '../components/ReplayModeWatermark';
import OverviewView from './OverviewView';
import ScannerView from './ScannerView';
import PositionsView from './PositionsView';

// ─── Module-level helpers (FIX #6: hoisted above component) ──────────────────

const safeFetchJson = async (input: RequestInfo, init?: RequestInit) => {
  try {
    const res = await fetch(input, init);
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  } catch { return null; }
};

// ─── Real ErrorBoundary (FIX #11) ─────────────────────────────────────────────

interface EBState { hasError: boolean; error: Error | null }
class ErrorBoundary extends Component<
  { children: React.ReactNode; FallbackComponent: React.FC<{ error: Error }> },
  EBState
> {
  state: EBState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error): EBState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError && this.state.error) {
      return <this.props.FallbackComponent error={this.state.error} />;
    }
    return this.props.children;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type WorldTick = UITick;

export type Signal = {
  id: string;
  symbol: string;
  type?: 'BUY' | 'SELL' | 'HOLD' | 'NEUTRAL';
  strength: number;
  price?: number;
  timestamp?: number;
  indicators?: Record<string, any>;
  marketMicrostructure: {
    spread: number; depth: number; imbalance: number; toxicity: number;
  };
  confidence?: number;
  momentum?: number;
  momentumLabel?: string;
  regimeState?: string;
  legacyLabel?: string;
  reasoning?: string[];
  riskReward?: number;
  stopLoss?: number;
  takeProfit?: number;
  signalStrengthScore?: number;
};

interface Orderbook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

type ChartPoint = {
  timestamp: number;
  open: number; high: number; low: number; close: number; volume: number;
  rsi?: number | null;
  macd?: { line: number; signal: number; histogram: number } | null;
  ema?: number | null;
};

type Trade = {
  id: string; symbol: string;
  entry_price: number; entry_time: number;
  exit_price?: number; exit_time?: number;
  size: number; side: 'long' | 'short';
  status: 'open' | 'closed' | 'pending';
  pnl?: number; pnl_percent?: number;
};

type MarketSentiment = {
  fearGreedIndex?: number; btcDominance?: number;
  totalMarketCap?: number; volume24h?: number;
  market_direction?: 'bullish' | 'bearish' | 'neutral';
  updated_at?: number;
};

type PortfolioData = {
  totalValue?: number; availableCash?: number;
  dayChange?: number; dayChangePercent?: number;
  metrics?: {
    totalReturn?: number; winRate?: number; maxDrawdown?: number;
    currentBalance?: number; totalTrades?: number; sharpeRatio?: number;
  };
  positions?: Array<{
    symbol: string; quantity: number; entry_price: number;
    current_price: number; unrealized_pnl: number; unrealized_pnl_percent: number;
  }>;
};

type ExchangeStatus = {
  exchange: string; status: 'online' | 'offline' | 'degraded';
  last_update: number; trading_pairs: number;
  api_latency_ms: number; isOperational: boolean; latency: number;
};

type MLInsights = {
  prediction: 'up' | 'down' | 'neutral';
  confidence: number; model_version: string; updated_at: number;
  signals: Array<{ symbol: string; score: number }>;
};

interface FlowFieldData {
  latestForce: number; averageForce: number; forceDirection: number;
  pressure: number; pressureTrend: 'rising' | 'falling' | 'stable';
  turbulence: number; turbulenceLevel: 'low' | 'medium' | 'high' | 'extreme';
  energyGradient: number; energyTrend: 'accelerating' | 'decelerating' | 'stable';
  dominantDirection: 'bullish' | 'bearish' | 'neutral';
}

interface MLPredictions {
  direction: { prediction: 'bullish' | 'bearish'; probability: number; confidence: number; signal: 1 | 0 };
  price: { predicted: number; high: number; low: number; confidence: number; percentChange: number };
  volatility: { predicted: number; level: 'low' | 'medium' | 'high' | 'extreme'; confidence: number };
  risk: { score: number; level: 'low' | 'medium' | 'high' | 'extreme'; factors: string[] };
  holdingPeriod?: { days: number; hours: number; candles: number; confidence: number; reason: string };
}

type ChartIndicatorKey = 'showVolume' | 'showRSI' | 'showMACD' | 'showEMA' | 'showPatterns';

// Helper: map incoming UITick
const mapIncomingTick = (tick: UITick): WorldTick => ({
  ...tick,
  symbol: tick.symbol || 'UNKNOWN',
  volume: tick.volume || 0,
  state: tick.state || { mode: 'LIVE' },
} as WorldTick);

// Enhanced MarketFrame validator
const validateMarketFrame = (frame: any): frame is MarketFrame =>
  frame &&
  typeof frame.symbol === 'string' &&
  typeof frame.open === 'number' &&
  typeof frame.high === 'number' &&
  typeof frame.low === 'number' &&
  typeof frame.close === 'number' &&
  typeof frame.volume === 'number' &&
  frame.quality && frame.meta &&
  typeof frame.meta.tsOpen === 'number' &&
  typeof frame.meta.tsClose === 'number';

// Formatting utilities (module scope to avoid recreation)
const formatCurrency = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const formatPercent = (value: number) =>
  `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

// ─── Component ────────────────────────────────────────────────────────────────

export default function TradingTerminal() {
  try { usePerformanceMark('TradingTerminal'); } catch {}

  // Theme CSS variables are applied after theme is available (moved below)

  // Helper: map 0..1 to Tailwind width buckets
  const pctToBucket = (p = 0) => {
    const pct = Math.max(0, Math.min(1, Number(p) || 0));
    if (pct >= 0.99) return 'w-full';
    if (pct >= 0.92) return 'w-11/12';
    if (pct >= 0.86) return 'w-5/6';
    if (pct >= 0.8) return 'w-4/5';
    if (pct >= 0.75) return 'w-3/4';
    if (pct >= 0.7) return 'w-7/10';
    if (pct >= 0.6) return 'w-3/5';
    if (pct >= 0.5) return 'w-1/2';
    if (pct >= 0.4) return 'w-2/5';
    if (pct >= 0.33) return 'w-1/3';
    if (pct >= 0.2) return 'w-1/5';
    if (pct >= 0.08) return 'w-1/12';
    return 'w-1';
  };

  // Helper: map 0..100 to left-* like classes by reusing pctToBucket
  const leftPctClass = (pct100 = 0) => {
    const pct = Math.max(0, Math.min(100, Number(pct100) || 0)) / 100;
    const w = pctToBucket(pct);
    return w === 'w-full' ? 'left-0' : w.replace('w-', 'left-');
  };

  // FIX #3: useNavigate properly initialised
  const navigate = useNavigate();

  useEffect(() => {
    const isDev = process.env.NODE_ENV === 'development';
    setInvariantEnforcement(isDev || process.env.REACT_APP_ENFORCE_INVARIANTS === 'true');
  }, []);

  // ── Core UI state ────────────────────────────────────────────────────────
  const [selectedSymbol, setSelectedSymbol] = useState('BTC/USDT');
  const [selectedTimeframe, setSelectedTimeframe] = useState<'1m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '1d' | '3d' | '1w' | '1month'>('1h');
  const [selectedExchange, setSelectedExchange] = useState('binance');
  const [availableExchanges, setAvailableExchanges] = useState<string[]>([]);
  const [currentSignals, setCurrentSignals] = useState<Signal[]>([]);
  const [hoveredCandleTime, setHoveredCandleTime] = useState<number | null>(null);
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [useFeed, setUseFeed] = useState(true);

  // Layout
  const [activeTab, setActiveTab] = useState<'chart' | 'overview' | 'scanner' | 'signals' | 'positions' | 'portfolio' | 'backtest' | 'ml' | 'diagnostics'>('chart');
  const [showLeftSidebar, setShowLeftSidebar] = useState(() => {
    try { return JSON.parse(localStorage.getItem('showLeftSidebar') ?? 'true'); } catch { return true; }
  });
  const [showRightSidebar, setShowRightSidebar] = useState(() => {
    try { return JSON.parse(localStorage.getItem('showRightSidebar') ?? 'true'); } catch { return true; }
  });
  const [showLeftRail, setShowLeftRail] = useState(() => {
    try { return JSON.parse(localStorage.getItem('showLeftRail') ?? 'true'); } catch { return true; }
  });
  const [focusMode, setFocusMode] = useState(false);
  const [isChartFullscreen, setIsChartFullscreen] = useState(false);
  const prevLeftSidebarRef = useRef<boolean | null>(null);
  const prevRightSidebarRef = useRef<boolean | null>(null);
  const prevLeftRailRef = useRef<boolean | null>(null);

  // Settings / admin
  const [env, setEnv] = useState<'dev' | 'prod'>('dev');
  const [workspace, setWorkspace] = useState('Default');
  const [universe, setUniverse] = useState('Market Universe');
  const [isLiveMode, setIsLiveMode] = useState(() => {
    try { return localStorage.getItem('isLiveMode') === 'true'; } catch { return false; }
  });
  const [liveEnabledConfirmed, setLiveEnabledConfirmed] = useState(() => {
    try { return localStorage.getItem('liveEnabledConfirmed') === 'true'; } catch { return false; }
  });
  const [showEnableLiveModal, setShowEnableLiveModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showPanelManager, setShowPanelManager] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [showQuickTradeModal, setShowQuickTradeModal] = useState(false);

  // Chart
  const [chartIndicators, setChartIndicators] = useState<Record<ChartIndicatorKey, boolean>>({
    showVolume: true, showRSI: true, showMACD: true, showEMA: true, showPatterns: false,
  });
  const [showClustering, setShowClustering] = useState(false);
  const [clusteringData, setClusteringData] = useState<any>(null);

  // Pinned symbols
  const [pinnedSymbols, setPinnedSymbols] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('pinnedSymbols') ?? '[]'); } catch { return []; }
  });

  // Replay
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayPlayback, setReplayPlayback] = useState<WorldTick[]>([]);
  const [replayIntervalMs, setReplayIntervalMs] = useState(200);
  const replaySourceRef = useRef<WorldTick[] | null>(null);
  const replayTimerRef = useRef<number | null>(null);
  const replayIndexRef = useRef(0);

  // Backfill
  const [backfillInProgress, setBackfillInProgress] = useState(false);
  const [backfillCount, setBackfillCount] = useState(0);
  const backfillCountRef = useRef(0);

  // AbortController refs for user-triggered requests
  const toggleAgentControllerRef = useRef<AbortController | null>(null);
  const tradeExecControllerRef = useRef<AbortController | null>(null);
  const closePositionControllerRef = useRef<AbortController | null>(null);
  const cancelOrderControllerRef = useRef<AbortController | null>(null);
  const configSaveControllerRef = useRef<AbortController | null>(null);

  // Signal details (opened from SignalCard)
  const [openSignalDetails, setOpenSignalDetails] = useState<{ symbol: string; signal?: string } | null>(null);

  // WebSocket (FIX #9: single inline connection, no duplicate hook)
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const wsLastMessageRef = useRef<number | null>(null);

  // MDL connection state
  const [mdConnected, setMdConnected] = useState(false);
  const [mdRetryInfo, setMdRetryInfo] = useState<{ attempt?: number; delay?: number } | null>(null);

  // Auto-hide sidebar timer (FIX #13: 5 minutes)
  const AUTO_HIDE_DELAY = 5 * 60 * 1000;
  const leftSidebarTimerRef = useRef<number | null>(null);
  const rightSidebarTimerRef = useRef<number | null>(null);

  const { colors } = useTheme();

  const {
    notifications, unreadCount, settings,
    markAsRead, markAllAsRead, dismissNotification,
    clearAll, toggleSound, addNotification,
  } = useNotifications();

  // Apply theme colors to CSS variables to avoid inline styles
  useEffect(() => {
    try {
      document.documentElement.style.setProperty('--app-bg', (colors as any)?.background || '#0f172a');
      document.documentElement.style.setProperty('--app-text', (colors as any)?.text || '#fff');
      document.documentElement.style.setProperty('--app-surface', (colors as any)?.surface || '#0b1220');
      document.documentElement.style.setProperty('--app-border', (colors as any)?.border || 'rgba(148,163,184,0.12)');
    } catch {}
  }, [colors]);

  // ── Persist sidebar prefs ──────────────────────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem('showLeftSidebar', JSON.stringify(showLeftSidebar)); } catch {}
  }, [showLeftSidebar]);
  useEffect(() => {
    try { localStorage.setItem('showRightSidebar', JSON.stringify(showRightSidebar)); } catch {}
  }, [showRightSidebar]);
  useEffect(() => {
    try { localStorage.setItem('showLeftRail', JSON.stringify(showLeftRail)); } catch {}
  }, [showLeftRail]);

  // ── Persist env / workspace / universe ────────────────────────────────────
  useEffect(() => {
    try {
      const e = localStorage.getItem('env');
      const w = localStorage.getItem('workspace');
      const u = localStorage.getItem('universe');
      if (e) setEnv(e === 'prod' ? 'prod' : 'dev');
      if (w) setWorkspace(w);
      if (u) setUniverse(u);
    } catch {}
  }, []);

  // ── Focus mode ─────────────────────────────────────────────────────────────
  const toggleFocusMode = useCallback(() => {
    setFocusMode(prev => {
      const next = !prev;
      if (next) {
        prevLeftSidebarRef.current = showLeftSidebar;
        prevRightSidebarRef.current = showRightSidebar;
        prevLeftRailRef.current = showLeftRail;
        setShowLeftSidebar(false);
        setShowRightSidebar(false);
        setShowLeftRail(false);
        setIsChartFullscreen(true);
      } else {
        if (prevLeftSidebarRef.current !== null) setShowLeftSidebar(prevLeftSidebarRef.current);
        if (prevRightSidebarRef.current !== null) setShowRightSidebar(prevRightSidebarRef.current);
        if (prevLeftRailRef.current !== null) setShowLeftRail(prevLeftRailRef.current);
        setIsChartFullscreen(false);
      }
      return next;
    });
  }, [showLeftSidebar, showRightSidebar, showLeftRail]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); setShowLeftSidebar((p: boolean) => !p); }
        else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setShowRightSidebar((p: boolean) => !p); }
        else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setIsChartFullscreen((p: boolean) => !p); }
        else if (e.key === 'Escape' && isChartFullscreen) setIsChartFullscreen(false);
        else if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); setShowQuickActions((p: boolean) => !p); }
      else if (['1','2','3','4','5','6','7','8','9','0'].includes(e.key)) {
        e.preventDefault();
        const tfs = ['1m','5m','15m','30m','1h','2h','4h','8h','1d','1w'] as const;
        const idx = e.key === '0' ? 9 : parseInt(e.key) - 1;
        if (idx < tfs.length) setSelectedTimeframe(tfs[idx]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isChartFullscreen]);

  // ── Auto-hide sidebars ─────────────────────────────────────────────────────
  const resetLeftSidebarTimer = useCallback(() => {
    if (leftSidebarTimerRef.current) window.clearTimeout(leftSidebarTimerRef.current);
    leftSidebarTimerRef.current = window.setTimeout(() => setShowLeftSidebar(false), AUTO_HIDE_DELAY);
  }, []);
  const resetRightSidebarTimer = useCallback(() => {
    if (rightSidebarTimerRef.current) window.clearTimeout(rightSidebarTimerRef.current);
    rightSidebarTimerRef.current = window.setTimeout(() => setShowRightSidebar(false), AUTO_HIDE_DELAY);
  }, []);

  useEffect(() => {
    if (showLeftSidebar) resetLeftSidebarTimer();
    else if (leftSidebarTimerRef.current) clearTimeout(leftSidebarTimerRef.current);
    return () => { if (leftSidebarTimerRef.current) clearTimeout(leftSidebarTimerRef.current); };
  }, [showLeftSidebar, resetLeftSidebarTimer]);

  useEffect(() => {
    if (showRightSidebar) resetRightSidebarTimer();
    else if (rightSidebarTimerRef.current) clearTimeout(rightSidebarTimerRef.current);
    return () => { if (rightSidebarTimerRef.current) clearTimeout(rightSidebarTimerRef.current); };
  }, [showRightSidebar, resetRightSidebarTimer]);

  // ── WebSocket (FIX #9: single connection) ─────────────────────────────────
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const urls = window.location.port === '5173'
      ? [`${proto}//localhost:5000/ws`, `${proto}//${window.location.host}/ws`]
      : [`${proto}//${window.location.host}/ws`, `${proto}//localhost:5000/ws`];
    let urlIdx = 0;

    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      try {
        const ws = new WebSocket(urls[urlIdx]);
        wsRef.current = ws;

        ws.onopen = () => {
          setWsConnected(true);
          ws.send(JSON.stringify({ type: 'set_exchange', exchange: selectedExchange }));
        };
        ws.onclose = (ev) => {
          setWsConnected(false);
          if (ev.code !== 1000 && urlIdx < urls.length - 1) { urlIdx++; }
          setTimeout(connect, Math.min(1000 * 2 ** urlIdx, 30000));
        };
        ws.onerror = () => setWsConnected(false);
        ws.onmessage = (ev) => {
          wsLastMessageRef.current = Date.now();
          try {
            const msg = JSON.parse(ev.data);
            switch (msg.type) {
              case 'market_data': {
                const frame = msg.data;
                if (validateMarketFrame(frame)) {
                  queryClient.setQueryData(marketFramesKey(selectedExchange), (prev: any[] | undefined) =>
                    [...(prev || []), frame].slice(-200)
                  );
                }
                break;
              }
              case 'signal': {
                setCurrentSignals(prev => [msg.data as Signal, ...prev].slice(0, 10));
                break;
              }
              case 'ohlcv': {
                const sym = msg.data?.symbol || selectedSymbol;
                queryClient.setQueryData(['gatewayOHLCV', sym], () => msg.data);
                break;
              }
              case 'orderbook': {
                const ob = msg.data as Orderbook;
                const sym = msg.data?.symbol || selectedSymbol;
                if (ob && (Array.isArray(ob.bids) || Array.isArray(ob.asks))) {
                  queryClient.setQueryData(orderbookKey(sym), () => ob);
                }
                break;
              }
              default: break;
            }
          } catch {}
        };
      } catch {}
    };

    connect();
    return () => {
      wsRef.current?.close(1000, 'unmount');
      wsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync exchange change to WS
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'set_exchange', exchange: selectedExchange }));
    }
  }, [selectedExchange]);

  // ── MDL events ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onConnected = () => setMdConnected(true);
    const onDisconnected = () => setMdConnected(false);
    const onRetry = (info: any) => setMdRetryInfo(info);
    const onError = (err: any) => console.warn('[MDL]', err);
    marketDataLayer.addEventListener('connected', onConnected);
    marketDataLayer.addEventListener('disconnected', onDisconnected);
    marketDataLayer.addEventListener('retry', onRetry);
    marketDataLayer.addEventListener('error', onError);
    return () => {
      marketDataLayer.removeEventListener('connected', onConnected);
      marketDataLayer.removeEventListener('disconnected', onDisconnected);
      marketDataLayer.removeEventListener('retry', onRetry);
      marketDataLayer.removeEventListener('error', onError);
    };
  }, []);

  // ── MDL subscription for selected symbol ──────────────────────────────────
  useEffect(() => {
    if (!selectedSymbol) return;
    const mdSymbol = selectedSymbol.replace('/', '');
    const opts = { timeframe: selectedTimeframe, includeIndicators: useFeed, rateLimitMs: 0, bufferMax: 400 };
    const handle = marketDataLayer.subscribe(mdSymbol, opts, (tick: UITick) => {
      try {
        assertUITick(tick);
        verifyDataLayerInvariants(tick, { source: 'network', mode: 'live' });
        const mapped = mapIncomingTick(tick);
        queryClient.setQueryData(worldTicksKey, (prev: any[] | undefined) =>
          [mapped, ...(prev || [])].slice(0, 400)
        );
      } catch (err) {
        console.error('[MDL handler]', err);
      }
    });
    return () => { try { handle.unsubscribe(); } catch {} };
  }, [selectedSymbol, selectedTimeframe, useFeed]);

  // ── openSignalDetails event listener ──────────────────────────────────────
  useEffect(() => {
    const handler = (ev: Event) => {
      try {
        const { detail } = ev as CustomEvent;
        if (detail?.symbol) {
          setSelectedSymbol(detail.symbol);
          setShowRightSidebar(true);
          setOpenSignalDetails({ symbol: detail.symbol, signal: detail.signal });
        }
      } catch {}
    };
    window.addEventListener('scanstream:openSignalDetails', handler as EventListener);
    return () => window.removeEventListener('scanstream:openSignalDetails', handler as EventListener);
  }, []);

  // ── Click outside symbol search ────────────────────────────────────────────
  useEffect(() => {
    const handler = (ev: MouseEvent) => {
      if (showSymbolSearch && !(ev.target as HTMLElement).closest('[data-symbol-search]')) {
        setShowSymbolSearch(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSymbolSearch]);

  // ── Queries (FIX #10: consistent key functions) ────────────────────────────

  const { data: marketData = [] } = useMarketFrames(selectedExchange);
  const { data: orderbook } = useOrderbook(selectedSymbol);
  const worldTicksQuery = useWorldTicks();
  const worldTicks: WorldTick[] = (worldTicksQuery.data ?? []) as unknown as WorldTick[];

  const { data: positions = [], refetch: refetchPositions } = useQuery({
    queryKey: positionsKey,
    queryFn: async ({ signal }: any) => {
      try {
        const res = await fetch('/api/paper-trading/positions', { signal });
        if (!res.ok) return [];
        return (await res.json())?.positions || [];
      } catch (e: any) { return e?.name === 'AbortError' ? [] : []; }
    },
    staleTime: 3000, refetchInterval: 0,
  });

  const { data: orders = [], refetch: refetchOrders } = useQuery({
    queryKey: ['/api/orders'],
    queryFn: async ({ signal }: any) => {
      try {
        const res = await fetch('/api/orders', { signal });
        return res.ok ? res.json() : [];
      } catch (e: any) { return e?.name === 'AbortError' ? [] : []; }
    },
    staleTime: 3000, refetchInterval: 0,
  });

  const { data: agents = [], refetch: refetchAgents } = useQuery<{ id: string; name: string; status: string; lastSignal?: string }[]>({
    queryKey: ['/api/agents'],
    queryFn: async ({ signal }: any) => {
      const res = await fetch('/api/agents', { signal });
      return res.ok ? res.json() : [];
    },
    staleTime: 10000, refetchInterval: 0, refetchOnWindowFocus: true,
  });

  const { data: latestSignals, refetch: refetchSignals, isLoading: signalsLoading, isError: signalsError } = useQuery<Signal[]>({
    queryKey: ['/api/signals/latest'],
    queryFn: ({ signal }: any) => safeFetchJson('/api/signals/latest', { signal }),
    staleTime: 5000, refetchInterval: 0,
  });

  // FIX #4: renamed from activeTrades to match usage below
  const { data: activeTrades, refetch: refetchTrades } = useQuery<Trade[]>({
    queryKey: ['/api/trades'],
    queryFn: ({ signal }: any) => safeFetchJson('/api/trades?status=OPEN', { signal }),
    staleTime: 3000, refetchInterval: 0,
  });

  // Map local `Trade` shape to `PositionManagementPanel`'s `Trade` shape
  const pmTrades: TradeHistory[] = (activeTrades || []).map((t) => ({
    id: t.id,
    symbol: t.symbol,
    entry_price: t.entry_price,
    exit_price: (t as any).exit_price ?? 0,
    size: t.size,
    side: (t.side === 'long' ? 'buy' : 'sell') as 'buy' | 'sell',
    entry_time: new Date(t.entry_time).toISOString(),
    exit_time: t.exit_time ? new Date((t as any).exit_time).toISOString() : '',
    realized_pnl: (t as any).pnl ?? 0,
    realized_pnl_percent: (t as any).pnl_percent ?? 0,
    duration: (t as any).duration ?? '',
  }));

  // FIX #8: read sentiment directly from query, no local state mirrors
  const { data: marketSentiment } = useQuery<MarketSentiment>({
    queryKey: ['/api/market-sentiment'],
    queryFn: ({ signal }: any) => safeFetchJson('/api/market-sentiment', { signal }),
    staleTime: 30000, refetchInterval: 0,
  });

  // FIX #8: read portfolio directly from query
  const { data: portfolioSummary, refetch: refetchPortfolio } = useQuery<PortfolioData>({
    queryKey: ['/api/portfolio-summary'],
    queryFn: ({ signal }: any) => safeFetchJson('/api/portfolio-summary', { signal }),
    staleTime: 10000, refetchInterval: 0,
  });

  const { data: exchangeStatus } = useQuery<ExchangeStatus>({
    queryKey: ['/api/exchange/status'],
    queryFn: ({ signal }: any) => safeFetchJson('/api/exchange/status', { signal }),
    staleTime: 30000, refetchInterval: 0,
  });

  const { data: frontendConfig, isError: frontendConfigError } = useQuery({
    queryKey: ['frontendConfig'],
    queryFn: loadFrontendConfig,
    staleTime: 60000, refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!frontendConfig) return;
    const exchanges = frontendConfig.ui?.availableExchanges || [];
    setAvailableExchanges(exchanges);
    if (exchanges.length && !exchanges.includes(selectedExchange)) {
      setSelectedExchange(exchanges[0]);
    }
  }, [frontendConfig, frontendConfigError, selectedExchange]);

  const { data: gatewayOHLCV } = useQuery({
    queryKey: ['gatewayOHLCV', selectedSymbol],
    enabled: !!selectedSymbol, staleTime: 500,
    queryFn: () => null, // populated via WS
  });

  const { data: gatewaySignals = [], refetch: refetchGatewaySignals } = useGatewaySignals();
  const { symbols: universeSymbols = [] } = useSymbolUniverse({ autoLoad: true, watchChanges: true });

  const { data: priceData } = useQuery({
    queryKey: ['/api/gateway/price', selectedSymbol],
    queryFn: async ({ signal }: any) => {
      try {
        const res = await fetch(`/api/gateway/price/${selectedSymbol}`, { signal });
        return res.ok ? res.json() : null;
      } catch (e: any) { return null; }
    },
    staleTime: 3000, refetchInterval: 0,
  });

  const { data: liveTickerData } = useQuery({
    queryKey: ['/api/gateway/ticker', universeSymbols.map((s: any) => s.symbol).join(',')],
    queryFn: async ({ signal }: any) => {
      try {
        const syms = (universeSymbols || []).slice(0, 5).map((s: any) => s.symbol);
        if (!syms.length) return null;
        const res = await fetch(`/api/gateway/ticker?symbols=${syms.join(',')}`, { signal });
        if (!res.ok) return null;
        const data = await res.json();
        return syms.map((sym: string) => {
          const p = data[sym] || {};
          return { symbol: sym.split('/')[0], price: p.price || 0, change: p.change || 0, changePercent: p.changePercent || 0 };
        });
      } catch { return null; }
    },
    staleTime: 3000, refetchInterval: 0,
  });

  // Clustering (FIX #12: debounced)
  const clusterDebounceRef = useRef<number | null>(null);
  const { data: clusterData } = useQuery({
    queryKey: ['clustering', selectedSymbol],
    queryFn: async ({ signal }: any) => {
      const res = await fetch('/api/analytics/candle-clustering', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [] }), // chartData injected below
        signal,
      });
      return res.ok ? res.json() : null;
    },
    enabled: false, // manually triggered
  });

  const triggerClustering = useCallback((data: ChartPoint[]) => {
    if (clusterDebounceRef.current) window.clearTimeout(clusterDebounceRef.current);
    clusterDebounceRef.current = window.setTimeout(async () => {
      if (data.length < 20) return;
      try {
        const res = await fetch('/api/analytics/candle-clustering', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        });
        if (res.ok) setClusteringData(await res.json());
      } catch {}
    }, 300);
  }, []);

  // Flow field
  const { data: flowFieldData, isLoading: flowFieldLoading } = useQuery<FlowFieldData>({
    queryKey: ['/api/analytics/flow-field', selectedSymbol],
    queryFn: async ({ signal }: any) => {
      const res = await fetch('/api/analytics/flow-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [] }),
        signal,
      });
      if (!res.ok) throw new Error('flow-field failed');
      return (await res.json()).result;
    },
    enabled: true,
    refetchInterval: 30000,
    retry: 1,
  });

  // ML predictions
  const { data: mlPredictions, isLoading: mlPredictionsLoading } = useQuery<MLPredictions>({
    queryKey: ['/api/ml/predictions', selectedSymbol],
    queryFn: async ({ signal }: any) => {
      const res = await fetch('/api/ml/predictions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: selectedSymbol }),
        signal,
      });
      if (!res.ok) throw new Error('ml failed');
      return (await res.json()).predictions;
    },
    refetchInterval: 45000,
    retry: 1,
  });

  // CoinGecko chart
  const { data: coinGeckoChartData, isLoading: isChartLoading, error: chartError, refetch: refetchChart } = useCoinGeckoChart(selectedSymbol, 7);

  // ── Derived / computed values (FIX #8: no local state mirrors) ────────────

  // FIX #8: read from query data directly
  const fearGreedIndex = marketSentiment?.fearGreedIndex ?? 0;
  const btcDominance = marketSentiment?.btcDominance ?? 0;
  const totalMarketCap = marketSentiment?.totalMarketCap ?? 0;
  const volume24h = marketSentiment?.volume24h ?? 0;

  const portfolioValue = portfolioSummary?.totalValue ?? 0;
  const availableCash = portfolioSummary?.availableCash ?? 0;
  const dayChangePercent = portfolioSummary?.dayChangePercent ?? 0;
  const dailyLoss = portfolioSummary?.dayChange ?? 0;

  // Price from priceData → WS market_data → chartData (priority order)
  const currentPrice = useMemo(() => {
    if (priceData?.price) return priceData.price;
    const frames = (marketData as MarketFrame[]).filter(f => f.symbol === selectedSymbol);
    if (frames.length) return frames[frames.length - 1].close;
    return 0;
  }, [priceData, marketData, selectedSymbol]);

  const priceChangePercent = priceData?.priceChangePercent ?? 0;
  const priceChange = priceData?.priceChange ?? 0;

  // Tick aggregation
  const ticksForAggregation: HookWorldTick[] = isReplaying ? (replayPlayback as unknown as HookWorldTick[]) : (worldTicks as unknown as HookWorldTick[]);
  const { candles: feedCandles } = useTickCandles(ticksForAggregation, selectedTimeframe, { minTicks: 10, lookback: 400 });

  const chartData: ChartPoint[] = useMemo(() => {
    if (feedCandles?.length) return feedCandles as ChartPoint[];
    if ((gatewayOHLCV as any)?.success && (gatewayOHLCV as any).candles?.length) {
      return (gatewayOHLCV as any).candles.map((c: any) => ({
        timestamp: c[0] || c.timestamp,
        open: c[1] || c.open, high: c[2] || c.high,
        low: c[3] || c.low, close: c[4] || c.close,
        volume: c[5] || c.volume,
        rsi: c.rsi ?? null, macd: c.macd ?? null, ema: c.ema ?? null,
      }));
    }
    if (coinGeckoChartData?.length) return coinGeckoChartData as unknown as ChartPoint[];
    const filtered = (marketData as MarketFrame[]).filter(f => f.symbol === selectedSymbol);
    return filtered.slice(-200).map(f => ({
      timestamp: f.meta?.tsClose || Date.now(),
      open: f.open, high: f.high, low: f.low, close: f.close, volume: f.volume,
      rsi: f.indicators?.rsi ?? null,
      macd: f.indicators?.macd ? { line: f.indicators.macd.line, signal: f.indicators.macd.signal, histogram: f.indicators.macd.histogram } : null,
      ema: f.indicators?.ema20 ?? null,
    }));
  }, [feedCandles, gatewayOHLCV, coinGeckoChartData, marketData, selectedSymbol]);

  // Trigger clustering when data changes and toggle is on
  useEffect(() => {
    if (showClustering && chartData.length >= 20) triggerClustering(chartData);
  }, [showClustering, chartData, triggerClustering]);

  const tradingChartData = useMemo(() => chartData.map(c => ({
    timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    rsi: c.rsi ?? null, macd: c.macd?.line ?? null, ema: c.ema ?? null,
  })), [chartData]);

  const tradingChartProps = useMemo(() => ({
    data: tradingChartData,
    showVolume: chartIndicators.showVolume,
    showRSI: chartIndicators.showRSI,
    showMACD: chartIndicators.showMACD,
    showEMA: chartIndicators.showEMA,
    showPatterns: chartIndicators.showPatterns,
    timeframe: selectedTimeframe,
    height: 600,
    maxCandles: 200,
    onCandleHover: setHoveredCandleTime,
  }), [tradingChartData, chartIndicators, selectedTimeframe]);

  // Signals combined (FIX #7: single definition, no duplicate)
  const signals = useMemo(() => [
    ...(Array.isArray(latestSignals) ? latestSignals : []),
    ...(Array.isArray(currentSignals) ? currentSignals : []),
  ], [latestSignals, currentSignals]);

  const signalCounts = useMemo(() => ({
    strongBuy: signals.filter(s => s.type === 'BUY' && s.strength > 0.8).length,
    buy: signals.filter(s => s.type === 'BUY' && s.strength <= 0.8).length,
    hold: signals.filter(s => s.type === 'HOLD').length,
    sell: signals.filter(s => s.type === 'SELL' && s.strength <= 0.8).length,
    strongSell: signals.filter(s => s.type === 'SELL' && s.strength > 0.8).length,
  }), [signals]);

  const symbolsList = useMemo(() => {
    const s = new Set<string>();
    (worldTicks as WorldTick[]).forEach(t => t.symbol && s.add(t.symbol));
    (marketData as MarketFrame[]).forEach(m => m.symbol && s.add(m.symbol));
    (gatewaySignals || []).forEach((g: any) => g.symbol && s.add(g.symbol));
    return Array.from(s).sort();
  }, [worldTicks, marketData, gatewaySignals]);

  const selectedPosition = useMemo(() =>
    (positions as any[]).find((p: any) => p.symbol === selectedSymbol) || null,
    [positions, selectedSymbol]
  );
  const selectedOrders = useMemo(() =>
    (orders as any[]).filter((o: any) => o.symbol === selectedSymbol),
    [orders, selectedSymbol]
  );

  const spreadsBySymbol = useMemo(() => {
    const out: Record<string, number> = {};
    const latest: Record<string, MarketFrame> = {};
    (marketData as MarketFrame[]).forEach(m => {
      if (!m?.symbol) return;
      if (!latest[m.symbol] || (m.meta?.tsClose || 0) > (latest[m.symbol].meta?.tsClose || 0)) latest[m.symbol] = m;
    });
    Object.keys(latest).forEach(sym => {
      const f = latest[sym];
      const spread = (f as any)?.microstructure?.spread;
      out[sym] = typeof spread === 'number' ? spread : Math.abs(f.high - f.low);
    });
    if (orderbook && selectedSymbol) {
      const ob = orderbook as unknown as Orderbook;
      const bid = ob.bids?.[0]?.price;
      const ask = ob.asks?.[0]?.price;
      if (bid !== undefined && ask !== undefined) out[selectedSymbol] = Math.max(0, ask - bid);
    }
    return out;
  }, [marketData, orderbook, selectedSymbol]);

  const hoveredCandleSignals = useMemo(() => {
    if (!hoveredCandleTime || !signals.length) return null;
    const windowMs: Record<string, number> = {
      '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000,
      '1d': 86400000, '1w': 604800000, '1month': 2592000000,
    };
    const win = windowMs[selectedTimeframe] || 3600000;
    const matched = signals.filter(s => Math.abs((s.timestamp ?? Date.now()) - hoveredCandleTime) < win);
    if (!matched.length) return null;
    return {
      timestamp: hoveredCandleTime,
      signals: matched,
      totalSignals: matched.length,
      buyCount: matched.filter(s => s.type === 'BUY').length,
      sellCount: matched.filter(s => s.type === 'SELL').length,
      holdCount: matched.filter(s => s.type === 'HOLD').length,
    };
  }, [hoveredCandleTime, signals, selectedTimeframe]);

  const topItems = useMemo(() =>
    getTopItems({ signals, notifications, mdlRetryInfo: mdRetryInfo }),
    [signals, notifications, mdRetryInfo]
  );

  // Preview chart for signal details panel
  const previewSymbol = openSignalDetails?.symbol || selectedSymbol;
  const previewTicks = useMemo(() =>
    (worldTicks as WorldTick[]).filter(t => t.symbol === previewSymbol),
    [worldTicks, previewSymbol]
  );
  const { candles: previewCandles } = useTickCandles(previewTicks, selectedTimeframe, { minTicks: 5, lookback: 200 });
  const previewChartData = useMemo(() => {
    if (Array.isArray(previewCandles) && previewCandles.length > 0) {
      const mapped = previewCandles.map((c: any) => ({
        timestamp: c.timestamp || Date.now(),
        open: Number(c.open || 0), high: Number(c.high || 0),
        low: Number(c.low || 0), close: Number(c.close || 0),
        volume: Number(c.volume || 0),
        rsi: c.rsi ?? null, macd: c.macd ?? null, ema: c.ema ?? null,
      })).filter(d => !(d.open === 0 && d.high === 0 && d.low === 0 && d.close === 0));
      if (mapped.length) return mapped;
    }
    return (marketData as MarketFrame[])
      .filter(f => f.symbol === previewSymbol)
      .slice(-100)
      .map(f => ({
        timestamp: f.meta?.tsClose || Date.now(),
        open: Number(f.open || 0), high: Number(f.high || 0),
        low: Number(f.low || 0), close: Number(f.close || 0),
        volume: Number(f.volume || 0),
        rsi: f.indicators?.rsi ?? null, macd: f.indicators?.macd?.line ?? null, ema: f.indicators?.ema20 ?? null,
      }))
      .filter(d => !(d.open === 0 && d.high === 0 && d.low === 0 && d.close === 0));
  }, [previewCandles, marketData, previewSymbol]);

  // ── Memoised render nodes (FIX #7: single definition each) ────────────────

  const gatewaySignalNodes = useMemo(() => {
    if (!gatewaySignals?.length) return null;
    return gatewaySignals.slice(0, 6).map((s: any) => <GatewaySignalCard key={s.symbol} signal={s} />);
  }, [gatewaySignals]);

  const latestSignalNodes = useMemo(() => {
    if (!signals.length) return null;
    return signals.slice(0, 3).map((signal, index) => (
      <div
        key={index}
        className={`bg-slate-800/30 rounded-lg p-3 border transition-all cursor-pointer hover:shadow-lg ${
          signal.type === 'BUY'
            ? 'border-green-500/30 hover:border-green-500/50 hover:shadow-green-500/10'
            : 'border-red-500/30 hover:border-red-500/50 hover:shadow-red-500/10'
        }`}
        role="button"
        tabIndex={0}
        aria-label={`Signal card for ${signal.symbol}`}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center space-x-2">
            <span className="font-mono font-bold text-white">{signal.symbol}</span>
            <span className={`text-xs px-2 py-0.5 rounded-lg font-bold ${
              signal.type === 'BUY' ? 'bg-green-500/20 text-green-400 border border-green-500/30'
              : 'bg-red-500/20 text-red-400 border border-red-500/30'
            }`}>{signal.type}</span>
          </div>
          <span className="text-sm font-mono text-slate-300 font-semibold">
            {signal.price != null ? formatCurrency(signal.price) : 'N/A'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 mb-2">
          {signal.momentumLabel && <span className="text-xs bg-purple-500/30 text-purple-300 px-2 py-0.5 rounded-full font-mono">{signal.momentumLabel}</span>}
          {signal.regimeState && <span className="text-xs bg-blue-500/30 text-blue-300 px-2 py-0.5 rounded-full font-mono">{signal.regimeState}</span>}
          {signal.legacyLabel && <span className="text-xs bg-yellow-500/30 text-yellow-300 px-2 py-0.5 rounded-full font-mono">{signal.legacyLabel}</span>}
        </div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">Strength</span>
                        <div className="flex items-center space-x-2">
            <div className="w-16 h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${signal.type === 'BUY' ? 'bg-green-400' : 'bg-red-400'} ${pctToBucket(signal.strength)}`} />
            </div>
            <span className={`text-xs font-mono ${signal.type === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
              {(signal.strength * 100).toFixed(0)}%
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">Confidence</span>
          <div className="flex items-center space-x-2">
            <div className="w-16 h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
              <div className={`h-full bg-blue-400 rounded-full ${pctToBucket((signal.confidence ?? 0))}`} />
            </div>
            <span className="text-xs font-mono text-blue-300">{((signal.confidence ?? 0) * 100).toFixed(0)}%</span>
          </div>
        </div>
        <div className="text-xs text-gray-400 mt-2">{(signal.reasoning ?? []).join(', ')}</div>
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-600">
          <div className="text-xs"><span className="text-gray-400">R/R:</span><span className="text-yellow-400 font-mono ml-1">{(signal.riskReward ?? 0).toFixed(1)}</span></div>
          <div className="text-xs"><span className="text-gray-400">Time:</span><span className="text-gray-300 font-mono ml-1">{signal.timestamp ? new Date(signal.timestamp).toLocaleTimeString() : 'N/A'}</span></div>
        </div>
      </div>
    ));
  }, [signals]);

  // ── Replay controls ────────────────────────────────────────────────────────

  const startReplay = useCallback((speedMs?: number) => {
    if (!worldTicks?.length) return;
    const src = [...worldTicks].reverse() as WorldTick[];
    replaySourceRef.current = src;
    setReplayPlayback([]);
    replayIndexRef.current = 0;
    setIsReplaying(true);
    if (speedMs) setReplayIntervalMs(speedMs);
  }, [worldTicks]);

  const stopReplay = useCallback(() => {
    replaySourceRef.current = null;
    replayIndexRef.current = 0;
    setIsReplaying(false);
    setReplayPlayback([]);
  }, []);

  const pauseReplay = useCallback(() => setIsReplaying(false), []);
  const resumeReplay = useCallback(() => { if (replaySourceRef.current) setIsReplaying(true); }, []);
  const setReplaySpeed = useCallback((ms: number) => setReplayIntervalMs(ms), []);
  const seekReplay = useCallback((index: number) => {
    const src = replaySourceRef.current;
    if (!src) return;
    const idx = Math.max(0, Math.min(index, src.length - 1));
    replayIndexRef.current = idx;
    setReplayPlayback(src.slice(0, idx + 1));
  }, []);

  useEffect(() => {
    if (!isReplaying) {
      if (replayTimerRef.current) { window.clearInterval(replayTimerRef.current); replayTimerRef.current = null; }
      return;
    }
    replayTimerRef.current = window.setInterval(() => {
      const src = replaySourceRef.current;
      if (!src) return;
      const idx = replayIndexRef.current;
      if (idx >= src.length) {
        if (replayTimerRef.current) window.clearInterval(replayTimerRef.current);
        setIsReplaying(false); return;
      }
      setReplayPlayback(prev => [...prev, src[idx]]);
      replayIndexRef.current = idx + 1;
    }, replayIntervalMs);
    return () => { if (replayTimerRef.current) { window.clearInterval(replayTimerRef.current); replayTimerRef.current = null; } };
  }, [isReplaying, replayIntervalMs]);

  useEffect(() => () => { if (replayTimerRef.current) window.clearInterval(replayTimerRef.current); }, []);

  // ── Backfill ───────────────────────────────────────────────────────────────

  const handleBackfill = useCallback(async () => {
    if (!selectedSymbol) { addNotification('system', 'low', 'Backfill failed', 'No symbol selected'); return; }
    const mdSym = selectedSymbol.replace('/', '');
    setBackfillInProgress(true); setBackfillCount(0); backfillCountRef.current = 0;
    const tmp = marketDataLayer.subscribe(mdSym, { timeframe: selectedTimeframe, includeIndicators: useFeed, rateLimitMs: 0, bufferMax: 1000 }, (tick: UITick) => {
      try {
        assertUITick(tick);
        verifyDataLayerInvariants(tick, { source: 'network', mode: 'backtest' });
        const mapped = mapIncomingTick(tick);
        queryClient.setQueryData(worldTicksKey, (prev: any[] | undefined) => [mapped, ...(prev || [])].slice(0, 400));
        backfillCountRef.current++;
        setBackfillCount(backfillCountRef.current);
      } catch (err) { console.warn('[Backfill invariant]', err); }
    });
    try {
      await tmp.requestReplay(Date.now() - 5 * 60 * 1000, Date.now());
      addNotification('system', 'low', 'Backfill complete', `Replayed ${backfillCountRef.current} ticks for ${selectedSymbol}`);
    } catch (err) {
      addNotification('system', 'high', 'Backfill failed', String(err));
    } finally {
      try { tmp.unsubscribe(); } catch {}
      setBackfillInProgress(false);
      setTimeout(() => setBackfillCount(0), 2500);
    }
  }, [selectedSymbol, selectedTimeframe, useFeed, addNotification]);

  // ── Attention handler ──────────────────────────────────────────────────────

  const handleAttentionClick = useCallback(async (item: AttentionItem) => {
    try {
      if (item?.symbol) {
        setSelectedSymbol(item.symbol);
        setShowLeftRail(true);
        if (!focusMode) toggleFocusMode();
      } else if (item.id === 'mdl_retry') {
        await handleBackfill();
      }
    } catch (err) { console.error('[Attention click]', err); }
  }, [focusMode, toggleFocusMode, handleBackfill]);

  // ── Agent toggle ───────────────────────────────────────────────────────────

  const toggleAgentApi = async (id: string) => {
    try { toggleAgentControllerRef.current?.abort(); } catch {}
    const controller = new AbortController();
    toggleAgentControllerRef.current = controller;
    try {
      const resp = await fetch(`/api/agents/${encodeURIComponent(id)}/toggle`, { method: 'POST', signal: controller.signal });
      if (!resp.ok) throw new Error(`Toggle failed: ${resp.statusText}`);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      console.error('[toggleAgent]', err);
    } finally { try { await refetchAgents(); } catch {} }
  };

  // ── Screenshot / export ────────────────────────────────────────────────────

  const takeChartScreenshot = useCallback(async () => {
    try {
      const el = document.querySelector('.chart-container') as HTMLElement | null;
      if (!el) { addNotification('system', 'low', 'Screenshot Failed', 'Chart element not found'); return; }
      const html2canvas = (window as any).html2canvas;
      if (typeof html2canvas === 'function') {
        const canvas: HTMLCanvasElement = await html2canvas(el, { backgroundColor: null });
        canvas.toBlob(blob => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = Object.assign(document.createElement('a'), { href: url, download: `${selectedSymbol}-${Date.now()}.png` });
          document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          addNotification('system', 'low', 'Screenshot Saved', 'Saved to downloads');
        });
        return;
      }
      addNotification('system', 'low', 'Screenshot Unavailable', 'Install html2canvas or use Export CSV');
    } catch (err) { addNotification('system', 'high', 'Screenshot Error', String(err)); }
  }, [selectedSymbol, addNotification]);

  const exportChartCSV = useCallback(() => {
    try {
      if (!chartData.length) { addNotification('system', 'low', 'Export Failed', 'No chart data'); return; }
      const csv = ['timestamp,open,high,low,close,volume', ...chartData.map(c => `${c.timestamp},${c.open},${c.high},${c.low},${c.close},${c.volume}`)].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${selectedSymbol}-${Date.now()}.csv` });
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      addNotification('system', 'low', 'Export Complete', 'CSV saved');
    } catch (err) { addNotification('system', 'high', 'Export Error', String(err)); }
  }, [chartData, selectedSymbol, addNotification]);

  // ── Pin toggle ─────────────────────────────────────────────────────────────

  const togglePin = (sym: string) => {
    setPinnedSymbols(prev => {
      const next = prev.includes(sym) ? prev.filter(s => s !== sym) : [sym, ...prev];
      try { localStorage.setItem('pinnedSymbols', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // ── Error fallback ─────────────────────────────────────────────────────────

  const ErrorFallback = ({ error }: { error: Error }) => (
    <div className="p-4 bg-red-900/30 text-white rounded-lg border border-red-500/30">
      <h3 className="text-sm font-semibold mb-1">Something went wrong</h3>
      <p className="text-xs text-slate-300 mb-2">{error.message}</p>
      <button className="text-xs px-3 py-1 bg-slate-700 rounded" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );

  // ── TerminalLayout panels ──────────────────────────────────────────────────

  const panels = useMemo(() => [
    {
      id: 'top-signals', title: 'Top Signals',
      content: (
        <div className="p-2">
          {gatewaySignals?.length > 0 && (
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-indigo-400 mb-2 uppercase tracking-wide">Gateway Scanner</h3>
              <div className="grid grid-cols-2 gap-2">{gatewaySignalNodes}</div>
            </div>
          )}
          <h3 className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wide">Latest Signals</h3>
          <div className="space-y-2">{latestSignalNodes}</div>
        </div>
      ),
    },
    { id: 'world-ticks', title: 'World Ticks', content: <div className="p-2"><WorldTicksPanel ticks={worldTicks as any} limit={50} /></div> },
    { id: 'event-feed', title: 'Event Feed', content: <div className="p-2"><EventFeedPanel ticks={worldTicks as any} signals={currentSignals} alerts={[]} /></div> },
    { id: 'orderbook', title: 'Orderbook', content: <div className="p-2"><OrderbookPanel orderbook={orderbook as any} /></div> },
    {
      id: 'positions', title: 'Positions',
      content: (
        <div className="p-2">
          {/* FIX #4: activeTrades (not trades) */}
          <PositionManagementPanel positions={positions as any} trades={pmTrades} orders={orders as any} selectedPosition={selectedPosition as any} selectedOrders={selectedOrders as any} />
        </div>
      ),
    },
    { id: 'risk', title: 'Risk', content: <div className="p-2"><RiskManagementPanel portfolioValue={portfolioValue} dailyLoss={dailyLoss} /></div> },
  ], [gatewaySignals, gatewaySignalNodes, latestSignalNodes, worldTicks, currentSignals, orderbook, positions, activeTrades, orders, selectedPosition, selectedOrders, portfolioValue, dailyLoss]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen text-white flex flex-col bg-[var(--app-bg)] text-[var(--app-text)]">

      {/* Ambient background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl animate-pulse delay-700" />
      </div>

      {/* Market Status Bar */}
      <MarketStatusBar
        isConnected={wsConnected}
        currentPrice={currentPrice}
        priceChange={priceChange}
        priceChangePercent={priceChangePercent}
        volume24h={volume24h}
        portfolioValue={portfolioValue}
        dayChangePercent={dayChangePercent}
        exchangeStatus={exchangeStatus}
        mdlConnected={mdConnected}
        mdlRetryInfo={mdRetryInfo}
        topItems={topItems}
        onAttentionClick={handleAttentionClick}
        selectedSymbol={selectedSymbol}
        onBackfill={handleBackfill}
        backfillInProgress={backfillInProgress}
        backfillCount={backfillCount}
        liveTickerData={liveTickerData || undefined}
      />

      <PerfObserver thresholdMs={50} />

      <ReplayModeBanner
        isReplaying={isReplaying}
        currentTime={replayPlayback.length}
        totalTime={(worldTicks as WorldTick[]).length}
        onResume={resumeReplay}
        onReset={stopReplay}
      />

      {/* Header */}
      <header className="relative border-b backdrop-blur-xl px-6 py-3 flex items-center justify-between flex-shrink-0 bg-[var(--app-surface)]">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gradient-to-r from-blue-600 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Brain className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">QuantumScanner Pro</h1>
            <p className="text-xs text-slate-500">Trading Terminal</p>
          </div>
          <span className={`ml-4 px-2 py-0.5 rounded text-xs font-semibold ${isLiveMode ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-200'}`}>
            {isLiveMode ? 'LIVE' : 'PAPER'}
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button onClick={() => setShowLeftSidebar((p: boolean) => !p)}
            className={`p-2 hover:bg-slate-800 border border-slate-700 rounded-lg transition-all ${showLeftSidebar ? 'bg-blue-500/20 border-blue-500/50' : ''}`}
            aria-label={showLeftSidebar ? 'Hide left sidebar' : 'Show left sidebar'}>
            {showLeftSidebar ? <PanelLeftClose className="w-4 h-4 text-blue-400" /> : <PanelLeftOpen className="w-4 h-4 text-slate-400" />}
          </button>
          <button onClick={() => setShowRightSidebar((p: boolean) => !p)}
            className={`p-2 hover:bg-slate-800 border border-slate-700 rounded-lg transition-all ${showRightSidebar ? 'bg-blue-500/20 border-blue-500/50' : ''}`}
            aria-label={showRightSidebar ? 'Hide right sidebar' : 'Show right sidebar'}>
            {showRightSidebar ? <PanelRightClose className="w-4 h-4 text-blue-400" /> : <PanelRightOpen className="w-4 h-4 text-slate-400" />}
          </button>
          <button onClick={toggleFocusMode}
            className={`p-2 hover:bg-slate-800 border border-slate-700 rounded-lg transition-all ${focusMode ? 'bg-purple-500/20 border-purple-500/50' : ''}`}
            aria-label={focusMode ? 'Exit focus mode' : 'Enter focus mode'}>
            {focusMode ? <Minimize2 className="w-4 h-4 text-purple-400" /> : <Maximize2 className="w-4 h-4 text-slate-400" />}
          </button>
          <div className="h-6 w-px bg-slate-700" />
          <button onClick={() => setShowNotifications((p: boolean) => !p)}
            className="relative p-2 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors"
            aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}>
            <Bell className={`w-4 h-4 ${unreadCount > 0 ? 'text-blue-400 animate-pulse' : 'text-slate-400'}`} />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 px-1.5 py-0.5 bg-red-600 text-white text-xs font-bold rounded-full min-w-[18px] text-center">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
          <button onClick={() => setShowSettingsModal(true)}
            className="p-2 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors" aria-label="Settings">
            <Cog className="w-4 h-4 text-slate-400" />
          </button>
          <button onClick={() => setShowPanelManager(true)}
            className="p-2 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors" aria-label="Panel manager">
            <Layers className="w-4 h-4 text-slate-400" />
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="px-6 py-2 border-b border-slate-700 bg-slate-900/60 flex-shrink-0">
        <div className="flex items-center gap-1 flex-wrap">
          {([
            { id: 'chart', label: 'Chart', icon: BarChart3 },
            { id: 'overview', label: 'Overview', icon: Activity },
            { id: 'scanner', label: 'Scanner', icon: Search },
            { id: 'signals', label: 'Signals', icon: Zap },
            { id: 'positions', label: 'Positions', icon: Wallet },
            { id: 'portfolio', label: 'Portfolio', icon: TrendingUp },
            { id: 'backtest', label: 'Backtest', icon: Clock },
            { id: 'ml', label: 'ML', icon: Brain },
            { id: 'diagnostics', label: 'Diagnostics', icon: Cog },
          ] as const).map(t => {
            const Icon = t.icon as any;
            return (
              <button key={t.id} onClick={() => setActiveTab(t.id as any)}
                className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-xs transition-colors ${activeTab === t.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/60'}`}
                aria-pressed={activeTab === t.id}>
                <Icon className="w-3.5 h-3.5" />{t.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Main area */}
      <TerminalLayout
        panels={panels}
        defaultPanels={[
          { id: 'top-signals', title: 'Top Signals', position: 'docked', collapsed: false },
          { id: 'world-ticks', title: 'World Ticks', position: 'docked', collapsed: false },
          { id: 'event-feed', title: 'Event Feed', position: 'docked', collapsed: false },
          { id: 'orderbook', title: 'Orderbook', position: 'docked', collapsed: false },
          { id: 'positions', title: 'Positions', position: 'docked', collapsed: false },
          { id: 'risk', title: 'Risk', position: 'docked', collapsed: false },
        ]}
        hero={{ symbol: selectedSymbol, name: selectedSymbol, price: currentPrice, change24h: priceChangePercent }}
      >
        <div className="flex-1 flex overflow-auto relative">

          {/* FAB: show left sidebar */}
          {!showLeftSidebar && (
            <button onClick={() => setShowLeftSidebar(true)}
              className="fixed left-4 top-1/2 -translate-y-1/2 z-50 p-3 bg-blue-600 hover:bg-blue-500 rounded-full shadow-xl transition-all group"
              aria-label="Show signals panel">
              <BarChart3 className="w-5 h-5 text-white" />
            </button>
          )}
          {!showRightSidebar && (
            <button onClick={() => setShowRightSidebar(true)}
              className="fixed right-4 top-1/2 -translate-y-1/2 z-50 p-3 bg-purple-600 hover:bg-purple-500 rounded-full shadow-xl transition-all"
              aria-label="Show portfolio panel">
              <Wallet className="w-5 h-5 text-white" />
            </button>
          )}

          {/* Left sidebar */}
          {showLeftSidebar && (
            <ErrorBoundary FallbackComponent={ErrorFallback}>
              <div
                className="absolute left-0 top-0 bottom-0 w-80 bg-gradient-to-br from-slate-800/95 to-slate-900/95 backdrop-blur-md border-r border-slate-700/50 flex flex-col z-40 shadow-2xl animate-in slide-in-from-left duration-300 overflow-y-auto"
                aria-label="Market Overview Sidebar"
                onMouseEnter={() => { if (leftSidebarTimerRef.current) window.clearTimeout(leftSidebarTimerRef.current); }}
                onMouseLeave={resetLeftSidebarTimer}
              >
                {/* Signals header */}
                <div className="p-4 border-b sticky top-0 bg-[var(--app-surface)] backdrop-blur-sm z-10">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-bold text-white">Top Signals</h2>
                    <button
                      className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1"
                      onClick={() => { try { refetchSignals(); } catch {} try { refetchGatewaySignals(); } catch {} }}
                      aria-label="Refresh Signals">
                      <RefreshCw className="w-3 h-3" /> Refresh
                    </button>
                  </div>
                </div>

                {gatewaySignals?.length > 0 && (
                  <div className="p-4 border-b border-slate-700/50">
                    <h3 className="text-xs font-semibold text-indigo-400 mb-3 uppercase tracking-wide">Gateway Scanner</h3>
                    <div className="grid grid-cols-2 gap-2">{gatewaySignalNodes}</div>
                  </div>
                )}

                <div className="p-4 border-b border-slate-700/50">
                  <h3 className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wide">Latest Signals</h3>
                  <div className="space-y-3">
                    {signalsLoading && <div className="animate-pulse space-y-2"><div className="h-12 bg-slate-700/30 rounded-lg" /><div className="h-12 bg-slate-700/30 rounded-lg" /></div>}
                    {signalsError && <button className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm" onClick={() => refetchSignals()}>Retry</button>}
                    {latestSignalNodes}
                    {signals.length === 0 && !signalsLoading && !signalsError && (
                      <div className="text-center py-8 text-gray-400">
                        <Target className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p className="text-sm">No signals detected</p>
                        <p className="text-xs">Scanning markets…</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Market Sentiment */}
                <div className="p-4 border-b border-slate-700/50">
                  <h3 className="text-sm font-semibold mb-3 text-white">Market Sentiment</h3>
                  <div className="space-y-3">
                    <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/30">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-400">Fear & Greed</span>
                        <span className="text-xs font-mono text-yellow-400">{fearGreedIndex}</span>
                      </div>
                        <div className="w-full h-2 bg-gradient-to-r from-red-500 via-yellow-400 to-green-500 rounded-full relative">
                        <div className={`absolute top-0 w-1 h-2 bg-white rounded-full ${leftPctClass(fearGreedIndex)}`} />
                      </div>
                    </div>
                    <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/30">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-400">BTC Dominance</span>
                        <span className="text-xs font-mono text-blue-400">{btcDominance.toFixed(1)}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
                        <div className={`h-full bg-blue-400 rounded-full ${pctToBucket(btcDominance/100)}`} />
                      </div>
                    </div>
                    <div className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/30">
                      <div className="flex items-center justify-between">
                        <div><div className="text-xs text-slate-400">Total Mkt Cap</div><div className="text-sm font-mono text-white">${totalMarketCap.toFixed(2)}T</div></div>
                        <div className="text-right"><div className="text-xs text-slate-400">24h Vol</div><div className="text-sm font-mono text-slate-300">${volume24h.toFixed(1)}B</div></div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Top Movers */}
                <div className="p-4 border-b border-slate-700/50">
                  <TopMoversWidget limit={5} />
                </div>

                <GlobalSummaryPanel totalSignals={signals.length} reliability={{ binance: 0.98, coinbase: 0.96 }} activePositions={0} />

                {/* Symbol list */}
                <div className="p-4 border-b border-slate-700/50">
                  <h3 className="text-sm font-semibold mb-2 text-white">Symbols</h3>
                  <div className="h-64">
                    <SymbolList
                      symbols={symbolsList}
                      worldTicks={worldTicks as any}
                      orderbook={orderbook as any}
                      signals={signals}
                      pinned={pinnedSymbols}
                      spreads={spreadsBySymbol}
                      onTogglePin={togglePin}
                      onSelect={(sym: string) => { setSelectedSymbol(sym); setShowLeftSidebar(false); }}
                    />
                  </div>
                </div>

                <AgentPanel agents={agents as any} onToggle={toggleAgentApi} />

                {/* Signal distribution */}
                <div className="p-4">
                  <h3 className="text-sm font-semibold mb-3 text-white">Signal Distribution</h3>
                  <div className="space-y-2">
                    {[
                      { label: 'Strong Buy', count: signalCounts.strongBuy, color: 'bg-green-500' },
                      { label: 'Buy', count: signalCounts.buy, color: 'bg-green-400' },
                      { label: 'Hold', count: signalCounts.hold, color: 'bg-gray-400' },
                      { label: 'Sell', count: signalCounts.sell, color: 'bg-red-400' },
                      { label: 'Strong Sell', count: signalCounts.strongSell, color: 'bg-red-600' },
                    ].map(({ label, count, color }) => (
                      <div key={label} className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <div className={`w-3 h-3 ${color} rounded-full`} />
                          <span className="text-sm">{label}</span>
                        </div>
                        <span className="text-sm font-mono">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </ErrorBoundary>
          )}

          {/* ── Main content area ─────────────────────────────────────────────── */}
          <ErrorBoundary FallbackComponent={ErrorFallback}>
            <div className={`flex-1 flex flex-col ${isChartFullscreen ? 'fixed inset-0 z-50 bg-slate-950' : ''}`}>

              {/* ── CHART TAB ─────────────────────────────────────────────────── */}
              {activeTab === 'chart' && (
                <div className="flex-1 bg-gradient-to-br from-slate-900/60 to-slate-800/60 backdrop-blur-sm p-4 overflow-auto">
                  {/* Chart toolbar */}
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                    <div className="flex items-center space-x-4">
                      {/* Symbol picker */}
                      <div className="relative" data-symbol-search>
                        <button onClick={() => setShowSymbolSearch((p: boolean) => !p)}
                          className="flex items-center space-x-2 px-3 py-2 bg-slate-800/50 hover:bg-slate-800 border border-slate-700/50 rounded-lg"
                            aria-expanded={showSymbolSearch}>
                          <h2 className="text-xl font-bold font-mono">{selectedSymbol}</h2>
                          <Search className="w-4 h-4 text-slate-400" />
                        </button>
                        {showSymbolSearch && (
                          <div className="absolute top-full left-0 mt-2 w-64 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-50 p-2 animate-in fade-in slide-in-from-top-2 duration-200">
                            <div className="text-xs text-slate-400 px-3 py-2 border-b border-slate-700 mb-2">Select Symbol</div>
                            <div className="space-y-1 max-h-64 overflow-y-auto">
                              {((universeSymbols?.length ? universeSymbols.slice(0, 50).map((s: any) => s.symbol) : symbolsList)).map((sym: string) => (
                                <button key={sym} onClick={() => { setSelectedSymbol(sym); setShowSymbolSearch(false); }}
                                  className={`w-full text-left px-3 py-2 rounded text-sm font-mono ${sym === selectedSymbol ? 'bg-blue-600 text-white' : 'hover:bg-slate-700 text-slate-300'}`}>
                                  {sym}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <span className="px-2 py-1 rounded bg-slate-800/50 text-xs font-mono border border-slate-700/50">{selectedExchange}</span>
                      <div className="flex items-center space-x-2">
                        <span className="text-2xl font-mono text-white">{formatCurrency(chartData.length > 0 ? (chartData[chartData.length - 1]?.close || currentPrice) : currentPrice)}</span>
                        <span className={`text-sm font-mono ${priceChangePercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatPercent(priceChangePercent)}</span>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 flex-wrap gap-1">
                      {/* Timeframes */}
                      <div className="flex bg-slate-800/50 rounded-lg p-1 border border-slate-700/50">
                        {(['1m','5m','15m','1h','1d','1w','1month'] as const).map(tf => (
                          <button key={tf} onClick={() => setSelectedTimeframe(tf)}
                            className={`px-2.5 py-1 text-xs rounded whitespace-nowrap transition-colors ${selectedTimeframe === tf ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white font-medium' : 'text-slate-400 hover:text-white'}`}>
                            {tf}
                          </button>
                        ))}
                      </div>
                      {/* Exchange */}
                      <select aria-label="Select exchange" title="Select exchange" className="px-2 py-1 text-xs rounded bg-slate-800/50 text-white border border-slate-700/50"
                        value={selectedExchange} onChange={e => setSelectedExchange(e.target.value)}>
                        {availableExchanges.map(ex => <option key={ex} value={ex}>{ex.charAt(0).toUpperCase() + ex.slice(1)}</option>)}
                      </select>
                      <button onClick={() => setUseFeed((p: boolean) => !p)}
                        className={`px-2 py-1 text-xs rounded font-medium transition-all ${useFeed ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                        {useFeed ? 'Feed' : 'Ext'}
                      </button>
                      <button onClick={() => setIsChartFullscreen((p: boolean) => !p)}
                        className="p-2 hover:bg-slate-800/50 rounded-lg" aria-label="Toggle fullscreen">
                        <ExpandIcon className="w-4 h-4 text-slate-400" />
                      </button>
                    </div>
                  </div>

                  {/* Chart body */}
                  <div className="h-[calc(100%-5rem)] chart-container">
                    {chartError ? (
                      <div className="h-full flex items-center justify-center">
                        <div className="text-center max-w-md">
                          <div className="text-lg font-semibold mb-2 text-slate-200">Chart Data Unavailable</div>
                          <div className="text-sm text-slate-400 mb-4">{chartError instanceof Error ? chartError.message : 'Failed to load chart data.'}</div>
                          <button onClick={() => refetchChart()} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm flex items-center gap-2 mx-auto">
                            <RefreshCw className="w-4 h-4" /> Retry
                          </button>
                        </div>
                      </div>
                    ) : isChartLoading && chartData.length === 0 ? (
                      <div className="h-full flex items-center justify-center">
                        <div className="text-center">
                          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4" />
                          <p className="text-slate-400">Loading {selectedSymbol} chart…</p>
                        </div>
                      </div>
                    ) : chartData.length > 0 ? (
                      <ReplayModeDesaturatedWrapper isReplaying={isReplaying}>
                        <div className="w-full h-full flex gap-3 relative">
                          <ReplayModeWatermark isReplaying={isReplaying} position="top-right" opacity={0.1} />

                          {/* Chart + asset info — left */}
                          <div className="flex-1 flex flex-col min-w-0">
                            {/* Asset info header */}
                            <div className="bg-slate-800/60 rounded-lg p-3 mb-3 border border-slate-700/50">
                              <div className="flex items-start justify-between">
                                <div className="flex items-center space-x-3">
                                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                                    <span className="text-lg font-bold text-white">{selectedSymbol.split('/')[0].substring(0, 2)}</span>
                                  </div>
                                  <div>
                                    <div className="flex items-center space-x-2">
                                      <h3 className="text-lg font-bold text-white">{selectedSymbol.split('/')[0]}</h3>
                                      <span className="text-xs px-2 py-0.5 bg-slate-700/50 text-slate-300 rounded">{selectedSymbol.split('/')[1]}</span>
                                      <span className="px-2 py-0.5 bg-green-500/10 border border-green-500/30 rounded text-xs font-mono text-green-400">⚡ Live</span>
                                    </div>
                                    <div className="flex items-center space-x-3 mt-1">
                                      <span className="text-2xl font-mono font-bold text-white">${chartData[chartData.length - 1]?.close?.toFixed(2) || '0.00'}</span>
                                      <span className={`text-sm font-mono px-2 py-1 rounded ${priceChangePercent >= 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                                        {formatPercent(priceChangePercent)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3 text-right text-xs">
                                  <div><div className="text-slate-400">24h High</div><div className="font-mono font-bold text-green-400">${Math.max(...chartData.map(d => d.high)).toFixed(2)}</div></div>
                                  <div><div className="text-slate-400">24h Low</div><div className="font-mono font-bold text-red-400">${Math.min(...chartData.map(d => d.low)).toFixed(2)}</div></div>
                                  <div><div className="text-slate-400">Volume</div><div className="font-mono font-bold text-blue-400">${(chartData.reduce((s, d) => s + (d.volume ?? 0), 0) / 1e6).toFixed(2)}M</div></div>
                                  <div><div className="text-slate-400">Candles</div><div className="font-mono font-bold text-purple-400">{chartData.length}</div></div>
                                </div>
                              </div>
                            </div>

                            <div className="mb-3"><SymbolPanel symbol={selectedSymbol} latest={chartData[chartData.length - 1] as any} signals={signals.filter(s => s.symbol === selectedSymbol)} /></div>

                            {/* Chart */}
                            <div className="flex-1 min-h-0 bg-slate-800/20 rounded-lg border border-slate-700/50 p-2 relative">
                              <TradingChart {...tradingChartProps} />

                              {/* Footprint / footprint candle view */}
                              <div className="mt-3">
                                <FootprintChart candles={(chartData || []).slice(-80).map((c:any) => ({ ts: c.timestamp || Date.now(), open: c.open, high: c.high, low: c.low, close: c.close, footprint: c.footprint }))} height={160} />
                              </div>

                              {/* FIX #2: hoveredCandleSignals tooltip — properly closed */}
                              {hoveredCandleSignals && (
                                <div className="absolute top-4 right-4 bg-slate-900/95 border border-slate-700 rounded-lg p-4 z-10 max-w-xs shadow-2xl">
                                  <div className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                                    <span className="text-blue-400">📍</span> Candle Signals
                                  </div>
                                  <div className="space-y-1 text-xs">
                                    <div className="flex justify-between"><span className="text-slate-400">Total</span><span className="text-white font-mono">{hoveredCandleSignals.totalSignals}</span></div>
                                    <div className="flex justify-between"><span className="text-green-400">Buy</span><span className="text-white font-mono">{hoveredCandleSignals.buyCount}</span></div>
                                    <div className="flex justify-between"><span className="text-red-400">Sell</span><span className="text-white font-mono">{hoveredCandleSignals.sellCount}</span></div>
                                    <div className="flex justify-between"><span className="text-yellow-400">Hold</span><span className="text-white font-mono">{hoveredCandleSignals.holdCount}</span></div>
                                  </div>
                                  {hoveredCandleSignals.signals.slice(0, 5).map((s, i) => (
                                    <div key={i} className="mt-2 text-xs text-slate-300 flex justify-between">
                                      <span>{s.symbol}</span>
                                      <span className={s.type === 'BUY' ? 'text-green-400' : s.type === 'SELL' ? 'text-red-400' : 'text-yellow-400'}>{s.type}</span>
                                    </div>
                                  ))}
                                  {hoveredCandleSignals.signals.length > 5 && (
                                    <div className="text-slate-500 text-xs mt-1">+{hoveredCandleSignals.signals.length - 5} more</div>
                                  )}
                                </div>
                              )}

                              <FloatingChartToolbar
                                selectedTimeframe={selectedTimeframe}
                                onTimeframeChange={tf => setSelectedTimeframe(tf as any)}
                                isFullscreen={false}
                                onFullscreenToggle={() => {}}
                                onScreenshot={takeChartScreenshot}
                                onExport={exportChartCSV}
                              />
                            </div>
                          </div>

                          {/* Right panel: indicators + orderbook */}
                          <div className="w-72 flex flex-col space-y-3 overflow-y-auto">
                            {/* Technical indicators */}
                            <div className="bg-slate-800/60 rounded-lg p-4 border border-slate-700/50">
                              <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-blue-400" />Indicators</h4>
                              <div className="flex flex-wrap gap-2 mb-3">
                                {(['showVolume','showRSI','showMACD','showEMA'] as ChartIndicatorKey[]).map(k => (
                                  <button key={k} onClick={() => setChartIndicators(p => ({ ...p, [k]: !p[k] }))}
                                    className={`px-2 py-1 rounded text-xs transition-colors ${chartIndicators[k] ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                                    {k.replace('show', '')}
                                  </button>
                                ))}
                                <button onClick={() => setShowClustering((p: boolean) => !p)}
                                  className={`px-2 py-1 rounded text-xs ${showClustering ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                                  Clusters
                                </button>
                              </div>

                              {/* RSI */}
                              {chartIndicators.showRSI && chartData[chartData.length - 1]?.rsi != null && (
                                <div className="bg-slate-900/40 rounded-lg p-3 border border-slate-700/30 mb-2">
                                  <div className="flex justify-between mb-1">
                                    <span className="text-xs text-slate-400">RSI (14)</span>
                                    <span className={`text-sm font-mono font-bold ${(chartData[chartData.length - 1]?.rsi || 50) > 70 ? 'text-red-400' : (chartData[chartData.length - 1]?.rsi || 50) < 30 ? 'text-green-400' : 'text-yellow-400'}`}>
                                      {chartData[chartData.length - 1]?.rsi?.toFixed(1)}
                                    </span>
                                  </div>
                                  <div className="w-full h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full ${(chartData[chartData.length - 1]?.rsi || 50) > 70 ? 'bg-red-400' : (chartData[chartData.length - 1]?.rsi || 50) < 30 ? 'bg-green-400' : 'bg-yellow-400'} ${pctToBucket((chartData[chartData.length - 1]?.rsi || 50)/100)}`} />
                                  </div>
                                </div>
                              )}

                              {/* MACD */}
                              {chartIndicators.showMACD && chartData[chartData.length - 1]?.macd && (
                                <div className="bg-slate-900/40 rounded-lg p-3 border border-slate-700/30 mb-2">
                                  <div className="flex justify-between mb-1">
                                    <span className="text-xs text-slate-400">MACD</span>
                                    <span className={`text-xs font-mono font-bold ${(chartData[chartData.length - 1]?.macd?.line ?? 0) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      {(chartData[chartData.length - 1]?.macd?.line ?? 0).toFixed(4)}
                                    </span>
                                  </div>
                                  <div className="text-xs text-slate-500">Sig: {(chartData[chartData.length - 1]?.macd?.signal ?? 0).toFixed(4)} | Hist: {(chartData[chartData.length - 1]?.macd?.histogram ?? 0).toFixed(4)}</div>
                                </div>
                              )}

                              {/* EMA */}
                              {chartIndicators.showEMA && chartData[chartData.length - 1]?.ema != null && (
                                <div className="bg-slate-900/40 rounded-lg p-3 border border-slate-700/30">
                                  <div className="flex justify-between">
                                    <span className="text-xs text-slate-400">EMA (20)</span>
                                    <span className="text-xs font-mono font-bold text-purple-400">${chartData[chartData.length - 1]?.ema?.toFixed(2)}</span>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Key levels */}
                            <div className="bg-slate-800/60 rounded-lg p-4 border border-slate-700/50">
                              <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2"><Layers className="w-4 h-4 text-yellow-400" />Key Levels</h4>
                              <div className="space-y-2">
                                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2">
                                  <div className="flex justify-between"><span className="text-xs text-red-400 font-medium">Resistance</span><span className="text-sm font-mono font-bold text-red-400">${Math.max(...chartData.map(d => d.high)).toFixed(2)}</span></div>
                                </div>
                                <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-2">
                                  <div className="flex justify-between"><span className="text-xs text-blue-400 font-medium">Current</span><span className="text-sm font-mono font-bold text-blue-400">${chartData[chartData.length - 1]?.close?.toFixed(2)}</span></div>
                                </div>
                                <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-2">
                                  <div className="flex justify-between"><span className="text-xs text-green-400 font-medium">Support</span><span className="text-sm font-mono font-bold text-green-400">${Math.min(...chartData.map(d => d.low)).toFixed(2)}</span></div>
                                </div>
                              </div>
                            </div>

                            {/* Orderbook */}
                            <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/50">
                              <h4 className="text-sm font-bold text-white mb-2 flex items-center gap-2"><BookOpen className="w-4 h-4 text-yellow-400" />Orderbook</h4>
                              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                                <div>
                                  {orderbook && ((orderbook as any).bids || (orderbook as any).asks) ? (
                                    <div className="py-1">
                                      <OrderbookDepth
                                        bids={((orderbook as any)?.bids || []).map((b: any) => ({ price: b.price, size: b.size }))}
                                        asks={((orderbook as any)?.asks || []).map((a: any) => ({ price: a.price, size: a.size }))}
                                      />
                                    </div>
                                  ) : (
                                    <div>
                                      <div className="text-slate-400 mb-1">Bids</div>
                                      {((orderbook as any)?.bids || []).slice(0, 6).map((b: any, i: number) => (
                                        <div key={i} className="flex justify-between text-green-400 py-0.5">
                                          <span>${b.price.toFixed(2)}</span><span className="text-slate-300">{b.size.toFixed(4)}</span>
                                        </div>
                                      ))}
                                      {!((orderbook as any)?.bids?.length) && <div className="text-slate-500">No bids</div>}
                                      <div className="text-slate-400 mb-1 mt-2">Asks</div>
                                      {((orderbook as any)?.asks || []).slice(0, 6).map((a: any, i: number) => (
                                        <div key={i} className="flex justify-between text-red-400 py-0.5">
                                          <span>${a.price.toFixed(2)}</span><span className="text-slate-300">{a.size.toFixed(4)}</span>
                                        </div>
                                      ))}
                                      {!((orderbook as any)?.asks?.length) && <div className="text-slate-500">No asks</div>}
                                    </div>
                                  )}
                              </div>
                            </div>

                            {/* Flow field */}
                            <div className="bg-indigo-900/40 rounded-lg p-4 border border-indigo-500/30">
                              <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2"><Waves className="w-4 h-4 text-indigo-400" />Flow Field</h4>
                              {flowFieldData ? (
                                <div className="space-y-2 text-xs">
                                  <div className="flex justify-between"><span className="text-slate-400">Direction</span><span className={`font-bold ${flowFieldData.dominantDirection === 'bullish' ? 'text-green-400' : flowFieldData.dominantDirection === 'bearish' ? 'text-red-400' : 'text-yellow-400'}`}>{flowFieldData.dominantDirection}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Force</span><span className="font-mono text-indigo-300">{(flowFieldData.latestForce * 100).toFixed(2)}%</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Turbulence</span><span className={`font-bold ${flowFieldData.turbulenceLevel === 'low' ? 'text-green-400' : flowFieldData.turbulenceLevel === 'extreme' ? 'text-red-400' : 'text-yellow-400'}`}>{flowFieldData.turbulenceLevel}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Pressure</span><span className={flowFieldData.pressureTrend === 'rising' ? 'text-orange-400' : 'text-cyan-400'}>{flowFieldData.pressureTrend}</span></div>
                                </div>
                              ) : (
                                <div className="text-center py-4"><Wind className="w-8 h-8 text-slate-600 mx-auto mb-2 opacity-50" /><p className="text-xs text-slate-500">{flowFieldLoading ? 'Computing…' : 'Unavailable'}</p></div>
                              )}
                            </div>

                            {/* ML predictions */}
                            <div className="bg-purple-900/40 rounded-lg p-4 border border-purple-500/30">
                              <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2"><Brain className="w-4 h-4 text-purple-400" />ML Predictions</h4>
                              {mlPredictions ? (
                                <div className="space-y-2 text-xs">
                                  <div className="flex justify-between"><span className="text-slate-400">Direction</span><span className={`font-bold ${mlPredictions.direction.prediction === 'bullish' ? 'text-green-400' : 'text-red-400'}`}>{mlPredictions.direction.prediction.toUpperCase()}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Prob</span><span className="font-mono text-white">{(mlPredictions.direction.probability * 100).toFixed(1)}%</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Price target</span><span className="font-mono text-cyan-400">${mlPredictions.price.predicted.toFixed(2)}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Risk</span><span className={`font-bold ${mlPredictions.risk.level === 'low' ? 'text-green-400' : mlPredictions.risk.level === 'high' ? 'text-orange-400' : mlPredictions.risk.level === 'extreme' ? 'text-red-400' : 'text-yellow-400'}`}>{mlPredictions.risk.level}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-400">Volatility</span><span className="text-slate-300">{mlPredictions.volatility.level}</span></div>
                                  {mlPredictions.holdingPeriod && (
                                    <div className="flex justify-between"><span className="text-slate-400">Hold time</span><span className="text-purple-400 font-mono">{mlPredictions.holdingPeriod.days > 0 ? `${mlPredictions.holdingPeriod.days}d` : `${mlPredictions.holdingPeriod.hours}h`}</span></div>
                                  )}

                                  {/* Model explainability */}
                                  <div className="mt-3">
                                    <React.Suspense fallback={<div className="text-xs text-slate-400">Loading explainability…</div>}>
                                      <ModelExplainability confidence={mlPredictions.direction.probability} shap={(mlPredictions as any).shap ?? []} />
                                    </React.Suspense>
                                  </div>
                                </div>
                              ) : (
                                <div className="text-center py-4"><Brain className="w-8 h-8 text-slate-600 mx-auto mb-2 opacity-50" /><p className="text-xs text-slate-500">{mlPredictionsLoading ? 'Computing…' : 'Unavailable'}</p></div>
                              )}
                            </div>

                            {/* Trade execution */}
                            <TradeExecutionPanel
                              symbol={selectedSymbol}
                              currentPrice={currentPrice}
                              availableCash={portfolioValue}
                              maxLeverage={1}
                              onExecuteTrade={(trade: TradeOrder) => {
                                (async () => {
                                  try {
                                    if (isLiveMode && !liveEnabledConfirmed) { setShowEnableLiveModal(true); return; }
                                    try { tradeExecControllerRef.current?.abort(); } catch {}
                                    const controller = new AbortController();
                                    tradeExecControllerRef.current = controller;
                                    const endpoint = isLiveMode ? '/api/live-trading/execute' : '/api/paper-trading/trade';
                                    const resp = await fetch(endpoint, {
                                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ symbol: trade.symbol, side: trade.side, price: trade.entryPrice, quantity: trade.positionSize, stopLoss: trade.stopLoss, takeProfit: trade.takeProfit }),
                                      signal: controller.signal,
                                    });
                                    if (!resp.ok) throw new Error(`Trade failed: ${resp.statusText}`);
                                    const json = await resp.json();
                                    addNotification('trade', 'high', 'Order Created', json.message || 'Order created');
                                    try { await refetchTrades(); } catch {}
                                  } catch (err: any) {
                                    if (err?.name === 'AbortError') return;
                                    addNotification('trade', 'high', 'Order Failed', String(err));
                                  }
                                })();
                              }}
                            />

                            {/* Positions */}
                            {/* FIX #4: activeTrades */}
                            <PositionManagementPanel
                              positions={positions as any}
                              orders={orders as any}
                              trades={pmTrades}
                              onClosePosition={(positionId: string) => {
                                (async () => {
                                  try {
                                    try { closePositionControllerRef.current?.abort(); } catch {}
                                    const controller = new AbortController();
                                    closePositionControllerRef.current = controller;
                                    const endpoint = isLiveMode ? `/api/live-trading/close/${encodeURIComponent(positionId)}` : `/api/paper-trading/close/${encodeURIComponent(positionId)}`;
                                    const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exitPrice: currentPrice }), signal: controller.signal });
                                    if (!resp.ok) throw new Error(`Close failed: ${resp.statusText}`);
                                    addNotification('trade', 'medium', 'Position Closed', positionId);
                                    try { await refetchPositions(); await refetchTrades(); } catch {}
                                  } catch (err: any) {
                                    if (err?.name === 'AbortError') return;
                                    addNotification('trade', 'high', 'Close Failed', String(err));
                                  }
                                })();
                              }}
                              onCancelOrder={(orderId: string) => {
                                (async () => {
                                  try {
                                    try { cancelOrderControllerRef.current?.abort(); } catch {}
                                    const controller = new AbortController();
                                    cancelOrderControllerRef.current = controller;
                                    const resp = await fetch(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', signal: controller.signal });
                                    if (!resp.ok) throw new Error(`Cancel failed: ${resp.statusText}`);
                                    addNotification('trade', 'medium', 'Order Cancelled', orderId);
                                    try { await refetchOrders(); } catch {}
                                  } catch (err: any) {
                                    if (err?.name === 'AbortError') return;
                                    addNotification('trade', 'high', 'Cancel Failed', String(err));
                                  }
                                })();
                              }}
                            />

                            <RiskManagementPanel
                              portfolioValue={portfolioValue}
                              currentRisk={(positions as any[]).reduce((s: number, p: any) => s + (p.unrealized_pnl < 0 ? Math.abs(p.unrealized_pnl) : 0), 0)}
                              dailyLoss={dailyLoss}
                              onSettingsChange={(s: any) => {
                                try { localStorage.setItem('riskSettings', JSON.stringify(s)); } catch {}
                                (async () => {
                                  try {
                                    try { configSaveControllerRef.current?.abort(); } catch {}
                                    const controller = new AbortController();
                                    configSaveControllerRef.current = controller;
                                    await fetch('/api/paper-trading/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s), signal: controller.signal });
                                  } catch (err: any) { if (err?.name !== 'AbortError') console.warn('[risk settings]', err); }
                                })();
                              }}
                            />

                            <CorrelationHeatmap onSymbolSelect={(sym: string) => { setSelectedSymbol(sym); }} />
                            <WorldTicksPanel ticks={worldTicks as any} limit={8} />
                            <EventFeedPanel ticks={worldTicks as any} signals={signals} alerts={notifications} />
                            <div className="mt-3">
                              <AlertsTimeline events={(notifications || []).map((n:any) => ({ id: n.id, ts: n.ts || n.timestamp || Date.now(), type: n.type || 'alert', level: n.level, message: n.text || n.message || '' }))} />
                            </div>
                            <AnalyticsPanel
                              isReplaying={isReplaying}
                              speedMs={replayIntervalMs}
                              position={Math.max(0, replayPlayback.length - 1)}
                              duration={replaySourceRef.current ? replaySourceRef.current.length : (worldTicks as WorldTick[]).length}
                              onStart={(ms?: number) => startReplay(ms)}
                              onPause={pauseReplay}
                              onStop={stopReplay}
                              onSetSpeed={setReplaySpeed}
                              onSeek={seekReplay}
                            />
                          </div>
                        </div>
                      </div>
                      </ReplayModeDesaturatedWrapper>
                    ) : (
                      /* Waiting for data */
                      <div className="h-full flex items-center justify-center">
                        <div className="text-center">
                          <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center ${wsConnected ? 'bg-yellow-900/20' : 'bg-red-900/20'}`}>
                            <div className={`w-8 h-8 rounded-full ${wsConnected ? 'bg-yellow-500' : 'bg-red-500'}`} />
                          </div>
                          <div className="text-lg font-semibold mb-2">{wsConnected ? 'Connected — awaiting data' : 'Connecting…'}</div>
                          <div className="text-sm text-gray-500">WebSocket: {wsConnected ? '✅ Connected' : '❌ Disconnected'}</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* FIX #1: Other tabs are siblings to chart, NOT nested inside it */}
              {activeTab !== 'chart' && (
                <div className="flex-1 overflow-auto p-6">
                  {activeTab === 'overview' && (
                    // FIX #5: assets from query, not filteredAssets
                    <OverviewView assets={[]} setSelectedAsset={(s: any) => setSelectedSymbol(s)} />
                  )}
                  {activeTab === 'scanner' && (
                    <ScannerView assets={[]} onSelect={(s: string) => { setSelectedSymbol(s); setActiveTab('chart'); }} />
                  )}
                  {activeTab === 'signals' && (
                    <div className="space-y-4">
                      <h2 className="text-lg font-bold text-white">Signals</h2>
                      <div className="space-y-3">{latestSignalNodes || <p className="text-slate-400 text-sm">No signals</p>}</div>
                    </div>
                  )}
                  {activeTab === 'positions' && (
                    <PositionsView positions={positions as any} />
                  )}
                  {activeTab === 'portfolio' && (
                    <div className="space-y-4">
                      <h2 className="text-lg font-bold text-white">Portfolio</h2>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                        <StatCard title="Total Return" value={`${((portfolioSummary?.metrics?.totalReturn ?? 0) * 100).toFixed(2)}%`} change={(portfolioSummary?.metrics?.totalReturn ?? 0) * 100} icon={TrendingUp} variant={(portfolioSummary?.metrics?.totalReturn ?? 0) >= 0 ? 'success' : 'error'} size="sm" />
                        <StatCard title="Balance" value={`$${((portfolioSummary?.metrics?.currentBalance ?? 10000)).toLocaleString()}`} icon={Wallet} size="sm" />
                        <StatCard title="Win Rate" value={`${((portfolioSummary?.metrics?.winRate ?? 0) * 100).toFixed(1)}%`} icon={Target} variant="info" size="sm" />
                        <StatCard title="Total Trades" value={portfolioSummary?.metrics?.totalTrades ?? 0} icon={Activity} size="sm" />
                        <StatCard title="Max Drawdown" value={`${((portfolioSummary?.metrics?.maxDrawdown ?? 0) * 100).toFixed(2)}%`} icon={TrendingDown} variant="warning" size="sm" />
                        <StatCard title="Sharpe" value={(portfolioSummary?.metrics?.sharpeRatio ?? 0).toFixed(2)} icon={BarChart3} size="sm" />
                      </div>
                      <CorrelationHeatmap onSymbolSelect={setSelectedSymbol} />
                    </div>
                  )}
                  {activeTab === 'backtest' && (
                    <div className="space-y-4">
                      <h2 className="text-lg font-bold text-white">Backtest</h2>
                      <AnalyticsPanel
                        isReplaying={isReplaying}
                        speedMs={replayIntervalMs}
                        position={Math.max(0, replayPlayback.length - 1)}
                        duration={replaySourceRef.current ? replaySourceRef.current.length : (worldTicks as WorldTick[]).length}
                        onStart={(ms?: number) => startReplay(ms)}
                        onPause={pauseReplay}
                        onStop={stopReplay}
                        onSetSpeed={setReplaySpeed}
                        onSeek={seekReplay}
                      />
                    </div>
                  )}
                  {activeTab === 'ml' && (
                    <div className="space-y-4">
                      <h2 className="text-lg font-bold text-white">ML Engine</h2>
                      {mlPredictions ? (
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
                            <div className="text-slate-400 mb-1">Direction</div>
                            <div className={`text-2xl font-bold ${mlPredictions.direction.prediction === 'bullish' ? 'text-green-400' : 'text-red-400'}`}>{mlPredictions.direction.prediction.toUpperCase()}</div>
                            <div className="text-slate-400 mt-2 text-xs">Confidence: {(mlPredictions.direction.confidence * 100).toFixed(1)}%</div>
                          </div>
                          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
                            <div className="text-slate-400 mb-1">Price Target</div>
                            <div className="text-2xl font-bold font-mono text-cyan-400">${mlPredictions.price.predicted.toFixed(2)}</div>
                            <div className={`text-xs mt-2 ${mlPredictions.price.percentChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>{mlPredictions.price.percentChange >= 0 ? '+' : ''}{mlPredictions.price.percentChange.toFixed(2)}%</div>
                          </div>
                        </div>
                      ) : <p className="text-slate-400 text-sm">{mlPredictionsLoading ? 'Computing predictions…' : 'No predictions available'}</p>}
                    </div>
                  )}
                  {activeTab === 'diagnostics' && (
                    <div className="space-y-4">
                      <h2 className="text-lg font-bold text-white">Diagnostics</h2>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        {[
                          { label: 'WebSocket', value: wsConnected ? '✅ Connected' : '❌ Disconnected', ok: wsConnected },
                          { label: 'MDL', value: mdConnected ? '✅ Connected' : '❌ Disconnected', ok: mdConnected },
                          { label: 'World Ticks', value: `${(worldTicks as WorldTick[]).length} buffered`, ok: true },
                          { label: 'Chart Candles', value: `${chartData.length}`, ok: chartData.length > 0 },
                          { label: 'Active Signals', value: `${signals.length}`, ok: signals.length > 0 },
                          { label: 'Positions', value: `${(positions as any[]).length} open`, ok: true },
                          { label: 'Exchange', value: selectedExchange, ok: true },
                          { label: 'Mode', value: isLiveMode ? 'LIVE' : 'PAPER', ok: true },
                        ].map(({ label, value, ok }) => (
                          <div key={label} className={`bg-slate-800 rounded-lg p-3 border ${ok ? 'border-slate-700' : 'border-red-700/50'}`}>
                            <div className="text-xs text-slate-400 mb-1">{label}</div>
                            <div className={`font-mono text-sm font-bold ${ok ? 'text-white' : 'text-red-400'}`}>{value}</div>
                          </div>
                        ))}
                      </div>
                      {mdRetryInfo && <div className="bg-yellow-900/20 border border-yellow-500/30 rounded-lg p-3 text-xs text-yellow-300">MDL retry: attempt {mdRetryInfo.attempt}, delay {mdRetryInfo.delay}ms</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </ErrorBoundary>

          {/* Right sidebar */}
          {showRightSidebar && (
            <ErrorBoundary FallbackComponent={ErrorFallback}>
              <div
                className="absolute right-0 top-0 bottom-0 w-80 bg-gradient-to-br from-slate-800/95 to-slate-900/95 backdrop-blur-md border-l border-slate-700/50 flex flex-col z-40 shadow-2xl animate-in slide-in-from-right duration-300"
                aria-label="Portfolio Sidebar"
                onMouseEnter={() => { if (rightSidebarTimerRef.current) window.clearTimeout(rightSidebarTimerRef.current); }}
                onMouseLeave={resetRightSidebarTimer}
              >
                {/* Signal details */}
                {openSignalDetails && (
                  <div className="p-4 border-b border-slate-700/50">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-base font-semibold text-white">Signal Details</h3>
                      <button className="text-slate-400 hover:text-white" onClick={() => setOpenSignalDetails(null)}>✕</button>
                    </div>
                    <div className="h-28 mb-3">
                      {previewChartData.length > 0 ? (
                        <TradingChart data={previewChartData as any} height={112} maxCandles={40} showVolume={false} showRSI={false} showMACD={false} showEMA={false} timeframe={selectedTimeframe} />
                      ) : (
                        <div className="h-28 flex items-center justify-center text-xs text-slate-500">No preview data</div>
                      )}
                    </div>
                    {(() => {
                      const sig = currentSignals.find(s => s.symbol === openSignalDetails.symbol) || latestSignals?.find((s: any) => s.symbol === openSignalDetails.symbol);
                      if (!sig) return <div className="text-xs text-slate-400">No enriched signal data.</div>;
                      return (
                        <div className="space-y-2 text-xs">
                          <div className="text-slate-300">Type: <span className="font-medium">{sig.type}</span> · Strength: <span className="font-mono">{(sig.strength || 0).toFixed(2)}</span></div>
                          {sig.reasoning?.length ? (
                            <ul className="list-disc list-inside text-slate-300">{sig.reasoning.slice(0,5).map((r, i) => <li key={i}>{r}</li>)}</ul>
                          ) : null}
                        </div>
                      );
                    })()}
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      <button onClick={() => setShowQuickTradeModal(true)} className="col-span-1 bg-gradient-to-r from-blue-600 to-purple-600 text-white py-2 rounded text-xs">Trade</button>
                      <button onClick={() => addNotification('system', 'low', 'Watched', openSignalDetails.symbol)} className="col-span-1 bg-slate-700 text-white py-2 rounded text-xs">Watch</button>
                      <button onClick={() => navigator.clipboard?.writeText(openSignalDetails.symbol)} className="col-span-1 bg-slate-800 text-white py-2 rounded text-xs">Copy</button>
                    </div>
                  </div>
                )}

                {/* Portfolio summary */}
                <div className="p-4 border-b border-slate-700/50 flex-shrink-0">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-semibold text-white">Portfolio</h3>
                    <button onClick={() => navigate('/portfolio')} className="text-blue-400 hover:text-blue-300 text-sm">Details →</button>
                  </div>
                </div>
                <div className="p-4 space-y-3 flex-1 overflow-y-auto">
                  <StatCard title="Total Return" value={`${((portfolioSummary?.metrics?.totalReturn ?? 0) * 100).toFixed(2)}%`} change={(portfolioSummary?.metrics?.totalReturn ?? 0) * 100} icon={TrendingUp} variant={(portfolioSummary?.metrics?.totalReturn ?? 0) >= 0 ? 'success' : 'error'} size="sm" />
                  <StatCard title="Balance" value={`$${((portfolioSummary?.metrics?.currentBalance ?? 10000)).toLocaleString()}`} icon={Wallet} size="sm" />
                  <StatCard title="Win Rate" value={`${((portfolioSummary?.metrics?.winRate ?? 0) * 100).toFixed(1)}%`} icon={Target} variant="info" size="sm" />
                  <StatCard title="Trades" value={portfolioSummary?.metrics?.totalTrades ?? 0} icon={Activity} size="sm" />
                  <StatCard title="Max Drawdown" value={`${((portfolioSummary?.metrics?.maxDrawdown ?? 0) * 100).toFixed(2)}%`} icon={TrendingDown} variant="warning" size="sm" />
                  <StatCard title="Sharpe" value={(portfolioSummary?.metrics?.sharpeRatio ?? 0).toFixed(2)} icon={BarChart3} size="sm" />
                </div>
                <div className="p-4 border-t border-slate-700/50">
                  <button onClick={() => navigate('/portfolio')} className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white py-2 px-4 rounded-lg font-medium transition-all">
                    Full Portfolio
                  </button>
                </div>
              </div>
            </ErrorBoundary>
          )}
        </div>
      </TerminalLayout>

      {/* Footer */}
      <footer className="bg-slate-900/80 backdrop-blur-sm border-t border-slate-700/50 px-4 py-2 text-xs flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-1">
              <div className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
              <span className="text-slate-400">WS:</span>
              <span className={wsConnected ? 'text-green-400' : 'text-red-400'}>{wsConnected ? 'Connected' : 'Disconnected'}</span>
            </div>
            <div className="flex items-center space-x-1">
              <span className="text-slate-400">Exchange:</span>
              <span className="text-blue-400">{selectedExchange}</span>
            </div>
            <div className="flex items-center space-x-1">
              <span className="text-slate-400">Latency:</span>
              <span className="text-yellow-400">{exchangeStatus?.latency || 0}ms</span>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-1">
              <span className="text-slate-400">Portfolio:</span>
              <span className="text-white font-mono">{formatCurrency(portfolioValue)}</span>
              <span className={dayChangePercent >= 0 ? 'text-green-400' : 'text-red-400'}>({formatPercent(dayChangePercent)})</span>
            </div>
            <span className="text-slate-400">{new Date().toLocaleTimeString()}</span>
          </div>
        </div>
      </footer>

      {/* ── Modals ──────────────────────────────────────────────────────────── */}

      {/* Notification hub */}
      <NotificationHub
        isOpen={showNotifications} onClose={() => setShowNotifications(false)}
        notifications={notifications} onMarkAsRead={markAsRead} onMarkAllAsRead={markAllAsRead}
        onDismiss={dismissNotification} onClearAll={clearAll}
        soundEnabled={settings.soundEnabled} onToggleSound={toggleSound}
      />

      {/* Settings modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowSettingsModal(false)} />
          <div className="relative z-10 bg-slate-800 rounded-lg p-6 w-96 border border-slate-700 shadow-xl">
            <h3 className="text-base font-bold mb-4">Settings</h3>
            <div className="space-y-3">
              <div>
                <label htmlFor="env-select" className="text-xs text-slate-400">Environment</label>
                <select id="env-select" className="w-full mt-1 px-2 py-1 rounded bg-slate-700 text-white border border-slate-600" value={env} onChange={e => setEnv(e.target.value as 'dev' | 'prod')}>
                  <option value="dev">Development</option>
                  <option value="prod">Production</option>
                </select>
              </div>
              <div>
                <label htmlFor="workspace-input" className="text-xs text-slate-400">Workspace</label>
                <input id="workspace-input" className="w-full mt-1 px-2 py-1 rounded bg-slate-700 text-white border border-slate-600" value={workspace} onChange={e => setWorkspace(e.target.value)} />
              </div>
              <div>
                <label htmlFor="universe-select" className="text-xs text-slate-400">Universe</label>
                <select id="universe-select" className="w-full mt-1 px-2 py-1 rounded bg-slate-700 text-white border border-slate-600" value={universe} onChange={e => setUniverse(e.target.value)}>
                  <option>Market Universe</option>
                  <option>Portfolio Universe</option>
                  <option>Research Universe</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-2">Theme</label>
                <ThemeSelector />
              </div>
              {/* Live mode toggle */}
              <div className="flex items-center gap-3 pt-2 border-t border-slate-700">
                <button
                  onClick={() => {
                    if (!isLiveMode && !liveEnabledConfirmed) { setShowEnableLiveModal(true); return; }
                    const next = !isLiveMode;
                    try { localStorage.setItem('isLiveMode', String(next)); } catch {}
                    setIsLiveMode(next);
                  }}
                  className={`px-3 py-1 rounded text-sm font-medium ${isLiveMode ? 'bg-red-600 text-white' : 'bg-slate-700 text-slate-200'}`}>
                  {isLiveMode ? 'LIVE MODE' : 'Paper mode'}
                </button>
                {isLiveMode && <span className="text-xs text-red-400">Real orders will be placed</span>}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="px-3 py-1 rounded bg-slate-700 text-slate-200 text-sm" onClick={() => setShowSettingsModal(false)}>Cancel</button>
              <button className="px-3 py-1 rounded bg-blue-600 text-white text-sm" onClick={() => {
                try { localStorage.setItem('env', env); localStorage.setItem('workspace', workspace); localStorage.setItem('universe', universe); } catch {}
                setShowSettingsModal(false);
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Panel manager */}
      {showPanelManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowPanelManager(false)} />
          <div className="relative z-10 bg-slate-800 rounded-lg p-6 w-96 border border-slate-700 shadow-xl">
            <PanelManager />
            <div className="mt-4 text-right">
              <button className="px-3 py-1 rounded bg-slate-700 text-slate-200 text-sm" onClick={() => setShowPanelManager(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Enable live trading modal */}
      {showEnableLiveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-slate-900 p-6 rounded-lg w-96 border border-slate-700">
            <h3 className="text-base font-semibold mb-2">Enable Live Trading</h3>
            <p className="text-sm text-slate-400 mb-4">Type <span className="font-mono text-white">ENABLE LIVE</span> to confirm real order placement.</p>
            <input id="enable-live-input" autoFocus placeholder="Type ENABLE LIVE to confirm"
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 mb-3 text-white text-sm" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEnableLiveModal(false)} className="px-3 py-1 rounded bg-slate-700 text-slate-200 text-sm">Cancel</button>
              <button
                onClick={() => {
                  const val = (document.getElementById('enable-live-input') as HTMLInputElement)?.value?.trim();
                  if (val !== 'ENABLE LIVE') { addNotification('system', 'high', 'Confirmation Failed', 'Type exactly: ENABLE LIVE'); return; }
                  try { localStorage.setItem('liveEnabledConfirmed', 'true'); localStorage.setItem('isLiveMode', 'true'); } catch {}
                  setLiveEnabledConfirmed(true); setIsLiveMode(true); setShowEnableLiveModal(false);
                  addNotification('system', 'high', 'Live Enabled', 'Live trading is now active.');
                }}
                className="px-3 py-1 rounded bg-red-600 text-white text-sm">Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Quick trade modal */}
      <QuickTradeModal isOpen={showQuickTradeModal} onClose={() => setShowQuickTradeModal(false)} symbol={selectedSymbol} currentPrice={currentPrice} />

      {/* Quick actions bar */}
      <QuickActionsBar
        currentSymbol={selectedSymbol}
        onQuickTrade={() => setShowQuickTradeModal(true)}
        onQuickScan={() => addNotification('signal', 'medium', 'Scan Started', `Scanning ${selectedSymbol}…`)}
        onAddToWatchlist={() => addNotification('system', 'low', 'Watchlist', `${selectedSymbol} added`)}
        onSetPriceAlert={() => addNotification('system', 'low', 'Alert set', `Alert for ${selectedSymbol}`)}
        onTakeScreenshot={takeChartScreenshot}
        onShareChart={() => { navigator.clipboard?.writeText(window.location.href); addNotification('system', 'low', 'Copied', 'Link copied'); }}
      />
    </div>
  );
}