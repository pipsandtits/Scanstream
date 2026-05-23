// Recommended SQL indexes for performance:
// CREATE INDEX IF NOT EXISTS idx_frames_symbol_ts ON market_frames (symbol, timestamp DESC);
// CREATE INDEX IF NOT EXISTS idx_signals_symbol_ts ON signals (symbol, timestamp DESC);
// CREATE INDEX IF NOT EXISTS idx_trades_symbol_et ON trades (symbol, entry_time DESC);
import { pgEnum } from "drizzle-orm/pg-core";
// Enums for type safety
export const signalTypeEnum = pgEnum("signal_type", ["BUY", "SELL", "HOLD"]);
export const signalClassificationEnum = pgEnum("signal_classification", [
    "BREAKOUT", "REVERSAL", "CONTINUATION", "PULLBACK", "DIVERGENCE",
    "SUPPORT_BOUNCE", "RESISTANCE_BREAK", "TREND_CONFIRMATION", "CONSOLIDATION_BREAK",
    "MA_CROSSOVER", "RSI_EXTREME", "MACD_SIGNAL", "CONFLUENCE", "ML_PREDICTION",
    "PARABOLIC", "BULL_EARLY", "BEAR_EARLY", "ACCUMULATION", "DISTRIBUTION",
    "SPIKE", "TOPPING", "BOTTOMING", "RANGING", "LAGGING", "LEADING",
    "TREND_EXHAUSTION", "TREND_ESTABLISHMENT", "RETEST", "FLIP"
]);
export const tradeStatusEnum = pgEnum("trade_status", ["OPEN", "CLOSED", "CANCELLED"]);
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, real, integer, timestamp, jsonb, boolean, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const marketFrames = pgTable("market_frames", {
    id: uuid("id").primaryKey().defaultRandom(),
    timestamp: timestamp("timestamp").notNull().default(sql `now()`),
    symbol: text("symbol").notNull(),
    price: jsonb("price").notNull(), // { open, high, low, close }
    volume: real("volume").notNull(),
    indicators: jsonb("indicators").notNull(), // RSI, MACD, etc.
    orderFlow: jsonb("order_flow").notNull(), // bid/ask volumes, net flow
    marketMicrostructure: jsonb("market_microstructure").notNull(), // spread, depth, etc.
});
export const signals = pgTable("signals", {
    id: uuid("id").primaryKey().defaultRandom(),
    timestamp: timestamp("timestamp").notNull().default(sql `now()`),
    symbol: text("symbol").notNull(),
    type: signalTypeEnum("type").notNull(),
    classifications: jsonb("classifications").notNull().default('[]'), // Array of classification types
    strength: real("strength").notNull(),
    confidence: real("confidence").notNull(),
    price: real("price").notNull(),
    reasoning: jsonb("reasoning").notNull(),
    riskReward: real("riskReward").notNull(),
    stopLoss: real("stop_loss").notNull(),
    takeProfit: real("take_profit").notNull(),
    momentumLabel: text("momentum_label"),
    regimeState: text("regime_state"),
    legacyLabel: text("legacy_label"),
    signalStrengthScore: real("signal_strength_score"),
    patternDetails: jsonb("pattern_details"), // Array of patterns with details
    timeframeAlignment: real("timeframe_alignment"), // 0-1 score
    agreementScore: real("agreement_score").default(50), // 0-100, consensus between sources
    positionSize: real("position_size").default(0.5), // 0-1 scale, percentage of max position
});
export const trades = pgTable("trades", {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id"), // Links to signal that generated this trade (CRITICAL for attribution)
    symbol: text("symbol").notNull(),
    side: text("side").notNull(), // 'BUY' | 'SELL'
    entryTime: timestamp("entry_time").notNull(),
    exitTime: timestamp("exit_time"),
    entryPrice: real("entry_price").notNull(),
    exitPrice: real("exit_price"),
    quantity: real("quantity").notNull(),
    pnl: real("pnl"),
    commission: real("commission").notNull().default(0),
    status: tradeStatusEnum("status").notNull().default("OPEN"),
});
export const strategies = pgTable("strategies", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    riskParams: jsonb("risk_params").notNull(),
    performance: jsonb("performance").notNull(),
    isActive: boolean("is_active").notNull().default(true),
});
export const backtestResults = pgTable("backtest_results", {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: varchar("strategy_id").notNull(),
    startDate: timestamp("start_date").notNull(),
    endDate: timestamp("end_date").notNull(),
    initialCapital: real("initial_capital").notNull(),
    finalCapital: real("final_capital").notNull(),
    performance: jsonb("performance").notNull(),
    equityCurve: jsonb("equity_curve").notNull(),
    monthlyReturns: jsonb("monthly_returns").notNull(),
    metrics: jsonb("metrics").notNull(),
    trades: jsonb("trades").notNull(),
    createdAt: timestamp("created_at").notNull().default(sql `now()`),
});
export const auditLogs = pgTable("audit_logs", {
    id: uuid("id").primaryKey().defaultRandom(),
    timestamp: timestamp("timestamp").notNull().default(sql `now()`),
    action: text("action").notNull(), // "SIGNAL_GENERATED", "TRADE_EXECUTED", "POSITION_CLOSED"
    entityType: text("entity_type").notNull(), // "Signal", "Trade", "Portfolio"
    entityId: text("entity_id").notNull(),
    userId: text("user_id"),
    details: jsonb("details").notNull(), // full context
    severity: text("severity").notNull().default("INFO"), // "INFO", "WARNING", "ERROR"
});
export const modelMetrics = pgTable("model_metrics", {
    id: uuid("id").primaryKey().defaultRandom(),
    modelName: text("model_name").notNull(), // "DirectionClassifier", "PricePredictor"
    timestamp: timestamp("timestamp").notNull().default(sql `now()`),
    accuracy: real("accuracy"), // last 100 predictions
    precision: real("precision"),
    recall: real("recall"),
    driftScore: real("drift_score"), // 0-1, how much model has drifted
    dataPoints: integer("data_points"), // sample size
    isStale: boolean("is_stale").notNull().default(false), // flag when accuracy drops
});
// Insert schemas
export const insertMarketFrameSchema = createInsertSchema(marketFrames).omit({
    id: true,
    timestamp: true,
});
export const insertSignalSchema = createInsertSchema(signals).omit({
    id: true,
    timestamp: true,
});
export const insertTradeSchema = createInsertSchema(trades).omit({
    id: true,
});
export const insertStrategySchema = createInsertSchema(strategies).omit({
    id: true,
});
export const insertBacktestResultSchema = createInsertSchema(backtestResults).omit({
    id: true,
    createdAt: true,
});
export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({
    id: true,
    timestamp: true,
});
export const insertModelMetricSchema = createInsertSchema(modelMetrics).omit({
    id: true,
    timestamp: true,
});
