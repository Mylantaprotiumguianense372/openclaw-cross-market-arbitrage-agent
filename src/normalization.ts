import type { Logger } from "./logger.js";
import type { BroadcastBus } from "./bus.js";
import type { MarketEvent, NormalizedMarket } from "./types.js";
import { Subscription } from "rxjs";

interface NormalizationOptions {
  source: BroadcastBus<MarketEvent>;
  target: BroadcastBus<NormalizedMarket>;
  logger: Logger;
}

export function startNormalization({ source, target, logger }: NormalizationOptions): () => void {
  const subscription = new Subscription();

  const sub = source.stream().subscribe({
    next: (event) => {
      const normalized = normalizeEvent(event);
      if (normalized) {
        target.publish(normalized);
      }
    },
    error: (error) => logger.error({ error }, "Normalization stream error"),
  });

  subscription.add(sub);

  return () => {
    logger.info("Shutting down normalization layer");
    subscription.unsubscribe();
  };
}

function normalizeEvent(event: MarketEvent): NormalizedMarket | null {
  if (event.bid <= 0 || event.ask <= 0) {
    return null;
  }

  const bidProbability = priceToProbability(event.platform, event.bid);
  const askProbability = priceToProbability(event.platform, event.ask);
  const midProbability = (bidProbability + askProbability) / 2;

  const normalized: NormalizedMarket = {
    eventKey: inferEventKey(event),
    canonicalEventKey: toCanonicalEventKey(event),
    platform: event.platform,
    bidProbability,
    askProbability,
    midProbability,
    expirationTs: event.expirationTs,
    marketId: event.marketId,
    feesBps: event.platform === "polymarket" ? 10 : 12,
    updatedAt: event.receivedAt,
  };

  if (typeof event.liquidity === "number") {
    normalized.liquidity = event.liquidity;
  }

  return normalized;
}

function priceToProbability(platform: MarketEvent["platform"], price: number): number {
  if (platform === "polymarket") {
    return Math.min(Math.max(price, 0), 1);
  }

  return Math.min(Math.max(price / 100, 0), 1);
}

function inferEventKey(event: MarketEvent): string {
  return `${event.platform}:${event.marketId}`;
}

/**
 * Maps Kalshi ticker and Polymarket slug to a shared canonical key for cross-venue matching.
 * BTC 15m: KXBTC15M, KXBTC15M-2024-03-04T1200 -> btc-15m-20240304-12
 * Polymarket: btc-updown-15m-1730123400 -> btc-15m-20240304-12 (from unix ts)
 */
function toCanonicalEventKey(event: MarketEvent): string {
  const { platform, marketId } = event;
  if (platform === "kalshi") {
    const m = marketId.match(/^KXBTC15M(?:-(.+))?$/i);
    if (m) {
      const suffix = m[1];
      if (suffix) {
        const dt = suffix.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
        if (dt) return `btc-15m-${dt[1]}${dt[2]}${dt[3]}-${dt[4]}`;
      }
      const d = new Date();
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const h = String(d.getHours()).padStart(2, "0");
      return `btc-15m-${y}${mo}${day}-${h}`;
    }
    return `kalshi:${marketId}`;
  }
  if (platform === "polymarket") {
    const m = marketId.match(/^btc-updown-15m-(\d+)$/i);
    if (m && m[1]) {
      const ts = parseInt(m[1], 10);
      const d = new Date(ts * 1000);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const h = String(d.getHours()).padStart(2, "0");
      return `btc-15m-${y}${mo}${day}-${h}`;
    }
    return `polymarket:${marketId}`;
  }
  return `${platform}:${marketId}`;
}
