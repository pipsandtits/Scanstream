import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { queryClient } from "./lib/queryClient";
import { NotificationProvider } from "./contexts/NotificationContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { PreferencesProvider } from "./contexts/PreferencesContext";
import { RealtimeProvider } from "./contexts/RealtimeContext";
import { useAuth } from "./hooks/useAuth";

// ── Eager imports ────────────────────────────────────────────────────────────
import AppLayout from "./components/AppLayout";
import RealtimeEventFeed from "@/components/RealtimeEventFeed";
import CommanderDashboard from "@/components/CommanderDashboard";

import DashboardPage from "@/pages/dashboard";
const TradingTerminal = lazy(() => import("@/pages/trading-terminal"));
const PortfolioPage = lazy(() => import("@/pages/portfolio"));
import ScannerPage from "@/pages/scanner";
import GatewayScannerPage from "@/pages/gateway-scanner";
import BacktestPage from "@/pages/backtest";
import MLEnginePage from "@/pages/ml-engine";
import MLTrainingHub from "@/pages/ml-training-hub";
import MultiTimeframePage from "@/pages/multi-timeframe";
import FlowFieldPage from "@/pages/flow-field";
import FlowEnginePage from "./pages/flow-engine";
import StrategiesPage from "@/pages/strategies";
import MarketIntelligence from "@/pages/market-intelligence";
import StrategySynthesisPage from "./pages/strategy-synthesis";
import AnalyticsDashboard from "@/pages/analytics-dashboard";
import PositionSizingDashboard from "./pages/position-sizing-dashboard";
import PositionsPage from "@/pages/positions";
import SignalsPage from "@/pages/signals";
import AgentInteractionDashboard from "@/pages/agent-interactions";
import AgentSignalInsightsDashboard from "@/pages/agent-signal-insights";
import SignalStructuresPage from "@/pages/signal-structures";
import SymbolUniversePage from "@/pages/symbol-universe";
import SignalPerformance from "./pages/signal-performance";
import ScoutReportsPage from "./pages/scout-reports";
import ScoutReportPage from "./pages/scout-report";
import OrderPage from "./pages/orders/[orderId]";
import SettingsPage from "@/pages/settings";
import ProfilePage from "@/pages/profile";
import WatchlistPage from "@/pages/watchlist";
import GatewayAlertsPage from "@/pages/gateway-alerts";
import AdminAPIDocsPanel from "@/pages/AdminAPIDocsPanel";
import AgentRosterPage from "@/pages/agent-roster";
import AgentDetailPage from "@/pages/agent-detail";
import AgentLeaderboardPage from "@/pages/agent-leaderboard";
import AchievementTrackerPage from "@/pages/achievement-tracker";
import ComboActivityPage from "@/pages/combo-activity";
import RealtimeUpdatesPage from "@/pages/realtime-updates";
import MetricsDashboard from "@/pages/metrics-dashboard";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";

// ── Lazy imports ─────────────────────────────────────────────────────────────
const OptimizePage          = lazy(() => import("@/pages/optimize"));
const AdvancedAnalytics     = lazy(() => import("@/pages/advanced-analytics"));
const RLPositionAgent       = lazy(() => import("./pages/rl-position-agent"));
const PaperTradingPage      = lazy(() => import("@/pages/paper-trading"));
const LearningCenter        = lazy(() => import("@/pages/learning-center"));
const AgentArenaPage        = lazy(() => import("@/pages/agent-arena-hub"));

// ── Routers ──────────────────────────────────────────────────────────────────

