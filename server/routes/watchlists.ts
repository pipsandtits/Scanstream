import { Router, Request, Response } from 'express';

import { db } from '../db-storage';
import { randomUUID } from 'crypto';

const router = Router();

// Middleware for authentication (optional - can be removed if no auth system)
const isAuthenticated = (req: any, res: Response, next: any) => {
  // For now, treat all requests as authenticated
  // In production, check req.user or JWT token
  if (!req.user) {
    req.user = { id: 'default-user' }; // Default user for demo
  }
  next();
};

/**
 * GET /api/watchlists
 * Get all watchlist symbols for the current user grouped by symbol
 */
router.get('/', isAuthenticated, async (req: any, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM "Watchlist" WHERE "userId" = $1 ORDER BY "addedAt" DESC', [req.user.id]);
    const watchlistEntries = result.rows || [];

    // Group by symbol for compatibility
    const grouped = watchlistEntries.reduce((acc: any, entry: any) => {
      if (!acc[entry.symbol]) {
        acc[entry.symbol] = [];
      }
      acc[entry.symbol].push(entry);
      return acc;
    }, {});

    res.json({
      data: watchlistEntries,
      symbols: Object.keys(grouped),
      total: watchlistEntries.length,
    });
  } catch (error: any) {
    console.error('Error fetching watchlists:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/watchlists
 * Add a symbol to user's watchlist
 * Body: { symbol, notes? }
 */
router.post('/', isAuthenticated, async (req: any, res: Response) => {
  try {
    const { symbol, notes = '' } = req.body;

    if (!symbol || typeof symbol !== 'string' || symbol.trim().length === 0) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    const symbolUpper = symbol.toUpperCase().trim();

    // Check if symbol already exists in watchlist
    const existingRes = await db.query('SELECT * FROM "Watchlist" WHERE "userId" = $1 AND "symbol" = $2 LIMIT 1', [req.user.id, symbolUpper]);
    const existing = existingRes.rows && existingRes.rows[0];

    if (existing) {
      return res.status(400).json({ error: 'Symbol already in watchlist' });
    }

    const id = randomUUID();
    const createdRes = await db.query('INSERT INTO "Watchlist" (id, "userId", symbol, notes, "addedAt") VALUES ($1, $2, $3, $4, NOW()) RETURNING *', [id, req.user.id, symbolUpper, notes || null]);
    const watchlistEntry = createdRes.rows && createdRes.rows[0];

    res.status(201).json(watchlistEntry);
  } catch (error: any) {
    console.error('Error adding to watchlist:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/watchlists/:symbol
 * Get watchlist entry for a specific symbol
 */
router.get('/:symbol', isAuthenticated, async (req: any, res: Response) => {
  try {
    const { symbol } = req.params;

    const entryRes = await db.query('SELECT * FROM "Watchlist" WHERE "userId" = $1 AND "symbol" = $2 LIMIT 1', [req.user.id, symbol.toUpperCase()]);
    const entry = entryRes.rows && entryRes.rows[0];

    if (!entry) {
      return res.status(404).json({ error: 'Symbol not in watchlist' });
    }

    res.json(entry);
  } catch (error: any) {
    console.error('Error fetching watchlist entry:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/watchlists/:symbol
 * Update a watchlist entry (notes)
 * Body: { notes? }
 */
router.put('/:symbol', isAuthenticated, async (req: any, res: Response) => {
  try {
    const { symbol } = req.params;
    const { notes } = req.body;

    const entryRes = await db.query('SELECT * FROM "Watchlist" WHERE "userId" = $1 AND "symbol" = $2 LIMIT 1', [req.user.id, symbol.toUpperCase()]);
    const entry = entryRes.rows && entryRes.rows[0];

    if (!entry) {
      return res.status(404).json({ error: 'Symbol not in watchlist' });
    }

    const updatedRes = await db.query('UPDATE "Watchlist" SET notes = COALESCE($1, notes), "updatedAt" = NOW() WHERE "userId" = $2 AND symbol = $3 RETURNING *', [notes, req.user.id, symbol.toUpperCase()]);
    const updated = updatedRes.rows && updatedRes.rows[0];
    res.json(updated);
  } catch (error: any) {
    console.error('Error updating watchlist entry:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/watchlists/:symbol
 * Remove a symbol from watchlist
 */
router.delete('/:symbol', isAuthenticated, async (req: any, res: Response) => {
  try {
    const { symbol } = req.params;
    const entryRes = await db.query('SELECT * FROM "Watchlist" WHERE "userId" = $1 AND "symbol" = $2 LIMIT 1', [req.user.id, symbol.toUpperCase()]);
    const entry = entryRes.rows && entryRes.rows[0];

    if (!entry) {
      return res.status(404).json({ error: 'Symbol not in watchlist' });
    }

    await db.query('DELETE FROM "Watchlist" WHERE "userId" = $1 AND symbol = $2', [req.user.id, symbol.toUpperCase()]);

    res.json({ success: true, message: 'Symbol removed from watchlist' });
  } catch (error: any) {
    console.error('Error removing from watchlist:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
