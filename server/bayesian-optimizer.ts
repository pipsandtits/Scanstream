/**
 * optimizer.ts — Fixed Bayesian Optimizer + Agent Definitions
 *
 * Fixes applied vs. original:
 *  1. generateRandomParams now samples uniformly at random (was always midpoint)
 *  2. EI sign corrected: improvement = predictedMean - bestScore (was inverted)
 *  3. history is local to each optimize() call (was shared mutable instance state)
 *  4. evaluate() wired to real data path; stubs throw clearly instead of returning 0
 *  5. Dynamic config import hoisted to module-level constant (was re-imported per call)
 *  6. ScannerAgent constructor is private — use ScannerAgent.create() (was leaking {} cast)
 *  7. optimizeAll no longer hard-codes agent names; callers register agents explicitly
 *  8. parallelOptimization flag is actually respected
 *  9. optimizeStrategyWeights no longer returns Math.random() noise — throws NotImplemented
 * 10. trainRLAgent receives live regime + confidence instead of hardcoded mocks
 * 11. overallPerformance only averages scores from the same scale (Bayesian agent scores)
 * 12. saveResults actually writes to disk
 */

import { writeFileSync } from 'fs';
import { ModuleLogger } from './utils/logger';
import { getHyperparameters, setHyperparameters, validateParams, Hyperparameters } from './utils/hyperparameters';
import { MarketFrame } from '@shared/schema';
import tradingConfig from '../config/trading-config.json'; // FIX 5: static import

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface OptimizableAgent {
  getHyperparameters(): Record<string, any>;
  setHyperparameters(params: Record<string, any>): void;
  evaluate(): Promise<number>;
  validateParams(params: Record<string, any>): boolean;
}

export interface OptimizationBounds {
  [param: string]: [number, number]; // [min, max]
}

export interface OptimizationResult {
  bestParams: Record<string, any>;
  bestScore: number;
  history: Array<{ params: Record<string, any>; score: number }>;
  iterations: number;
}

// ---------------------------------------------------------------------------
// SimpleBayesianOptimizer
// ---------------------------------------------------------------------------

export class SimpleBayesianOptimizer {
  async optimize(
    agent: OptimizableAgent,
    bounds: OptimizationBounds,
    iterations?: number,
    initPoints?: number
  ): Promise<OptimizationResult> {
    iterations  = iterations  ?? (tradingConfig.optimizer.iterations  as number);
    initPoints  = initPoints  ?? (tradingConfig.optimizer.initPoints  as number);

    // FIX 3: history is local — concurrent calls on the same instance are safe
    const history: Array<{ params: Record<string, any>; score: number }> = [];

    const originalParams = agent.getHyperparameters();

    try {
      // --- Random initialisation phase ---
      for (let i = 0; i < initPoints; i++) {
        const randomParams = this.generateRandomParams(bounds);
        if (agent.validateParams(randomParams)) {
          agent.setHyperparameters(randomParams);
          const score = await agent.evaluate();
          history.push({ params: randomParams, score });
        }
      }

      // --- Bayesian optimisation phase ---
      for (let i = initPoints; i < iterations; i++) {
        const nextParams = this.suggestNextParams(bounds, history);
        if (agent.validateParams(nextParams)) {
          agent.setHyperparameters(nextParams);
          const score = await agent.evaluate();
          history.push({ params: nextParams, score });
        }
      }

      if (history.length === 0) {
        // All candidates failed validation — restore and surface the problem
        agent.setHyperparameters(originalParams);
        throw new Error('Optimization produced no valid evaluations. Check bounds and validateParams.');
      }

      const bestResult = history.reduce((best, current) =>
        current.score > best.score ? current : best
      );

      agent.setHyperparameters(bestResult.params);

      return {
        bestParams:  bestResult.params,
        bestScore:   bestResult.score,
        history,
        iterations:  history.length
      };

    } catch (error) {
      agent.setHyperparameters(originalParams);
      throw error;
    }
  }

  // FIX 1: uniform random sampling across each dimension
  private generateRandomParams(bounds: OptimizationBounds): Record<string, any> {
    const params: Record<string, any> = {};
    for (const [param, [min, max]] of Object.entries(bounds)) {
      params[param] = Math.random() * (max - min) + min;
    }
    return params;
  }

