import { signalArchive, initSignalArchive } from '../server/services/signal-archive';
import { OnlineLearningSystem } from '../server/services/rpg-agents/OnlineLearningSystem';
import pkg from '@prisma/client';
const { PrismaClient } = pkg as any;
import fs from 'fs';

async function run() {
  try {
    // Inject PrismaClient at runtime so the service doesn't assume DB availability at import time.
    const prisma = new PrismaClient();
    initSignalArchive(prisma);

    console.log('Collecting performance stats (30d, 90d)...');

    const perf30 = await signalArchive.getPerformanceStats({ days: 30 });
    const perf90 = await signalArchive.getPerformanceStats({ days: 90 });

    // Query signals for 90d to analyze conviction
    const start90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const signals90 = await signalArchive.querySignals({ startDate: start90, limit: 10000 });

    const highConvictionCount = signals90.filter((s: any) => {
      const r: any = (s as any).reasoning || {};
      const candidates = [r.supporting_agents, r.supportingAgents, r.supporting, r.councilVotes, r.votes, r.supporting_agent_ids, r.agent_votes];
      for (const c of candidates) {
        if (!c) continue;
        if (Array.isArray(c) && c.length >= 8) return true;
        if (typeof c === 'object' && Object.keys(c).length >= 8) return true;
        if (typeof c === 'number' && c >= 8) return true;
      }
      // Fallback: check composite vote info in top-level reasoning
      if (r?.vote_count && typeof r.vote_count === 'number' && r.vote_count >= 8) return true;
      if (r?.supportCount && typeof r.supportCount === 'number' && r.supportCount >= 8) return true;
      return false;
    }).length;

    const highConvictionFraction = signals90.length > 0 ? (highConvictionCount / signals90.length) : 0;

    // RL learning system metrics
    const ols = new OnlineLearningSystem();
    const exported = ols.exportQTable();
    const qStates = Object.keys(exported).length;
    const dummyAgent: any = { win_rate: 0 };
    const rlMetrics = ols.getLearningMetrics(dummyAgent as any);

    const out = {
      timestamp: new Date().toISOString(),
      perf30,
      perf90,
      signals90Count: signals90.length,
      highConvictionCount,
      highConvictionFraction,
      rl: {
        qStates,
        replayBufferSize: rlMetrics.total_experiences,
        avgQValue: rlMetrics.avg_q_value,
        recentPerformance: rlMetrics.recent_performance,
        explorationRate: rlMetrics.exploration_rate,
        learningRate: rlMetrics.learning_rate,
        patternAccuracy: Object.fromEntries(Array.from(rlMetrics.pattern_accuracy.entries ? rlMetrics.pattern_accuracy.entries() : [])),
      }
    };

    const outJson = JSON.stringify(out, null, 2);
    fs.writeFileSync('tools/signal-metrics-output.json', outJson);

    // Also write a compact CSV
    const csvLines: string[] = [];
    csvLines.push('metric,value');
    csvLines.push(`perf30_totalSignals,${perf30.totalSignals}`);
    csvLines.push(`perf30_executedSignals,${perf30.executedSignals}`);
    csvLines.push(`perf30_winRate,${perf30.winRate}`);
    csvLines.push(`perf30_avgPnl,${perf30.avgPnl}`);
    csvLines.push(`perf90_totalSignals,${perf90.totalSignals}`);
    csvLines.push(`perf90_executedSignals,${perf90.executedSignals}`);
    csvLines.push(`perf90_winRate,${perf90.winRate}`);
    csvLines.push(`perf90_avgPnl,${perf90.avgPnl}`);
    csvLines.push(`signals90_count,${signals90.length}`);
    csvLines.push(`highConvictionCount,${highConvictionCount}`);
    csvLines.push(`highConvictionFraction,${highConvictionFraction}`);
    csvLines.push(`rl_qStates,${qStates}`);
    csvLines.push(`rl_replayBufferSize,${rlMetrics.total_experiences}`);
    csvLines.push(`rl_avgQValue,${rlMetrics.avg_q_value}`);
    csvLines.push(`rl_recentPerformance,${rlMetrics.recent_performance}`);
    csvLines.push(`rl_explorationRate,${rlMetrics.exploration_rate}`);
    csvLines.push(`rl_learningRate,${rlMetrics.learning_rate}`);

    fs.writeFileSync('tools/signal-metrics-output.csv', csvLines.join('\n'));

    console.log('Wrote tools/signal-metrics-output.json and .csv');
    console.log(outJson);

    // cleanup
    if (signalArchive && typeof (signalArchive as any).disconnect === 'function') await (signalArchive as any).disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Error collecting metrics:', err);
    if ((signalArchive as any)?.disconnect) await (signalArchive as any).disconnect();
    process.exit(2);
  }
}

run();
