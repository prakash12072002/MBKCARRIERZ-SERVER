const fs = require("fs");
const path = require("path");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");

const toBool = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
};

const isQueueMetricsPersistenceEnabled = (env = process.env) =>
  toBool(env.ENABLE_QUEUE_METRICS_PERSISTENCE);

const resolvePersistIntervalMs = (env = process.env) => {
  const parsed = Number.parseInt(
    env.QUEUE_METRICS_PERSIST_INTERVAL_MS || "60000",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
};

const resolveQueueMetricsRetentionDays = (env = process.env) => {
  const raw = env.QUEUE_METRICS_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }

  const parsed = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const resolvePersistDirectory = ({
  env = process.env,
  pathModule = path,
} = {}) =>
  env.QUEUE_METRICS_PERSIST_DIR
    ? pathModule.resolve(env.QUEUE_METRICS_PERSIST_DIR)
    : pathModule.resolve(__dirname, "../../storage/metrics");

const resolveDailyJsonlPath = ({
  outputDir,
  date = new Date(),
  pathModule = path,
} = {}) => {
  const dayToken = date.toISOString().slice(0, 10);
  return pathModule.join(outputDir, `queue-metrics-${dayToken}.jsonl`);
};

const queueMetricsPersistLogger = createStructuredLogger({
  service: "queue-metrics-persistence",
  component: "jsonl-writer",
});

const queueMetricsFilePattern = /^queue-metrics-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const createQueueMetricsRetentionCleaner = ({
  enabled = isQueueMetricsPersistenceEnabled(),
  retentionDays = resolveQueueMetricsRetentionDays(),
  outputDir = resolvePersistDirectory(),
  fsModule = fs,
  pathModule = path,
  nowLoader = () => new Date(),
  logger = queueMetricsPersistLogger,
} = {}) => {
  let lastSweepDayToken = null;

  const isEnabled = () => Boolean(enabled && retentionDays);

  const cleanup = ({
    force = false,
    correlationId = createCorrelationId("queue_metrics_retention"),
  } = {}) => {
    if (!isEnabled()) {
      return {
        cleaned: false,
        reason: "disabled",
      };
    }

    const now = nowLoader();
    const currentDayToken = now.toISOString().slice(0, 10);
    if (!force && lastSweepDayToken === currentDayToken) {
      return {
        cleaned: false,
        reason: "already_swept",
      };
    }
    lastSweepDayToken = currentDayToken;

    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    cutoff.setUTCDate(cutoff.getUTCDate() - (retentionDays - 1));

    let entries = [];
    try {
      entries = fsModule.readdirSync(outputDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          cleaned: true,
          deletedCount: 0,
          scannedCount: 0,
          reason: "missing_dir",
        };
      }

      logger.warn({
        correlationId,
        stage: "queue_metrics_retention_scan_failed",
        status: "retention_cleanup",
        outcome: "failed",
        cleanupMode: "jsonl_retention",
        reason: error?.message || "Unknown error",
        retentionDays,
      });

      return {
        cleaned: false,
        reason: error?.message || "scan_failed",
      };
    }

    let scannedCount = 0;
    let deletedCount = 0;

    for (const entry of entries) {
      if (!entry?.isFile?.()) continue;
      const match = queueMetricsFilePattern.exec(entry.name || "");
      if (!match) continue;

      scannedCount += 1;
      const fileDate = new Date(`${match[1]}T00:00:00.000Z`);
      if (Number.isNaN(fileDate.getTime()) || fileDate >= cutoff) {
        continue;
      }

      const filePath = pathModule.join(outputDir, entry.name);
      try {
        fsModule.unlinkSync(filePath);
        deletedCount += 1;
      } catch (error) {
        logger.warn({
          correlationId,
          stage: "queue_metrics_retention_delete_failed",
          status: "retention_cleanup",
          outcome: "failed",
          cleanupMode: "jsonl_retention",
          reason: error?.message || "Unknown error",
          retentionDays,
          filePath,
        });
      }
    }

    if (deletedCount > 0) {
      logger.info({
        correlationId,
        stage: "queue_metrics_retention_cleanup",
        status: "retention_cleanup",
        outcome: "succeeded",
        cleanupMode: "jsonl_retention",
        reason: null,
        retentionDays,
        scannedCount,
        deletedCount,
      });
    }

    return {
      cleaned: true,
      deletedCount,
      scannedCount,
      cutoff: cutoff.toISOString().slice(0, 10),
    };
  };

  return {
    cleanup,
    isEnabled,
    retentionDays,
  };
};

