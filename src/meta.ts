import type { Logger } from "./logger.js";
import type { AppConfig } from "./config.js";

interface MetaOptions {
  logger: Logger;
  config: AppConfig;
}

export function startMetaController({ logger, config }: MetaOptions): () => void {
  const interval = setInterval(() => {
    logger.info({ llmAgent: config.meta.llmAgent }, "Meta controller tick (placeholder)");
  }, 60_000);

  return () => {
    clearInterval(interval);
    logger.info("Shutting down meta controller");
  };
}
