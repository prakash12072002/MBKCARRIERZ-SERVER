const {
  getFileWorkflowQueueMetricsSnapshot,
} = require("./fileWorkflowQueueMetrics");

const KNOWN_COUNTER_KEYS = Object.freeze([
  "queued",
  "started",
  "succeeded",
  "failed",
  "retried",
  "dropped",
  "enqueueFailed",
  "parseFailed",
]);

const createEmptyTotals = () =>
  KNOWN_COUNTER_KEYS.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});

const mergeTotals = (target, source = {}) => {
  for (const key of KNOWN_COUNTER_KEYS) {
    target[key] += Number.parseInt(source?.[key] || "0", 10) || 0;
  }
  return target;
};

const getAsyncQueueMetricsSnapshot = ({
  getFileWorkflowSnapshot = getFileWorkflowQueueMetricsSnapshot,
} = {}) => {
  const fileWorkflow = getFileWorkflowSnapshot();
  const aggregateTotals = mergeTotals(createEmptyTotals(), fileWorkflow?.totals);

  return {
    generatedAt: new Date().toISOString(),
    queues: {
      fileWorkflow,
    },
    totals: aggregateTotals,
  };
};

module.exports = {
  getAsyncQueueMetricsSnapshot,
};
