const { createCorrelationId } = require("./structuredLogger");

const resolveRequestCorrelationId = (
  req,
  { prefix = "ctrl", createCorrelationIdLoader = createCorrelationId } = {},
) =>
  req?.headers?.["x-correlation-id"] ||
  req?.headers?.["x-request-id"] ||
  req?.correlationId ||
  createCorrelationIdLoader(prefix);

const buildControllerErrorTelemetry = (
  req,
  {
    stage,
    error,
    status = "controller",
    outcome = "failed",
    cleanupMode = "none",
    correlationPrefix = "ctrl",
    fields = {},
    createCorrelationIdLoader = createCorrelationId,
  } = {},
) => ({
  correlationId: resolveRequestCorrelationId(req, {
    prefix: correlationPrefix,
    createCorrelationIdLoader,
  }),
  stage: stage || null,
  status,
  outcome,
  cleanupMode,
  reason: error?.message || "Unknown error",
  ...fields,
});

const logControllerError = (
  logger,
  {
    req,
    stage,
    error,
    level = "error",
    fields = {},
    status = "controller",
    outcome = "failed",
    cleanupMode = "none",
    correlationPrefix = "ctrl",
    createCorrelationIdLoader = createCorrelationId,
  } = {},
) => {
  const method = typeof logger?.[level] === "function" ? level : "error";
  logger?.[method]?.(
    buildControllerErrorTelemetry(req, {
      stage,
      error,
      status,
      outcome,
      cleanupMode,
      correlationPrefix,
      fields,
      createCorrelationIdLoader,
    }),
  );
};

module.exports = {
  buildControllerErrorTelemetry,
  logControllerError,
  resolveRequestCorrelationId,
};
