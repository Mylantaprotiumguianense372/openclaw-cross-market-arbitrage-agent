import { Subscription } from "rxjs";
import type { BroadcastBus } from "./bus.js";
import type { Logger } from "./logger.js";
import type { AppConfig } from "./config.js";
import type { TradeSignal, ExecutionCommand, FillEvent } from "./types.js";

interface RiskOptions {
  signalSource: BroadcastBus<TradeSignal>;
  commandBus: BroadcastBus<ExecutionCommand>;
  fillsSource?: BroadcastBus<FillEvent>;
  logger: Logger;
  config: AppConfig;
}

export function startRiskManager({
  signalSource,
  commandBus,
  fillsSource,
  logger,
  config,
}: RiskOptions): () => void {
  const subscription = new Subscription();
  let lastApprovedAt = 0;
  let dailyPnL = 0;
  let lastDayReset = getDateKey();

  function getDateKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function resetDailyIfNewDay() {
    const today = getDateKey();
    if (today !== lastDayReset) {
      dailyPnL = 0;
      lastDayReset = today;
    }
  }

  if (fillsSource) {
    subscription.add(
      fillsSource.stream().subscribe({
        next: (fill) => {
          if (fill.status !== "filled" || fill.avgPriceLong == null || fill.avgPriceShort == null) return;
          const grossPerShare = 1 - fill.avgPriceLong - fill.avgPriceShort;
          dailyPnL += fill.filledSize * grossPerShare;
          logger.debug({ dailyPnL, fill }, "Daily PnL updated from fill");
        },
      })
    );
  }

  subscription.add(
    signalSource.stream().subscribe({
      next: (signal) => {
        const decision = evaluateSignal(signal, config, {
          lastApprovedAt,
          dailyPnL,
          resetDailyIfNewDay,
        });
        if (!decision.approved) {
          logger.debug({ signalId: signal.signalId, reason: decision.reason }, "Signal rejected by risk manager");
          return;
        }
        lastApprovedAt = Date.now();

        const command: ExecutionCommand = {
          signalId: signal.signalId,
          eventKey: signal.eventKey,
          longVenue: signal.longVenue,
          shortVenue: signal.shortVenue,
          longMarketId: signal.longMarketId,
          shortMarketId: signal.shortMarketId,
          size: decision.maxSize ?? signal.size,
          targetEdge: signal.netEdge,
        };

        commandBus.publish(command);
      },
      error: (error) => logger.error({ error }, "Risk stream error"),
    })
  );

  return () => {
    logger.info("Shutting down risk manager");
    subscription.unsubscribe();
  };
}

function evaluateSignal(
  signal: TradeSignal,
  config: AppConfig,
  ctx: { lastApprovedAt: number; dailyPnL: number; resetDailyIfNewDay: () => void }
) {
  ctx.resetDailyIfNewDay();
  if (ctx.dailyPnL <= -config.risk.maxDailyLoss) {
    return { approved: false, reason: `Daily loss limit reached (PnL=${ctx.dailyPnL.toFixed(2)})` };
  }

  const ageMs = Date.now() - signal.createdAt;
  if (ageMs > config.risk.staleQuoteMs) {
    return { approved: false, reason: `Quote stale (${ageMs}ms > ${config.risk.staleQuoteMs}ms)` };
  }

  const cooldownMs = config.risk.cooldownMs ?? 10_000;
  if (Date.now() - ctx.lastApprovedAt < cooldownMs && ctx.lastApprovedAt > 0) {
    return { approved: false, reason: `Cooldown active (${cooldownMs}ms between trades)` };
  }

  const maxTrade = config.risk.maxCapitalPerTrade;
  if (signal.size > maxTrade) {
    return { approved: true, maxSize: maxTrade, reason: "Capped to max capital" };
  }

  if (signal.netEdge < config.strategy.edgeThreshold) {
    return { approved: false, reason: "Edge below threshold" };
  }

  return { approved: true };
}
