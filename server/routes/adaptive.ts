import { Router } from 'express';
import { adaptiveController } from '../services/adaptive-controller';
import { retrainManager } from '../services/retrain-manager';

const router = Router();

router.get('/status', async (_req, res) => {
  try {
    res.json({ ok: true, status: adaptiveController.getStatus() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post('/admin/force-unfreeze-rl', async (_req, res) => {
  try {
    adaptiveController.forceUnfreezeRL();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post('/admin/set-mode', async (req, res) => {
  try {
    const mode = req.body?.mode;
    if (!['normal', 'conservative', 'isolation'].includes(mode)) return res.status(400).json({ ok: false, error: 'invalid mode' });
    adaptiveController.setMode(mode);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.get('/admin/retrain/tickets', async (_req, res) => {
  try {
    res.json({ ok: true, tickets: retrainManager.listTickets() });
  } catch (err: any) { res.status(500).json({ ok: false, error: String(err) }); }
});

router.post('/admin/retrain/create', async (req, res) => {
  try {
    const { reason, traceId, autoShadow } = req.body || {};
    if (!reason) return res.status(400).json({ ok: false, error: 'reason required' });
    const ticket = await retrainManager.createTicket({ reason, traceId, autoShadow: !!autoShadow, createdBy: 'api' });
    res.json({ ok: true, ticket });
  } catch (err: any) { res.status(500).json({ ok: false, error: String(err) }); }
});

export default router;
