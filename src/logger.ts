import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: pino.Level = "info"): Logger {
  if (process.env.NODE_ENV === "production") {
    return pino({ level });
  }

  return pino({
    level,
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:standard",
        colorize: true,
      },
    },
  });
}
