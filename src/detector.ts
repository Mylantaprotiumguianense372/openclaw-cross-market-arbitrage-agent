import { Subscription } from "rxjs";
import { randomUUID } from "node:crypto";
import type { BroadcastBus } from "./bus.js";
import type { Logger } from "./logger.js";
import type { AppConfig } from "./config.js";
import type { NormalizedMarket, TradeSignal } from "./types.js";

interface DetectorOptions {
  source: BroadcastBus<NormalizedMarket>;
  signalBus: BroadcastBus<TradeSignal>;
  config: AppConfig;
  logger: Logger;
}

/** Cross-venue state: canonicalEventKey -> platform -> NormalizedMarket */
type VenueMap = Map<string, Map<"kalshi" | "polymarket", NormalizedMarket>>;

export function startDetector({ source, signalBus, config, logger }: DetectorOptions): () => void {
  const latestByCanonical: VenueMap = new Map();
  const subscription = new Subscription();

  const sub = source.stream().subscribe({
    next: (market) => {
      const canonical = market.canonicalEventKey;
      const venueMap = getVenueMap(latestByCanonical, canonical);
      venueMap.set(market.platform, market);

      if (venueMap.size < 2) return;

      const venues = Array.from(venueMap.values());
      const [a, b] = venues as [NormalizedMarket, NormalizedMarket];
      evaluatePair(a, b);
    },
    error: (error) => logger.error({ error }, "Detector stream error"),
  });

  subscription.add(sub);

  function evaluatePair(a: NormalizedMarket, b: NormalizedMarket) {
    if (a.platform === b.platform) return;

    const spread = Math.abs(a.midProbability - b.midProbability);
    const fees = (a.feesBps + b.feesBps) / 10_000;
    const slippage = config.strategy.maxSlippageBps / 10_000;
    const netEdge = spread - fees - slippage;

    if (netEdge < config.strategy.edgeThreshold) return;

    const liquidityA = a.liquidity ?? config.risk.liquidityThreshold;
    const liquidityB = b.liquidity ?? config.risk.liquidityThreshold;
    const size = Math.min(liquidityA, liquidityB);
    if (size <= 0) return;

    const longMarket = a.midProbability < b.midProbability ? a : b;
    const shortMarket = a.midProbability < b.midProbability ? b : a;

    const signal: TradeSignal = {
      signalId: randomUUID(),
      eventKey: a.canonicalEventKey,
      longVenue: longMarket.platform,
      shortVenue: shortMarket.platform,
      longMarketId: longMarket.marketId,
      shortMarketId: shortMarket.marketId,
      longProbability: longMarket.midProbability,
      shortProbability: shortMarket.midProbability,
      rawEdge: spread,
      netEdge,
      size,
      createdAt: Date.now(),
    };

    signalBus.publish(signal);
    logger.info({ signal, spread, netEdge }, "Arbitrage signal emitted");
  }

  return () => {
    logger.info("Shutting down detector");
    subscription.unsubscribe();
    latestByCanonical.clear();
  };
}

function getVenueMap(map: VenueMap, key: string): Map<"kalshi" | "polymarket", NormalizedMarket> {
  if (!map.has(key)) map.set(key, new Map());
  return map.get(key)!;
}