const createQueueMetricsSnapshotWriter = ({
  enabled = isQueueMetricsPersistenceEnabled(),
  outputDir = resolvePersistDirectory(),
  fsModule = fs,
  pathModule = path,
  nowLoader = () => new Date(),
  logger = queueMetricsPersistLogger,
} = {}) => {
  const writeSnapshot = ({
    queue = "file-workflow",
    snapshot = null,
    source = "interval",
    correlationId = createCorrelationId("queue_metrics_persist"),
  } = {}) => {
    if (!enabled) {
      return {
        written: false,
        reason: "disabled",
      };
    }

    if (!snapshot || typeof snapshot !== "object") {
      return {
        written: false,
        reason: "missing_snapshot",
      };
    }

    const now = nowLoader();
    const filePath = resolveDailyJsonlPath({
      outputDir,
      date: now,
      pathModule,
    });
    const record = {
      ts: now.toISOString(),
      queue,
      source,
      snapshot,
    };

    try {
      fsModule.mkdirSync(outputDir, { recursive: true });
      fsModule.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
      return {
        written: true,
        filePath,
        record,
      };
    } catch (error) {
      logger.warn({
        correlationId,
        stage: "queue_metrics_snapshot_write_failed",
        status: "persistence",
        outcome: "failed",
        cleanupMode: "jsonl_append",
        reason: error?.message || "Unknown error",
        queue,
        filePath,
      });
      return {
        written: false,
        reason: error?.message || "write_failed",
        filePath,
      };
    }
  };

  return {
    writeSnapshot,
  };
};

const createQueueMetricsPersistenceRuntime = ({
  enabled = isQueueMetricsPersistenceEnabled(),
  intervalMs = resolvePersistIntervalMs(),
  getSnapshotLoader,
  writer = createQueueMetricsSnapshotWriter({ enabled }),
  retentionCleaner = createQueueMetricsRetentionCleaner({ enabled }),
  setIntervalLoader = setInterval,
  clearIntervalLoader = clearInterval,
  nowLoader = () => new Date(),
  logger = queueMetricsPersistLogger,
} = {}) => {
  let timer = null;

  const persistOnce = ({
    queue = "file-workflow",
    source = "interval",
    correlationId = createCorrelationId("queue_metrics_persist"),
  } = {}) => {
    if (!enabled) {
      return {
        written: false,
        reason: "disabled",
      };
    }

    const snapshot = getSnapshotLoader?.();
    const writeResult = writer.writeSnapshot({
      queue,
      snapshot,
      source,
      correlationId,
    });
    retentionCleaner.cleanup({ correlationId });
    return writeResult;
  };

  const start = () => {
    if (!enabled || timer) return false;

    retentionCleaner.cleanup({
      correlationId: createCorrelationId("queue_metrics_retention"),
    });

    timer = setIntervalLoader(() => {
      persistOnce({
        queue: "file-workflow",
        source: "interval",
      });
    }, intervalMs);

    if (typeof timer?.unref === "function") {
      timer.unref();
    }

    logger.info({
      correlationId: createCorrelationId("queue_metrics_persist"),
      stage: "queue_metrics_persistence_started",
      status: "persistence",
      outcome: "started",
      cleanupMode: "scheduler",
      reason: null,
      intervalMs,
    });

    return true;
  };

  const stop = () => {
    if (!timer) return false;
    clearIntervalLoader(timer);
    timer = null;
    return true;
  };

  const isRunning = () => Boolean(timer);

  return {
    isEnabled: () => enabled,
    isRunning,
    persistOnce,
    start,
    stop,
  };
};

module.exports = {
  createQueueMetricsRetentionCleaner,
  createQueueMetricsPersistenceRuntime,
  createQueueMetricsSnapshotWriter,
  isQueueMetricsPersistenceEnabled,
  resolveQueueMetricsRetentionDays,
  resolvePersistDirectory,
  resolvePersistIntervalMs,
};
