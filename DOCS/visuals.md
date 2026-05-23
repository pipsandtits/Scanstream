# Visuals & Charts Audit

Summary: inventory of visualization components, libraries used, data sources, and where they're implemented.

## Libraries used
- react-apexcharts: main candlestick chart (dynamic import in TradingChart)
- recharts: bar/pie charts (AdaptiveHoldingChartsImpl, some widgets)
- d3: FlowField vector field visualizer (FlowFieldVisualizer)
- Custom SVG / CSS: small sparklines, vote bars, volume profile, clustering bars
- lucide-react: icons used throughout

## Core components
- **TradingChart**: candlestick chart with EMA/RSI/MACD, annotations (pattern detector). Uses dynamic import of `react-apexcharts`. File: [client/src/components/TradingChart.tsx](client/src/components/TradingChart.tsx)
  - Data props: `data: ChartDataPoint[]` (timestamp, open, high, low, close, volume, rsi, macd, ema)
  - Features: candlesticks, EMA line, volume column, RSI/MACD subcharts, pattern annotations, tooltip, hover callbacks
  - Data sources: `marketData` frames, `gatewayOHLCV`, `coinGeckoChartData` (see usage in `trading-terminal.tsx`)

- **FlowFieldVisualizer**: D3-based force/pressure/turbulence vector field. File: [client/src/components/FlowFieldVisualizer.tsx](client/src/components/FlowFieldVisualizer.tsx)
  - Data props: `FlowFieldData` (forceVectors, latestForce, pressure, turbulence, dominantDirection, etc.)
  - Features: pressure gradient background, force vectors as arrows, hover details, metric cards
  - Library: d3 (full SVG rendering)
  - Data source: `/api/analytics/flow-field` (queried in `trading-terminal.tsx`)

- **AdaptiveHoldingChartsImpl**: Recharts bar + pie visualizations. File: [client/src/components/AdaptiveHoldingChartsImpl.tsx](client/src/components/AdaptiveHoldingChartsImpl.tsx)
  - Used by `AdaptiveHoldingPanel` (lazy-loaded)
  - Library: recharts (ResponsiveContainer, BarChart, PieChart)

- **Sparkline** (dashboard helpers): tiny inline SVG path generator. File: [client/src/pages/dashboardHelpers.tsx](client/src/pages/dashboardHelpers.tsx)
  - Data: `asset` object (history or price/priceChange)
  - No external libs, simple SVG path for small inline charts

- **VolumeProfile**: div-based bars and historical bar chart (no external chart lib for profile; uses stylized divs). File: [client/src/components/VolumeProfile.tsx](client/src/components/VolumeProfile.tsx)
  - Shows buy/sell split by price level and simple historical bars
  - Data: derived from `symbols` / `selectedSymbol` (mock or API-backed)

- **AgentClusteringPanel**: cluster metrics, confidence bars and tables (CSS-driven). File: [client/src/components/AgentClusteringPanel.tsx](client/src/components/AgentClusteringPanel.tsx)
  - Visuals: progress/confidence bars, metric cards, cluster tables
  - Data source: `/api/backtest/agent-clustering/*`

- **VelocityProfilePanel**, **AdaptiveHoldingPanel**: UI panels that include metric cards, distribution bars and lazy-loaded charts (Recharts). Files:
  - [client/src/components/VelocityProfilePanel.tsx](client/src/components/VelocityProfilePanel.tsx)
  - [client/src/components/AdaptiveHoldingPanel.tsx](client/src/components/AdaptiveHoldingPanel.tsx)

- Widget-level placeholders / mini-charts (ChartWidget, SignalsWidget, etc.) use simple icons or small div/SVG visuals. Files:
  - [client/src/components/widgets/ChartWidget.tsx](client/src/components/widgets/ChartWidget.tsx)
  - [client/src/components/widgets/SignalsWidget.tsx](client/src/components/widgets/SignalsWidget.tsx)

## Data flows and sources
- Live tick & OHLC sources: `marketData` (client-side MDL), `worldTicks`, `gatewayOHLCV` (WebSocket-populated), and REST endpoints (`/api/gateway/*`, `/api/ml/predictions`, `/api/analytics/*`). See usage in [client/src/pages/trading-terminal.tsx](client/src/pages/trading-terminal.tsx).
- Many panels call analytics endpoints (`/api/analytics/*`, `/api/backtest/*`) which supply processed arrays suitable for charts.

## Recommendations / next steps
- Standardize chart data shape: prefer `ChartDataPoint` (timestamp, open, high, low, close, volume, rsi, macd, ema) across back-end endpoints to simplify reusability.
- Consolidate small charts (sparklines, mini-bars) into a shared `ui` component set for consistent styling and easier testing.
- Consider replacing dynamic `react-apexcharts` import with a wrapper component that abstracts initialization and fallback behavior.
- Add storybook or a `docs/visuals.md` (this file) plus small examples for each visual with sample payloads for QA.

---
This file was generated automatically by a repo audit. Ask me to expand any component's documentation with prop tables, sample data, or screenshot guidance.

## New prototype components added

- `EquityCurve` — area chart with drawdown overlay. File: [client/src/components/visuals/EquityCurve.tsx](client/src/components/visuals/EquityCurve.tsx)
  - Props: `data: { timestamp:number; equity:number }[]`, `height`.
  - Use: show portfolio or agent equity over time with drawdown shading.

- `OrderbookDepth` — simple cumulative bids/asks depth view. File: [client/src/components/visuals/OrderbookDepth.tsx](client/src/components/visuals/OrderbookDepth.tsx)
  - Props: `bids`, `asks` arrays of `{ price, size }`.
  - Use: quick liquidity snapshot in side panels.

- `ModelExplainability` — confidence strip and top-SHAP bars. File: [client/src/components/visuals/ModelExplainability.tsx](client/src/components/visuals/ModelExplainability.tsx)
  - Props: `confidence: number (0-1)`, `shap: {feature:string; value:number}[]`.
  - Use: surface quick ML explainability next to signals.

### Quick usage examples

Equity curve (React):

<pre>
import EquityCurve from '@/components/visuals/EquityCurve';
<EquityCurve data={sampleEquity} height={240} />
</pre>

Orderbook depth:

<pre>
import OrderbookDepth from '@/components/visuals/OrderbookDepth';
<OrderbookDepth bids={topBids} asks={topAsks} />
</pre>

Model explainability:

<pre>
import ModelExplainability from '@/components/visuals/ModelExplainability';
<ModelExplainability confidence={0.82} shap={sampleShap} />
</pre>
