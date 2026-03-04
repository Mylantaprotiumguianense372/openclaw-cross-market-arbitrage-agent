import { createInterface } from "node:readline";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createDb } from "./db.js";
import { createBroadcastBus } from "./bus.js";
import type { MarketEvent, NormalizedMarket, TradeSignal, ExecutionCommand, FillEvent } from "./types.js";
import { startPolymarketFeed } from "./market-data/polymarket.js";
import { startKalshiFeed } from "./market-data/kalshi.js";
import { startNormalization } from "./normalization.js";
import { startDetector } from "./detector.js";
import { startRiskManager } from "./risk.js";
import { startExecutionEngine } from "./execution.js";
import { startStrategyEvaluation } from "./strategy.js";
import { startMetaController } from "./meta.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = createDb(config, logger);

  const abortController = new AbortController();

  const rawBus = createBroadcastBus<MarketEvent>();
  const normalizedBus = createBroadcastBus<NormalizedMarket>();
  const signalBus = createBroadcastBus<TradeSignal>();
  const commandBus = createBroadcastBus<ExecutionCommand>();
  const fillBus = createBroadcastBus<FillEvent>();

  startPolymarketFeed({
    ...(config.exchanges.polymarket.wsUrl && { url: config.exchanges.polymarket.wsUrl }),
    reconnectDelayMs: config.exchanges.polymarket.reconnectDelayMs,
    bus: rawBus,
    logger,
    signal: abortController.signal,
    ...(config.exchanges.polymarket.marketSlug && { marketSlug: config.exchanges.polymarket.marketSlug }),
  });

  startKalshiFeed({
    ...(config.exchanges.kalshi.wsUrl && { url: config.exchanges.kalshi.wsUrl }),
    reconnectDelayMs: config.exchanges.kalshi.reconnectDelayMs,
    bus: rawBus,
    logger,
    signal: abortController.signal,
    ...(config.exchanges.kalshi.marketTicker && { marketTicker: config.exchanges.kalshi.marketTicker }),
  });

  const stopNormalization = startNormalization({ source: rawBus, target: normalizedBus, logger });
  const stopDetector = startDetector({ source: normalizedBus, signalBus, config, logger });
  const stopRisk = startRiskManager({
    signalSource: signalBus,
    commandBus,
    fillsSource: fillBus,
    logger,
    config,
  });
  const stopExecution = startExecutionEngine({ commandSource: commandBus, fillsBus: fillBus, logger });
  const stopStrategy = startStrategyEvaluation({ fillsSource: fillBus, logger });
  const stopMeta = startMetaController({ logger, config });

  const shutdown = async () => {
    logger.info("Shutting down arbitrage daemon");
    abortController.abort();
    stopNormalization();
    stopDetector();
    stopRisk();
    stopExecution();
    stopStrategy();
    stopMeta();
    await db.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", shutdown);
  }

  logger.info({ env: config.environment }, "Arbitrage daemon started");
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