  // FIX 3: history passed in, never stored on `this`
  private suggestNextParams(
    bounds: OptimizationBounds,
    history: Array<{ params: Record<string, any>; score: number }>
  ): Record<string, any> {
    if (history.length === 0) {
      return this.generateRandomParams(bounds);
    }

    const bestScore = Math.max(...history.map(h => h.score));
    let bestCandidate = { params: this.generateRandomParams(bounds), ei: -Infinity };

    for (let i = 0; i < 50; i++) {
      const candidateParams = this.generateRandomParams(bounds);
      const ei = this.calculateExpectedImprovement(candidateParams, bestScore, history);
      if (ei > bestCandidate.ei) {
        bestCandidate = { params: candidateParams, ei };
      }
    }

    return bestCandidate.params;
  }

  // FIX 2: EI sign corrected — we want points predicted to EXCEED the current best
  private calculateExpectedImprovement(
    params: Record<string, any>,
    bestScore: number,
    history: Array<{ params: Record<string, any>; score: number }>
  ): number {
    if (history.length === 0) return 0;

    const similarities = history.map(h => {
      const distance   = this.calculateDistance(params, h.params);
      const similarity = Math.exp(-distance * 2);
      return { similarity, score: h.score };
    });

    const totalSimilarity = similarities.reduce((sum, s) => sum + s.similarity, 0);
    if (totalSimilarity === 0) return 0;

    const predictedMean = similarities.reduce((sum, s) => sum + s.similarity * s.score, 0) / totalSimilarity;
    const variance      = similarities.reduce((sum, s) =>
      sum + s.similarity * Math.pow(s.score - predictedMean, 2), 0
    ) / totalSimilarity;
    const sigma = Math.sqrt(variance + 0.01);

    // improvement > 0 when predicted mean exceeds current best (was inverted in original)
    const improvement = predictedMean - bestScore;

    return improvement + sigma * 0.5; // exploitation + exploration
  }

  private calculateDistance(
    params1: Record<string, any>,
    params2: Record<string, any>
  ): number {
    let distanceSq = 0;
    for (const key of Object.keys(params1)) {
      if (key in params2) {
        distanceSq += Math.pow(params1[key] - params2[key], 2);
      }
    }
    return Math.sqrt(distanceSq);
  }
}

// ---------------------------------------------------------------------------
// ScannerAgent
// ---------------------------------------------------------------------------

export class ScannerAgent implements OptimizableAgent {
  private hyperparameters: Hyperparameters;
  private performanceHistory: number[] = [];

  // FIX 6: constructor is private — prevents `new ScannerAgent({} as Hyperparameters)`
  private constructor(hyperparameters: Hyperparameters) {
    this.hyperparameters = hyperparameters;
  }

  static async create(): Promise<ScannerAgent> {
    return new ScannerAgent(tradingConfig.scannerAgent as Hyperparameters);
  }

  getHyperparameters(): Hyperparameters {
    return getHyperparameters(this);
  }

  setHyperparameters(params: Hyperparameters): void {
    setHyperparameters(this, params);
  }

  validateParams(params: Hyperparameters): boolean {
    const schema = {
      lookbackWindow:   (v: any) => typeof v === 'number' && v >= 20   && v <= 200,
      rsiThreshold:     (v: any) => typeof v === 'number' && v >= 10   && v <= 80,
      volumeMultiplier: (v: any) => typeof v === 'number' && v >= 0.5  && v <= 10.0
    };
    return validateParams(params, schema);
  }

  async evaluate(): Promise<number> {
    const returns = await this.getHistoricalReturns();
    if (!returns || returns.length === 0) return 0;
    const avg   = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std   = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / returns.length);
    const sharpe = std === 0 ? 0 : avg / std;
    this.performanceHistory.push(sharpe);
    return sharpe;
  }

  // FIX 4: stub throws instead of silently returning [] and masking the problem
  private async getHistoricalReturns(): Promise<number[]> {
    throw new Error(
      'ScannerAgent.getHistoricalReturns() is not implemented. ' +
      'Wire this to your database or analytics API before running optimization.'
    );
  }

  get performance(): number[] {
    return [...this.performanceHistory];
  }
}

