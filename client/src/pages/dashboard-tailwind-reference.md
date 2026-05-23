# Dashboard Tailwind Reference — Scanstream

This document captures the design tokens, style intent, and recommended Tailwind utility mappings for the dashboard port from the original `qcmd` styling to Tailwind CSS.

Use this as the canonical reference when converting components across the app.

## Design Tokens (original CSS variables)
- Background: `--q-bg: #0a0c0f` → Tailwind: `bg-slate-900` or `bg-[#0a0c0f]`
- Surface: `--q-surface: #0f1217` → Tailwind: `bg-slate-800` or `bg-[#0f1217]`
- Border: `--q-border: rgba(255,255,255,0.07)` → Tailwind: `border-slate-700/30` or custom `border-[rgba(255,255,255,0.07)]`
- Text: `--q-text: #e2e8f0` → Tailwind: `text-slate-200` or `text-slate-100`
- Muted: `--q-muted: #64748b` → Tailwind: `text-slate-400`
- Hint: `--q-hint: #334155` → Tailwind: `text-slate-600`
- Accent: `--q-accent: #06b6d4` → Tailwind: `text-teal-400` / `text-cyan-400`
- Green: `--q-green: #10b981` → Tailwind: `text-emerald-500`
- Red: `--q-red: #ef4444` → Tailwind: `text-red-500`
- Amber: `--q-amber: #f59e0b` → Tailwind: `text-amber-400`
- Font: `--q-font: JetBrains Mono / Fira Code` → Tailwind: `font-mono`

## Layout primitives
- Root app container:
  - Tailwind: `min-h-screen bg-slate-900 text-slate-100 font-mono text-sm` (keeps compact UI scale)
- Top bar:
  - Tailwind: `flex items-center justify-between h-10 px-4 border-b border-slate-700 bg-slate-800`
- KPI row:
  - Tailwind: `grid grid-cols-6 border-b border-slate-700` with each cell `px-4 py-2`
- Watchlist / Sidebar column:
  - Tailwind: `w-[220px] border-r border-slate-700/40 flex flex-col`
- Center panel:
  - Tailwind: `flex-1 overflow-y-auto flex flex-col`

## Common UI patterns
- Small label (uppercase, muted): `text-xs tracking-widest text-slate-400 uppercase`
- Large numeric value (bold): `text-xl font-semibold`
- Small helper text: `text-xs text-slate-500`
- Icon button (subtle): `p-1 rounded border border-slate-700 text-slate-400 hover:text-slate-100`
- Accent button (long/short): `px-3 py-1 rounded border font-semibold` + color variants:
  - Long: `border-emerald-600 bg-emerald-600/10 text-emerald-300 hover:bg-emerald-600/20`
  - Short: `border-red-600 bg-red-600/10 text-red-300 hover:bg-red-600/20`

## Signals / chips
- Buy: `bg-emerald-600/10 text-emerald-300 border border-emerald-600/20 rounded px-1.5 py-0.5 text-xs font-semibold`
- Sell: `bg-red-600/10 text-red-300 border border-red-600/20 rounded px-1.5 py-0.5 text-xs font-semibold`
- Hold: `bg-amber-500/10 text-amber-300 border border-amber-500/20 rounded px-1.5 py-0.5 text-xs font-semibold`

## Error banner
- Tailwind: `flex items-center gap-3 bg-red-900/40 text-red-200 px-4 py-2 border-b border-red-800/50`

## Useful utility component map
- `.q-logo` → `text-sm font-semibold tracking-wider` and color for brand `text-teal-400` on accent span
- `.q-tabs` → `flex gap-1`
- `.q-kpi` → `px-4 py-3 border-r border-slate-700/40`

## Migration notes & strategy
1. Keep the original CSS injection while you migrate components incrementally — this prevents regressions and allows mixed-mode.
2. Replace root container class early so Tailwind utilities apply; keep original `.q-` classes until their components are fully converted.
3. For token parity, prefer Tailwind color tokens that are closest; for exact matches, use custom color utilities in Tailwind config (recommended later).
4. Convert layout first (root, topbar, KPI strip, main grid), then widget internals (watchlist rows, agents list, alerts). Test after each chunk.

## Example mapping (snippet)
Original:
```html
<div class="q-kpi-lbl">Open positions</div>
<div class="q-kpi-val">12</div>
```
Tailwind:
```html
<div class="text-xs tracking-widest text-slate-400 uppercase">Open positions</div>
<div class="text-xl font-semibold">12</div>
```

## Checklist for converting a component
- [ ] Replace container classes with Tailwind layout utilities
- [ ] Map colors to nearest Tailwind color token or add new token in `tailwind.config.ts`
- [ ] Replace any inline CSS variables usage with Tailwind equivalents or custom utilities
- [ ] Ensure responsive behavior using `sm`/`md`/`lg` breakpoints if needed
- [ ] Remove old `.q-`/`.qcmd` rules for the component once fully ported

---

If you'd like, I can now proceed to fully convert `client/src/pages/dashboard.tsx` to Tailwind using this mapping. Reply `convert now` to proceed, or `stepwise` to convert core layout first and widgets next.