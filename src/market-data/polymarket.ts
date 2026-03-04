/**
 * Polymarket WebSocket market feed - connects to CLOB WS, fetches token IDs from Gamma API,
 * subscribes to best_bid_ask, maps to MarketEvent. Uses same pattern as trading/kalshi-trading-bot.
 */
import WebSocket from "ws";
import type { Logger } from "../logger.js";
import type { BroadcastBus } from "../bus.js";
import type { MarketEvent } from "../types.js";

const POLYMARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const MARKET_CHANNEL = "market";
const PING_INTERVAL_MS = 10000;

interface MarketFeedOptions {
  url?: string;
  reconnectDelayMs: number;
  bus: BroadcastBus<MarketEvent>;
  logger: Logger;
  signal: AbortSignal;
  /** Market slug (e.g. btc-updown-15m-{timestamp}). Uses slugForCurrent15m() when omitted. */
  marketSlug?: string;
}

function parseJsonArray<T>(raw: unknown, ctx: string): T[] {
  if (raw == null) throw new Error(`${ctx}: missing`);
  const str = typeof raw === "string" ? raw : JSON.stringify(raw);
  const parsed: unknown = JSON.parse(str);
  if (!Array.isArray(parsed)) throw new Error(`${ctx}: expected JSON array`);
  return parsed as T[];
}

function current15mTimestamp(): number {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMilliseconds(0);
  const m = d.getMinutes();
  d.setMinutes(Math.floor(m / 15) * 15, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function slugForCurrent15m(market = "btc"): string {
  const ts = current15mTimestamp();
  return `${market}-updown-15m-${ts}`;
}

export interface TokenIds {
  upTokenId: string;
  downTokenId: string;
  conditionId: string;
  slug: string;
}

/** Fetch Up/Down token IDs for a Polymarket market slug from Gamma API. Exported for execution. */
export async function fetchTokenIdsForSlug(slug: string): Promise<TokenIds> {
  const url = `${GAMMA_API_BASE}/markets/slug/${slug}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status} ${res.statusText} for slug=${slug}`);
  }
  const data = (await res.json()) as {
    outcomes?: string[] | string;
    clobTokenIds?: string[] | string;
    conditionId?: string;
  };
  const outcomes = parseJsonArray<string>(data.outcomes, "outcomes");
  const tokenIds = parseJsonArray<string>(data.clobTokenIds, "clobTokenIds");
  if (outcomes.length === 0 || tokenIds.length === 0) {
    throw new Error(`Invalid Gamma response for slug=${slug}`);
  }
  const upIdx = outcomes.indexOf("Up");
  const downIdx = outcomes.indexOf("Down");
  if (upIdx < 0 || downIdx < 0) {
    throw new Error(`Missing Up/Down outcomes for slug=${slug}`);
  }
  const upTokenId = tokenIds[upIdx];
  const downTokenId = tokenIds[downIdx];
  if (!upTokenId || !downTokenId) {
    throw new Error(`Missing token IDs for slug=${slug}`);
  }
  return {
    upTokenId,
    downTokenId,
    conditionId: data.conditionId ?? "",
    slug,
  };
}