function AuthenticatedRouter() {
  return (
    <RealtimeProvider>
      <AppLayout>
        <Routes>
          {/* Redirect logged-in users away from auth pages */}
          <Route path="/login"    element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />

          <Route path="/"                         element={<DashboardPage />} />
          <Route path="/trading-terminal"         element={<TradingTerminal />} />
          <Route path="/signals"                  element={<SignalsPage />} />
          <Route path="/signal-structures"        element={<SignalStructuresPage />} />
          <Route path="/positions"                element={<PositionsPage />} />
          <Route path="/portfolio"                element={<PortfolioPage />} />
          <Route path="/scanner"                  element={<ScannerPage />} />
          <Route path="/gateway-scanner"          element={<GatewayScannerPage />} />
          <Route path="/backtest"                 element={<BacktestPage />} />
          <Route path="/ml-engine"                element={<MLEnginePage />} />
          <Route path="/ml-training"              element={<MLTrainingHub />} />
          <Route path="/multi-timeframe"          element={<MultiTimeframePage />} />
          <Route path="/flow-field"               element={<FlowFieldPage />} />
          <Route path="/flow-engine"              element={<FlowEnginePage />} />
          <Route path="/optimize"                 element={<OptimizePage />} />
          <Route path="/strategies"               element={<StrategiesPage />} />
          <Route path="/agent-arena-hub"          element={<AgentArenaPage />} />
          <Route path="/agent-roster"             element={<AgentRosterPage />} />
          <Route path="/agent-detail/:agentName"  element={<AgentDetailPage />} />
          <Route path="/agent-leaderboard"        element={<AgentLeaderboardPage />} />
          <Route path="/achievements"             element={<AchievementTrackerPage />} />
          <Route path="/combo-activity"           element={<ComboActivityPage />} />
          <Route path="/realtime-updates"         element={<RealtimeUpdatesPage />} />
          <Route path="/metrics-dashboard"        element={<MetricsDashboard />} />
          <Route path="/strategy-synthesis"       element={<StrategySynthesisPage />} />
          <Route path="/analytics"                element={<AnalyticsDashboard />} />
          <Route path="/advanced-analytics"       element={<AdvancedAnalytics />} />
          <Route path="/rl-position-agent"        element={<RLPositionAgent />} />
          <Route path="/position-sizing"          element={<PositionSizingDashboard />} />
          <Route path="/market-intelligence"      element={<MarketIntelligence />} />
          <Route path="/paper-trading"            element={<PaperTradingPage />} />
          <Route path="/agent-interactions"       element={<AgentInteractionDashboard />} />
          <Route path="/agent-signal-insights"    element={<AgentSignalInsightsDashboard />} />
          <Route path="/symbol-universe"          element={<SymbolUniversePage />} />
          <Route path="/signal-performance"       element={<SignalPerformance />} />
          <Route path="/learning-center"          element={<LearningCenter />} />
          <Route path="/scout-reports"            element={<ScoutReportsPage />} />
          <Route path="/scout-report/:symbol"     element={<ScoutReportPage />} />
          <Route path="/orders/:orderId"          element={<OrderPage />} />
          <Route path="/settings"                 element={<SettingsPage />} />
          <Route path="/profile"                  element={<ProfilePage />} />
          <Route path="/watchlist"                element={<WatchlistPage />} />
          <Route path="/gateway-alerts"           element={<GatewayAlertsPage />} />
          <Route path="/commander"                element={<CommanderDashboard />} />
          <Route path="/admin/api-docs"           element={<AdminAPIDocsPanel />} />
          <Route path="*"                         element={<NotFound />} />
        </Routes>

        <RealtimeEventFeed position="bottom-right" maxVisible={3} />
      </AppLayout>
    </RealtimeProvider>
  );
}

function UnauthenticatedRouter() {
  return (
    <Routes>
      <Route path="/login"    element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="*"         element={<LandingPage />} />
    </Routes>
  );
}

function AppRouter() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return isAuthenticated ? <AuthenticatedRouter /> : <UnauthenticatedRouter />;
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  useEffect(() => {
    const html = document.documentElement;
    const saved = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    html.classList.toggle("dark", saved === "dark" || (!saved && prefersDark));
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider>
        <ThemeProvider>
          <NotificationProvider>
            <TooltipProvider>
              <Toaster />
              <Suspense
                fallback={
                  <div className="min-h-screen flex items-center justify-center">
                    Loading…
                  </div>
                }
              >
                <AppRouter />
              </Suspense>
            </TooltipProvider>
          </NotificationProvider>
        </ThemeProvider>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}

export default App;