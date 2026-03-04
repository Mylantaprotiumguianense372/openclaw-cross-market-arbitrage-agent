export interface MarketEvent {
  marketId: string;
  platform: "polymarket" | "kalshi";
  bid: number;
  ask: number;
  lastPrice?: number;
  volume24h?: number;
  liquidity?: number;
  impliedProbability?: number;
  expirationTs: number;
  receivedAt: number;
  raw: unknown;
}

export interface NormalizedMarket {
  /** Platform-prefixed key (e.g. kalshi:KXBTC15M-xxx). */
  eventKey: string;
  /** Cross-venue canonical key for matching (e.g. btc-15m-20240304-12). */
  canonicalEventKey: string;
  platform: "polymarket" | "kalshi";
  bidProbability: number;
  askProbability: number;
  midProbability: number;
  expirationTs: number;
  marketId: string;
  liquidity?: number;
  feesBps: number;
  updatedAt: number;
}

export interface TradeSignal {
  signalId: string;
  eventKey: string;
  longVenue: "polymarket" | "kalshi";
  shortVenue: "polymarket" | "kalshi";
  /** Platform-specific market ID for long venue (Kalshi ticker or Polymarket slug). */
  longMarketId: string;
  /** Platform-specific market ID for short venue. */
  shortMarketId: string;
  longProbability: number;
  shortProbability: number;
  rawEdge: number;
  netEdge: number;
  size: number;
  createdAt: number;
}

export interface RiskDecision {
  signalId: string;
  approved: boolean;
  reason?: string;
  maxSize?: number;
  decidedAt: number;
}

export interface ExecutionCommand {
  signalId: string;
  eventKey: string;
  longVenue: "polymarket" | "kalshi";
  shortVenue: "polymarket" | "kalshi";
  longMarketId: string;
  shortMarketId: string;
  size: number;
  targetEdge: number;
}

export interface FillEvent {
  signalId: string;
  eventKey: string;
  longVenueFill?: boolean;
  shortVenueFill?: boolean;
  filledSize: number;
  avgPriceLong?: number;
  avgPriceShort?: number;
  latencyMs?: number;
  status: "partial" | "filled" | "failed";
  error?: string;
  timestamp: number;
}

export interface StrategyMetrics {
  totalSignals: number;
  filledSignals: number;
  rejectedSignals: number;
  grossPnl: number;
  netPnl: number;
  averageLatencyMs: number;
  updatedAt: number;
}