export function startPolymarketFeed({
  url,
  reconnectDelayMs,
  bus,
  logger,
  signal,
  marketSlug: initialSlug,
}: MarketFeedOptions): void {
  const wsUrl = url ?? POLYMARKET_WS_URL;
  let ws: WebSocket | null = null;
  let tokenIds: TokenIds | null = null;
  let currentSlug = initialSlug ?? slugForCurrent15m();
  let upAsk = 0;
  let downAsk = 0;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let checkInterval: ReturnType<typeof setInterval> | null = null;

  const emitMarketEvent = () => {
    if (!tokenIds || (upAsk <= 0 && downAsk <= 0)) return;
    if (upAsk <= 0) upAsk = 1 - downAsk;
    if (downAsk <= 0) downAsk = 1 - upAsk;
    const bid = 1 - downAsk;
    const ask = upAsk;
    const event: MarketEvent = {
      marketId: tokenIds.slug,
      platform: "polymarket",
      bid,
      ask,
      expirationTs: Date.now(),
      receivedAt: Date.now(),
      raw: { slug: tokenIds.slug, upAsk, downAsk },
    };
    bus.publish(event);
  };

  const handleBestBidAsk = (msg: { asset_id?: string; best_bid?: string; best_ask?: string }) => {
    const assetId = msg.asset_id;
    if (!assetId || !tokenIds) return;
    const bestAskStr = msg.best_ask;
    if (bestAskStr == null) return;
    const askVal = parseFloat(bestAskStr);
    if (!Number.isFinite(askVal)) return;
    if (assetId === tokenIds.upTokenId) {
      upAsk = askVal;
      emitMarketEvent();
    } else if (assetId === tokenIds.downTokenId) {
      downAsk = askVal;
      emitMarketEvent();
    }
  };

  const subscribe = (ids: TokenIds) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || signal.aborted) return;
    ws.send(
      JSON.stringify({
        assets_ids: [ids.upTokenId, ids.downTokenId],
        type: MARKET_CHANNEL,
        custom_feature_enabled: true,
      })
    );
    logger.info({ slug: ids.slug }, "Polymarket subscribe sent");
  };

  const startPing = () => {
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send("PING");
    }, PING_INTERVAL_MS);
  };

  const stopPing = () => {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  };

  const ensureTokenIds = async (): Promise<TokenIds> => {
    const slug = initialSlug ?? slugForCurrent15m();
    if (tokenIds && tokenIds.slug === slug) return tokenIds;
    const ids = await fetchTokenIdsForSlug(slug);
    tokenIds = ids;
    currentSlug = slug;
    upAsk = 0;
    downAsk = 0;
    return ids;
  };

  const checkMarketCycle = async () => {
    if (signal.aborted || !ws || ws.readyState !== WebSocket.OPEN) return;
    const slug = initialSlug ?? slugForCurrent15m();
    if (slug === currentSlug) return;
    try {
      const ids = await ensureTokenIds();
      subscribe(ids);
    } catch (err) {
      logger.warn({ err }, "Polymarket market cycle refresh failed");
    }
  };

  const connect = async () => {
    if (signal.aborted) return;

    try {
      await ensureTokenIds();
    } catch (err) {
      logger.warn({ err }, "Polymarket: failed to fetch token IDs, retrying");
      if (!signal.aborted) setTimeout(() => connect(), reconnectDelayMs);
      return;
    }

    logger.info({ url: wsUrl }, "Connecting to Polymarket feed");
    ws = new WebSocket(wsUrl);

    ws.on("open", async () => {
      logger.info("Polymarket WebSocket connected");
      if (tokenIds) {
        subscribe(tokenIds);
        startPing();
      }
    });

    ws.on("message", (data) => {
      const raw = (data as Buffer).toString();
      if (raw === "PING") {
        ws?.send("PONG");
        return;
      }
      if (raw === "PONG") return;
      try {
        const parsed = JSON.parse(raw) as { event_type?: string; type?: string; message?: string };
        if (parsed.event_type === "best_bid_ask") {
          handleBestBidAsk(parsed as { asset_id?: string; best_ask?: string });
          return;
        }
        if (parsed.type === "error" || parsed.event_type === "error") {
          logger.warn({ msg: parsed.message }, "Polymarket WS error");
        }
      } catch {
        // ignore non-JSON
      }
    });

    ws.on("ping", () => ws?.pong());

    ws.on("close", (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, "Polymarket WebSocket closed");
      ws = null;
      stopPing();
      if (!signal.aborted) {
        setTimeout(() => connect(), reconnectDelayMs);
      }
    });

    ws.on("error", (error) => {
      logger.error({ error }, "Polymarket WebSocket error");
      ws?.close();
    });
  };

  signal.addEventListener("abort", () => {
    logger.info("Stopping Polymarket market data feed");
    stopPing();
    if (checkInterval) clearInterval(checkInterval);
    ws?.close();
  });

  connect();
  checkInterval = setInterval(checkMarketCycle, 10_000);
}
