import express from 'express';
import { systemKillSwitch } from './services/system-kill-switch';
import { liveTradingEngine } from './live-trading-engine';
import { portfolioRiskManager } from './services/portfolio-risk-manager';
// use dynamic require for optional prom-client
let client: any = null;
try { client = require('prom-client'); } catch (e) { client = null; console.warn('[admin-server] prom-client not installed, metrics disabled'); }

const app = express();
app.use(express.json());

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
function checkAuth(req: express.Request) {
  if (!ADMIN_SECRET) return true;
  const header = req.header('x-admin-secret') || '';
  return header === ADMIN_SECRET;
}

// Prometheus metrics
let register: any = null;
let killGauge: any = null;
let drawdownGauge: any = null;
let dailyLossGauge: any = null;
let exposureGauge: any = null;
if (client) {
  register = client.register;
  killGauge = new client.Gauge({ name: 'kill_switch_active', help: '1 if kill switch active' });
  drawdownGauge = new client.Gauge({ name: 'portfolio_drawdown_percent', help: 'Current portfolio drawdown percent' });
  dailyLossGauge = new client.Gauge({ name: 'portfolio_daily_loss_percent', help: 'Current daily loss percent' });
  exposureGauge = new client.Gauge({ name: 'portfolio_open_exposure_percent', help: 'Current open exposure percent' });

  // Update metrics periodically
  setInterval(() => {
    try {
      const ks = systemKillSwitch.getState();
      killGauge.set(ks.killed ? 1 : 0);

      // attempt to read portfolio metrics
      try {
        // Use current balance from last known or default
        const m = portfolioRiskManager.getPortfolioMetrics(portfolioRiskManager.getPortfolioMetrics(10000).totalValue);
        drawdownGauge.set(m.currentDrawdown || 0);
        dailyLossGauge.set(m.dailyPnlPercent || 0);
        exposureGauge.set(m.exposurePercent || 0);
      } catch (e) {
        drawdownGauge.set(0);
        dailyLossGauge.set(0);
        exposureGauge.set(0);
      }
    } catch (e) {}
  }, 5000);
}

app.get('/admin/status', (req, res) => {
  const state = systemKillSwitch.getState();
  const live = liveTradingEngine.getDiagnostics ? liveTradingEngine.getDiagnostics() : null;
  res.json({ kill: state, live });
});

app.post('/admin/kill', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const { reason, setBy, forceClose } = req.body || {};
  systemKillSwitch.setKill(reason, setBy);
  // Pause trading immediately
  try { liveTradingEngine.pause(); } catch (e) {}
  if (forceClose) {
    // Attempt to close positions safely
    const status = liveTradingEngine.getStatus();
    for (const pos of status.positions) {
      try { await liveTradingEngine.closePosition(pos.id); } catch (e) {}
    }
  }
  res.json({ ok: true, state: systemKillSwitch.getState() });
});

app.post('/admin/clear', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const { clearedBy } = req.body || {};
  systemKillSwitch.clearKill(clearedBy);
  res.json({ ok: true, state: systemKillSwitch.getState() });
});

app.get('/metrics', async (req, res) => {
  if (!client || !register) return res.status(501).send('metrics not enabled');
  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
});

const PORT = Number(process.env.ADMIN_PORT || 9001);
app.listen(PORT, () => {
  console.log(`[admin-server] listening on http://0.0.0.0:${PORT}`);
});

export default app;
