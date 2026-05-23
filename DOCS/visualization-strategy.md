# Visualization Strategy for Scanstream

**Goal:** Define a clear visualization system strategy that maps your data types to visualization patterns, recommends a single foundational approach, and gives an actionable migration plan to reduce bundle size and improve maintainability.

**Summary Recommendation**
- Foundation: Use **Recharts** as the core, shipped UI-facing visualization layer for first-load dashboards and product features.
- Research/Advanced: Use **D3 (lazy-loaded)** for research-grade, bespoke, experimental visuals (networks, physics fields, clustering, VFMD visuals).
- Rule: Anything needed on first load → Recharts. Anything analytical/deep/exploratory → lazy-load D3.

**Map: Data Types → Visualization Types → Implementation Notes**

- **A) Time-series (core trading data)**
  - Data: price, volume, indicators, PnL/equity curves
  - Charts: line charts, candlesticks, area charts, volume bars, overlays, multi-axis plots
  - Library: Recharts (core) + light, lazy helpers for custom overlays
  - Notes: Keep these in `ui-core` and render with Recharts primitives. Avoid importing D3 here.

- **B) Distribution / statistics**
  - Data: returns distribution, risk spread, win/loss ratios, feature importance
  - Charts: histograms, box plots, density plots, bar charts
  - Library: Recharts for standard histograms/bars; D3 lazy for density/advanced kernels
  - Notes: Use small reusable primitives (Histogram, BoxPlot) that accept raw data and compute bins server-/worker-side if large.

- **C) Relationships / structure**
  - Data: correlations, clustering, regime relationships, agent networks
  - Charts: heatmaps, network/graph layouts, scatter plots with clustering
  - Library: D3 (lazy-loaded). Recharts cannot handle complex force graphs or custom layouts effectively.
  - Notes: Bundle D3 and heavy layout code only into `research-lab` chunk.

- **D) System state / dashboards**
  - Data: agent status, live signals, execution health, small sparklines
  - Charts: sparklines, gauges, cards, mini-line charts
  - Library: Recharts (core) or tiny custom SVG components
  - Notes: Keep these extremely lightweight and synchronous for first-paint.

**Architecture Modules (recommended)**
- `ui-core` (always bundled)
  - Dashboard components, small charts (sparklines), layout primitives
  - Uses Recharts for visual rendering
- `visualization-engine` (split)
  - `vendor-charts` chunk for Recharts if shared widely
  - `research-lab` chunk (lazy) for D3 and heavy custom visual code
- `data-processing` (may be workerized)
  - Web workers / server-side transforms for histogram binning, aggregation, heavy math

**Practical Rules & Anti-patterns**
- Never import chart libraries from a shared component used on first load (e.g., avoid `import {LineChart} from 'recharts'` inside a `Header` or global layout).
- Do not include multiple chart engines in the main bundle (no Chart.js + ApexCharts + Recharts at once).
- Prefer dynamic imports for research visuals: `const D3 = await import('d3')` inside the component's effect.

**Migration Plan (step-by-step)**
1. Audit: list components importing `recharts`, `apexcharts`, `chart.js`, `d3` (we did a grep; `apexcharts` and `recharts` are frequent).
2. Decide foundation (we choose Recharts for core). Remove Chart.js/ApexCharts usages or replace by Recharts equivalents or lazy D3 implementations.
3. Consolidate chart primitives under `client/src/components/charts/*`:
   - `LineChartCore`, `Candlestick`, `Histogram`, `Sparkline`, `Gauge` (use Recharts)
4. Convert research pages/components to lazy modules and ensure they `import('d3')` locally.
5. Configure bundler: manualChunks to separate `recharts` vendor and `d3` vendor:
   - Example manualChunks mapping: `charts: ['recharts']`, `research: ['d3']`
6. Move heavy data transformations to worker or server where possible.
7. Measure: run visualizer to verify main chunk reduction and tune manualChunks.

**Code Patterns (examples)**
- Lazy-load a heavy page:

```tsx
const AdvancedAnalytics = React.lazy(() => import('@/pages/advanced-analytics'));

// inside page component, dynamic import a heavy lib only when needed
useEffect(() => {
  let mounted = true;
  async function init() {
    const d3 = await import('d3');
    if (!mounted) return;
    // build custom visualization with d3
  }
  init();
  return () => { mounted = false; };
}, []);
```

- Dynamic import inside a component for a chart library (keeps vendor out of main bundle):

```tsx
function HeavyGraph({ data }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const d3 = await import('d3');
      if (cancelled) return;
      // render into ref.current
    })();
    return () => { cancelled = true; };
  }, [data]);
  return <div ref={ref} />;
}
```

**Bundle & Vite tips**
- ManualChunks: create a `charts` vendor chunk for `recharts` and a `research` chunk for `d3`.
- Use `createChunk` or `manualChunks` mapping in `vite.config.ts`:
  - `manualChunks: { charts: ['recharts'], research: ['d3'] }`
- Avoid `optimizeDeps.include` including heavy libs unless needed at dev time.
- Consider `prefetch`/`preload` directives for pages you expect users to navigate to soon.

**Operational / Performance Measures**
- Key metrics to monitor: initial JS size, number of transformed modules, TTI, FCP, hydration time.
- Target: reduce initial JS by 40-60% by moving research visuals out of main bundle.

**Immediate Next Steps (priority)**
1. Replace in-place uses of `apexcharts` and `chart.js` with Recharts equivalents or mark them for removal.
2. Move all chart primitives into `client/src/components/charts/*` (Recharts-based).
3. Ensure all research visuals import `d3` only inside lazy modules (pages/components), and add `manualChunks` for `d3`.
4. Re-run build + visualizer and iterate.

**Estimated effort**
- Audit + centralize primitives: 1–2 days
- Replace or remove extra chart libs (ApexCharts/Chart.js): 1–2 days
- Implement lazy D3 pages + bundler tuning: 1–2 days

---

Created for Scanstream — use this as the canonical visualization strategy. For a follow-up I can:
- Produce a prioritized list of components to convert (component-level patch PRs), or
- Start converting `client/src/components/*` chart components to the `charts/` primitives and lazy-load D3 pages.

