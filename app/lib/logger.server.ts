const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LevelKey = keyof typeof LEVELS;

const currentLevel = (() => {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LevelKey | undefined;
  return envLevel && envLevel in LEVELS ? LEVELS[envLevel] : LEVELS.info;
})();

function shouldLog(level: number): boolean {
  return level >= currentLevel;
}

function formatMessage(level: LevelKey, message: string, ctx?: object): string {
  const timestamp = new Date().toISOString();
  const ctxStr = ctx ? ` ${JSON.stringify(ctx)}` : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${ctxStr}`;
}

export const logger = {
  debug(message: string, ctx?: object) {
    if (shouldLog(LEVELS.debug)) {
      console.log(formatMessage("debug", message, ctx));
    }
  },

  info(message: string, ctx?: object) {
    if (shouldLog(LEVELS.info)) {
      console.log(formatMessage("info", message, ctx));
    }
  },

  warn(message: string, ctx?: object) {
    if (shouldLog(LEVELS.warn)) {
      console.warn(formatMessage("warn", message, ctx));
    }
  },

  error(message: string, ctx?: object) {
    if (shouldLog(LEVELS.error)) {
      console.error(formatMessage("error", message, ctx));
    }
  },
};