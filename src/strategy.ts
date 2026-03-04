import { Subscription } from "rxjs";
import type { BroadcastBus } from "./bus.js";
import type { Logger } from "./logger.js";
import type { FillEvent, StrategyMetrics } from "./types.js";

interface StrategyOptions {
  fillsSource: BroadcastBus<FillEvent>;
  logger: Logger;
}

export function startStrategyEvaluation({ fillsSource, logger }: StrategyOptions): () => void {
  const subscription = new Subscription();
  const metrics: StrategyMetrics = {
    totalSignals: 0,
    filledSignals: 0,
    rejectedSignals: 0,
    grossPnl: 0,
    netPnl: 0,
    averageLatencyMs: 0,
    updatedAt: Date.now(),
  };

  const sub = fillsSource.stream().subscribe({
    next: (fill) => {
      metrics.totalSignals += 1;
      if (fill.status === "filled") {
        metrics.filledSignals += 1;
      }

      metrics.averageLatencyMs = metrics.averageLatencyMs * 0.9 + (fill.latencyMs ?? 0) * 0.1;
      metrics.updatedAt = Date.now();

      logger.debug({ metrics, fill }, "Strategy metrics updated");
    },
    error: (error) => logger.error({ error }, "Strategy evaluation stream error"),
  });

  subscription.add(sub);

  return () => {
    logger.info("Shutting down strategy evaluation");
    subscription.unsubscribe();
  };
}
