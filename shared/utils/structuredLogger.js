const LEVEL_PRIORITY = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
});

const DEFAULT_PRODUCTION_LEVEL = "warn";
const DEFAULT_NON_PRODUCTION_LEVEL = "info";

const normalizeLevel = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return LEVEL_PRIORITY[normalized] ? normalized : null;
};

const resolveLogLevel = (explicitLevel = null) => {
  const fromExplicit = normalizeLevel(explicitLevel);
  if (fromExplicit) return fromExplicit;

  const fromEnv = normalizeLevel(
    process.env.STRUCTURED_LOG_LEVEL || process.env.LOG_LEVEL,
  );
  if (fromEnv) return fromEnv;

  return process.env.NODE_ENV === "production"
    ? DEFAULT_PRODUCTION_LEVEL
    : DEFAULT_NON_PRODUCTION_LEVEL;
};

const shouldLog = (targetLevel, currentLevel) => {
  const target = LEVEL_PRIORITY[normalizeLevel(targetLevel) || "off"];
  const current = LEVEL_PRIORITY[normalizeLevel(currentLevel) || "off"];
  return target >= current;
};

const createCorrelationId = (prefix = "req") =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const createStructuredLogger = ({
  service = "app",
  component = null,
  level = null,
  sink = console,
} = {}) => {
  const currentLevel = resolveLogLevel(level);

  const write = (targetLevel, payload = {}) => {
    if (!shouldLog(targetLevel, currentLevel)) return;

    const entry = {
      ts: new Date().toISOString(),
      level: targetLevel,
      service,
      ...(component ? { component } : {}),
      ...payload,
    };

    const writer = sink?.[targetLevel] || sink?.log || console.log;
    writer("[OBS]", JSON.stringify(entry));
  };

  return {
    level: currentLevel,
    debug: (payload) => write("debug", payload),
    info: (payload) => write("info", payload),
    warn: (payload) => write("warn", payload),
    error: (payload) => write("error", payload),
  };
};

module.exports = {
  createCorrelationId,
  createStructuredLogger,
  resolveLogLevel,
};
