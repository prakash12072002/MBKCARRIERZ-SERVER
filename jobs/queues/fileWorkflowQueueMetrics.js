const METRIC_KEYS = Object.freeze([
  "queued",
  "started",
  "succeeded",
  "failed",
  "retried",
  "dropped",
  "enqueueFailed",
  "parseFailed",
]);
const {
  createQueueMetricsPersistenceRuntime,
  isQueueMetricsPersistenceEnabled,
} = require("./fileWorkflowQueueMetricsPersistence");

const buildCounterState = () =>
  METRIC_KEYS.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});

const state = {
  totals: buildCounterState(),
  byType: new Map(),
  lastUpdatedAt: null,
};

let persistenceRuntime = null;
let persistenceBootstrapped = false;

const normalizeJobType = (value) => {
  const normalized = String(value || "").trim();
  return normalized || "unknown";
};

const normalizeOutcome = (value) => {
  const normalized = String(value || "").trim();
  return METRIC_KEYS.includes(normalized) ? normalized : null;
};

const getTypeCounters = (jobType) => {
  const typeKey = normalizeJobType(jobType);
  if (!state.byType.has(typeKey)) {
    state.byType.set(typeKey, buildCounterState());
  }
  return state.byType.get(typeKey);
};

const recordFileWorkflowQueueMetric = ({ jobType, outcome }) => {
  if (!persistenceBootstrapped) {
    persistenceBootstrapped = true;
    if (isQueueMetricsPersistenceEnabled()) {
      persistenceRuntime = createQueueMetricsPersistenceRuntime({
        enabled: true,
        getSnapshotLoader: getFileWorkflowQueueMetricsSnapshot,
      });
      persistenceRuntime.start();
    }
  }

  const normalizedOutcome = normalizeOutcome(outcome);
  if (!normalizedOutcome) return;

  state.totals[normalizedOutcome] += 1;
  const typeCounters = getTypeCounters(jobType);
  typeCounters[normalizedOutcome] += 1;
  state.lastUpdatedAt = new Date().toISOString();
};

const getFileWorkflowQueueMetricsSnapshot = () => {
  const byType = {};
  for (const [jobType, counters] of state.byType.entries()) {
    byType[jobType] = { ...counters };
  }

  return {
    totals: { ...state.totals },
    byType,
    lastUpdatedAt: state.lastUpdatedAt,
  };
};

const resetFileWorkflowQueueMetrics = () => {
  state.totals = buildCounterState();
  state.byType = new Map();
  state.lastUpdatedAt = null;
};

const stopFileWorkflowQueueMetricsPersistence = () => {
  if (persistenceRuntime?.stop) {
    persistenceRuntime.stop();
  }
  persistenceRuntime = null;
  persistenceBootstrapped = false;
};

module.exports = {
  getFileWorkflowQueueMetricsSnapshot,
  recordFileWorkflowQueueMetric,
  resetFileWorkflowQueueMetrics,
  stopFileWorkflowQueueMetricsPersistence,
};