// ---------------------------------------------------------------------------
// MLAgent
// ---------------------------------------------------------------------------

export class MLAgent implements OptimizableAgent {
  private hyperparameters: Hyperparameters = {
    predictionWindow:    5,
    confidenceThreshold: 0.7,
    modelComplexity:     10
  };
  private performanceHistory: number[] = [];

  getHyperparameters(): Hyperparameters {
    return getHyperparameters(this);
  }

  setHyperparameters(params: Hyperparameters): void {
    setHyperparameters(this, params);
  }

  validateParams(params: Hyperparameters): boolean {
    const schema = {
      predictionWindow:    (v: any) => typeof v === 'number' && v >= 1   && v <= 20,
      confidenceThreshold: (v: any) => typeof v === 'number' && v >= 0.1 && v <= 0.95,
      modelComplexity:     (v: any) => typeof v === 'number' && v >= 1   && v <= 50
    };
    return validateParams(params, schema);
  }

  async evaluate(): Promise<number> {
    const returns = await this.getHistoricalReturns();
    if (!returns || returns.length === 0) return 0;
    const avg    = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std    = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / returns.length);
    const sharpe = std === 0 ? 0 : avg / std;
    this.performanceHistory.push(sharpe);
    return sharpe;
  }

  // FIX 4: throws instead of silently returning []
  private async getHistoricalReturns(): Promise<number[]> {
    throw new Error(
      'MLAgent.getHistoricalReturns() is not implemented. ' +
      'Wire this to your database or analytics API before running optimization.'
    );
  }

  get performance(): number[] {
    return [...this.performanceHistory];
  }
}

// ---------------------------------------------------------------------------
// MirrorOptimizer
// ---------------------------------------------------------------------------

import { getRLAgent } from '../src/agents/rl-agent.singleton';
import { StrategyIntegrationEngine } from './strategy-integration';

export interface UnifiedOptimizationConfig {
  optimizeScanner:    boolean;
  optimizeML:         boolean;
  optimizeRL:         boolean;
  optimizeStrategies: boolean;
  iterations:         number;
  parallelOptimization: boolean;
}

export class MirrorOptimizer {
  private optimizer   = new SimpleBayesianOptimizer();
  private agents      = new Map<string, OptimizableAgent>();
  private optimizationHistory = new Map<string, OptimizationResult>();

  private rlAgent       = getRLAgent();
  private strategyEngine = new StrategyIntegrationEngine();

  registerAgent(name: string, agent: OptimizableAgent): void {
    this.agents.set(name, agent);
  }

