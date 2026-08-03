import { Router, Request, Response } from 'express';
import { db } from '../db-storage';
import { randomUUID } from 'crypto';
const router = Router();

export function setupWatchlistRoutes(app: any) {
  const isAuthenticated = (req: any, res: Response, next: any) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  // Get watchlist
  app.get('/api/user/watchlist', isAuthenticated, async (req: any, res: Response) => {
    try {
      const resQ = await db.query('SELECT * FROM "Watchlist" WHERE "userId" = $1 ORDER BY "addedAt" DESC', [req.user.id]);
      res.json(resQ.rows || []);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add to watchlist
  app.post('/api/user/watchlist', isAuthenticated, async (req: any, res: Response) => {
    try {
      const { symbol, notes } = req.body;
      if (!symbol) {
        return res.status(400).json({ error: 'Symbol is required' });
      }

      const existingRes = await db.query('SELECT id FROM "Watchlist" WHERE "userId" = $1 AND symbol = $2 LIMIT 1', [req.user.id, symbol]);
      if (existingRes.rows && existingRes.rows.length > 0) return res.status(400).json({ error: 'Symbol already in watchlist' });
      const id = randomUUID();
      const itemRes = await db.query('INSERT INTO "Watchlist" (id, "userId", symbol, notes, "addedAt") VALUES ($1, $2, $3, $4, NOW()) RETURNING *', [id, req.user.id, symbol, notes || null]);
      res.json(itemRes.rows && itemRes.rows[0]);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Remove from watchlist
  app.delete('/api/user/watchlist/:id', isAuthenticated, async (req: any, res: Response) => {
    try {
      const itemRes = await db.query('SELECT id FROM "Watchlist" WHERE id = $1 AND "userId" = $2 LIMIT 1', [req.params.id, req.user.id]);
      if (!itemRes.rows || itemRes.rows.length === 0) return res.status(404).json({ error: 'Watchlist item not found' });
      await db.query('DELETE FROM "Watchlist" WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}

export default router;
