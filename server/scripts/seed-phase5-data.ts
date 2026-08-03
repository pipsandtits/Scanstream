import { db } from '../db-storage';

async function seedPhase5Data() {
  try {
    console.log('[Seed] Starting Phase 5 data seeding...');

    // Seed signal history with sample trades
    const signalHistorySql = `
      INSERT INTO signal_history (
        symbol, entry_price, exit_price, profit_loss, profit_loss_percent,
        quality_score, confidence_level, signal_source, status, actual_outcome,
        prediction_accuracy, duration_minutes, timestamp
      ) VALUES
      ('AAPL', 185.50, 187.25, 1.75, 0.94, 82, 87, 'ML', 'closed', 'WIN', true, 45, NOW() - INTERVAL '2 hours'),
      ('TSLA', 242.10, 240.50, -1.60, -0.66, 65, 71, 'SCANNER', 'closed', 'LOSS', false, 30, NOW() - INTERVAL '1 hour'),
      ('NVDA', 875.30, 882.40, 7.10, 0.81, 91, 94, 'RPG', 'closed', 'WIN', true, 90, NOW() - INTERVAL '30 minutes'),
      ('SPY', 456.20, 458.50, 2.30, 0.50, 78, 85, 'RL', 'open', NULL, NULL, NULL, NOW()),
      ('MSFT', 380.10, 382.35, 2.25, 0.59, 75, 80, 'ML', 'closed', 'WIN', true, 60, NOW() - INTERVAL '15 minutes')
    `;
    const signalHistory = await db.query(signalHistorySql);

    console.log('[Seed] ✅ Signal history seeded');

    // Seed agent performance with 5 RPG agents
    const agentInsertsSql = `
      INSERT INTO agent_performance (
        agent_id, agent_name, strategy, total_trades, winning_trades, losing_trades,
        sharpe_ratio, max_drawdown, profit_factor, status, rank, achievements, created_at, updated_at
      ) VALUES
      ('trend-follower-1', 'Trend Follower', 'TREND_FOLLOWING', 245, 143, 102, 1.45, -12.3, 1.68, 'active', 1, ARRAY['master-strategist', 'consistent-winner'], NOW(), NOW()),
      ('mean-revert-1', 'Mean Reversion Specialist', 'MEAN_REVERSION', 198, 110, 88, 1.12, -18.5, 1.42, 'active', 2, ARRAY['recovery-artist'], NOW(), NOW()),
      ('momentum-trader-1', 'Momentum Trader', 'MOMENTUM', 167, 89, 78, 0.98, -15.2, 1.35, 'learning', 3, ARRAY['rising-star'], NOW(), NOW()),
      ('breakout-scout-1', 'Breakout Scout', 'BREAKOUT', 224, 116, 108, 1.28, -14.8, 1.55, 'active', 4, ARRAY['breakthrough-hunter'], NOW(), NOW()),
      ('volatility-hunter-1', 'Volatility Hunter', 'VOLATILITY', 156, 78, 78, 0.87, -22.1, 1.21, 'paused', 5, ARRAY['vol-master'], NOW(), NOW())
    `;
    const agentInserts = await db.query(agentInsertsSql);

    console.log('[Seed] ✅ Agent performance seeded');

    // Seed market regime with current regime
    const regimeInsertSql = `
      INSERT INTO market_regime (
        current_regime, regime_confidence, scanner_weight, ml_weight, rl_weight, rpg_weight,
        volatility_level, trend_strength, timestamp
      ) VALUES
      ('TRENDING_UP', 85, 0.20, 0.35, 0.25, 0.20, 42, 78, NOW())
    `;
    const regimeInsert = await db.query(regimeInsertSql);

    console.log('[Seed] ✅ Market regime seeded');

    // Seed regime transitions history
    const transitionInsertsSql = `
      INSERT INTO regime_transitions (
        from_regime, to_regime, confidence, timestamp
      ) VALUES
      ('RANGING', 'TRENDING_UP', 82, NOW() - INTERVAL '1 day'),
      ('TRENDING_DOWN', 'RANGING', 75, NOW() - INTERVAL '3 days'),
      ('TRENDING_UP', 'TRENDING_DOWN', 88, NOW() - INTERVAL '7 days')
    `;
    const transitionInserts = await db.query(transitionInsertsSql);

    console.log('[Seed] ✅ Regime transitions seeded');

    // Seed signal source metrics for adaptive weighting
    const sourceMetricsInsertsSql = `
      INSERT INTO signal_source_metrics (
        signal_source, total_trades, winning_trades, losing_trades, win_rate,
        avg_win, avg_loss, confidence_level, weight_multiplier, last_updated
      ) VALUES
      ('ML', 450, 268, 182, 59.56, 2.45, 1.32, 'high', 1.00, NOW()),
      ('SCANNER', 380, 198, 182, 52.11, 1.85, 1.50, 'high', 0.80, NOW()),
      ('RL', 320, 175, 145, 54.69, 2.15, 1.28, 'medium', 0.60, NOW()),
      ('RPG', 280, 142, 138, 50.71, 1.75, 1.42, 'medium', 0.50, NOW())
    `;
    const sourceMetricsInserts = await db.query(sourceMetricsInsertsSql);

    console.log('[Seed] ✅ Signal source metrics seeded');

    // Seed daily risk budget
    const budgetInsertSql = `
      INSERT INTO daily_risk_budget (
        trading_date, cumulative_pnl, budget_cap, budget_used_percent, budget_status,
        trades_today, last_updated
      ) VALUES
      (CURRENT_DATE, 2340.50, 5000.00, 46.81, 'safe', 8, NOW())
    `;
    const budgetInsert = await db.query(budgetInsertSql);

    console.log('[Seed] ✅ Daily risk budget seeded');

    console.log('[Seed] ✅ Phase 5 data seeding complete!');

  } catch (error) {
    console.error('[Seed] Error seeding Phase 5 data:', error);
    (process as any).exit(1);
  } finally {
    try { if ((db as any).prisma && typeof (db as any).prisma.$disconnect === 'function') await (db as any).prisma.$disconnect(); } catch (_) {}
  }
}

seedPhase5Data();