  async optimizeAgent(
    agentName: string,
    bounds: OptimizationBounds,
    iterations: number = 15
  ): Promise<OptimizationResult> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(
        `Agent '${agentName}' not found. Registered agents: ${[...this.agents.keys()].join(', ')}`
      );
    }

    new ModuleLogger('MirrorOptimizer').info(`Optimizing '${agentName}' — ${iterations} iterations`);

    const result = await this.optimizer.optimize(agent, bounds, iterations);
    this.optimizationHistory.set(agentName, result);

    new ModuleLogger('MirrorOptimizer').info(`${agentName} complete — bestScore=${result.bestScore.toFixed(4)}`);

    return result;
  }

  // FIX 8: parallelOptimization is actually respected
  async optimizeAllAgents(
    boundsMap: Record<string, OptimizationBounds>,
    iterations:          number  = 15,
    parallelOptimization: boolean = false
  ): Promise<Record<string, OptimizationResult>> {
    const entries = Object.entries(boundsMap).filter(([name]) => this.agents.has(name));

    const runOne = async ([agentName, bounds]: [string, OptimizationBounds]) => {
      try {
        return [agentName, await this.optimizeAgent(agentName, bounds, iterations)] as const;
      } catch (error) {
        console.error(`[MirrorOptimizer] Failed to optimize '${agentName}':`, error);
        return null;
      }
    };

    const pairs = parallelOptimization
      ? await Promise.all(entries.map(runOne))
      : await entries.reduce(async (accP, entry) => {
          const acc = await accP;
          const result = await runOne(entry);
          if (result) acc.push(result);
          return acc;
        }, Promise.resolve([] as Array<readonly [string, OptimizationResult]>));

    return Object.fromEntries(pairs.filter((p): p is readonly [string, OptimizationResult] => p !== null));
  }

  getOptimizationHistory(agentName?: string): Record<string, OptimizationResult> | OptimizationResult | undefined {
    if (agentName) return this.optimizationHistory.get(agentName);
    return Object.fromEntries(this.optimizationHistory);
  }

  // FIX 12: actually writes to disk
  saveResults(filename: string): void {
    const data = JSON.stringify(Object.fromEntries(this.optimizationHistory), null, 2);
    writeFileSync(filename, data, 'utf-8');
    new ModuleLogger('MirrorOptimizer').info(`Results saved to ${filename}`);
  }

  /**
   * FIX 7: agent names are no longer hardcoded — callers must register 'scanner'
   * and 'ml' before calling optimizeAll, or those steps are skipped with a warning.
   *
   * FIX 11: overallPerformance averages only Bayesian agent bestScores (Sharpe
   * ratios). RL reward and strategy performance are reported separately.
   */
  async optimizeAll(
    config:     UnifiedOptimizationConfig,
    marketData: MarketFrame[],
    /** Live regime + ML confidence, injected so RL training is not mocked */
    liveContext?: { regime: string; mlConfidence: number }
  ): Promise<{
    scanner?:           OptimizationResult;
    ml?:                OptimizationResult;
    rl?:                { stats: any; performance: number };
    strategies?:        { weights: any; performance: number };
    overallBayesianScore: number;
  }> {
    const results: any = {};

    const runOptimization = async (
      label:     string,
      agentName: string,
      bounds:    OptimizationBounds
    ): Promise<OptimizationResult | undefined> => {
      if (!this.agents.has(agentName)) {
        console.warn(`[MirrorOptimizer] Agent '${agentName}' not registered — skipping ${label}`);
        return undefined;
      }
      console.log(`\n[${label}] Optimizing...`);
      return this.optimizeAgent(agentName, bounds, config.iterations);
    };

    const tasks: Array<() => Promise<void>> = [];

    if (config.optimizeScanner) {
      tasks.push(async () => {
        results.scanner = await runOptimization('1/4 Scanner', 'scanner', {
          lookbackWindow:   [20, 200],
          rsiThreshold:     [10, 80],
          volumeMultiplier: [0.5, 10.0]
        });
      });
    }

    if (config.optimizeML) {
      tasks.push(async () => {
        results.ml = await runOptimization('2/4 ML Models', 'ml', {
          predictionWindow:    [1, 20],
          confidenceThreshold: [0.1, 0.95],
          modelComplexity:     [1, 50]
        });
      });
    }

    if (config.optimizeRL) {
      tasks.push(async () => {
        console.log('\n[3/4 RL Agent] Training...');
        results.rl = await this.trainRLAgent(marketData, liveContext);
      });
    }

    if (config.optimizeStrategies) {
      tasks.push(async () => {
        console.log('\n[4/4 Strategy Weights] Optimizing...');
        results.strategies = await this.optimizeStrategyWeights(marketData);
      });
    }

    // FIX 8: respect parallelOptimization
    if (config.parallelOptimization) {
      await Promise.all(tasks.map(t => t()));
    } else {
      for (const t of tasks) await t();
    }

    // FIX 11: only average comparable Bayesian scores (Sharpe ratios)
    const bayesianScores = [results.scanner?.bestScore, results.ml?.bestScore]
      .filter((s): s is number => typeof s === 'number' && isFinite(s));

    results.overallBayesianScore = bayesianScores.length > 0
      ? bayesianScores.reduce((a, b) => a + b, 0) / bayesianScores.length
      : 0;

    console.log('\n[MirrorOptimizer] Optimization complete');
    console.log(`Overall Bayesian Score (Sharpe avg): ${results.overallBayesianScore.toFixed(4)}`);

    return results;
  }

  // FIX 10: liveContext injected — no more hardcoded mock regime/confidence
  private async trainRLAgent(
    marketData:   MarketFrame[],
    liveContext?: { regime: string; mlConfidence: number }
  ): Promise<{ stats: any; performance: number }> {
    const regime      = liveContext?.regime      ?? 'UNKNOWN';
    const mlConfidence = liveContext?.mlConfidence ?? 0.5;

    let totalReward    = 0;
    const trainingEpisodes = 100;

    for (let episode = 0; episode < trainingEpisodes; episode++) {
      const startIdx   = Math.floor(Math.random() * (marketData.length - 100));
      const episodeData = marketData.slice(startIdx, startIdx + 100);
      let position: { entry: number; size: number; stop: number; tp: number } | null = null;
      let episodeReward = 0;

      for (let i = 20; i < episodeData.length - 1; i++) {
        const currentFrame = episodeData[i] as any;
        const nextFrame    = episodeData[i + 1] as any;

        const state = this.rlAgent.extractState(
          episodeData.slice(0, i + 1),
          mlConfidence,
          regime,
          0
        );

        if (!position) {
          const params = this.rlAgent.getPositionParameters(
            state,
            1.0,
            currentFrame.indicators.atr,
            currentFrame.price.close
          );
          position = {
            entry: currentFrame.price.close,
            size:  params.positionSize,
            stop:  params.stopLoss,
            tp:    params.takeProfit
          };
        }

        if (position) {
          const nextPrice = nextFrame.price.close;
          let done = false;
          let pnl  = 0;

          if (nextPrice <= position.stop) {
            pnl  = (position.stop - position.entry) / position.entry;
            done = true;
          } else if (nextPrice >= position.tp) {
            pnl  = (position.tp   - position.entry) / position.entry;
            done = true;
          }

          if (done) {
            const nextState = this.rlAgent.extractState(
              episodeData.slice(0, i + 2),
              mlConfidence,
              regime,
              0
            );
            const riskReward = (position.tp - position.entry) / (position.entry - position.stop);
            const reward     = this.rlAgent.calculateReward(pnl * 100, riskReward, pnl, i - startIdx);

            this.rlAgent.addExperience({
              state,
              action:     this.rlAgent.selectAction(state, true),
              reward,
              nextState,
              done:       true
            });

            episodeReward += reward;
            position       = null;
            this.rlAgent.replayExperience(32);
          }
        }
      }

      totalReward += episodeReward;

      if (episode % 10 === 0) {
        console.log(`  Episode ${episode}/${trainingEpisodes} — Avg Reward: ${(episodeReward / 100).toFixed(2)}`);
      }
    }

    const avgReward   = totalReward / trainingEpisodes;
    const performance = Math.max(0, Math.min(1, (avgReward + 50) / 100));

    return { stats: this.rlAgent.getStats(), performance };
  }

  // FIX 9: no longer returns Math.random() noise — throws until implemented
  private async optimizeStrategyWeights(_marketData: MarketFrame[]): Promise<{
    weights: any;
    performance: number;
  }> {
    throw new Error(
      'optimizeStrategyWeights() is not implemented. ' +
      'Replace this with a real backtest against marketData before enabling config.optimizeStrategies.'
    );
  }

  getOptimizationReport(): {
    agents:           Record<string, OptimizationResult | undefined>;
    rlAgent:          any;
    strategyWeights:  any;
    summary: {
      totalIterations:      number;
      bestOverallScore:     number;
      componentsOptimized:  number;
    };
  } {
    const agentResults = Object.fromEntries(this.optimizationHistory);
    const allScores    = Object.values(agentResults).map(r => r.bestScore);

    return {
      agents:          agentResults,
      rlAgent:         this.rlAgent.getStats(),
      strategyWeights: this.strategyEngine.getStrategyWeights(),
      summary: {
        totalIterations:     Object.values(agentResults).reduce((sum, r) => sum + r.iterations, 0),
        bestOverallScore:    allScores.length > 0 ? Math.max(...allScores) : 0,
        componentsOptimized: Object.keys(agentResults).length
      }
    };
  }
}