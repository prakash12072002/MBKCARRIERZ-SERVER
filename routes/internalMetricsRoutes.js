const express = require('express');
const { auth, authorize } = require('../middleware/auth');
const {
  getFileWorkflowQueueMetricsSnapshot,
} = require('../jobs/queues/fileWorkflowQueue');
const {
  getAsyncQueueMetricsSnapshot,
} = require('../jobs/queues/asyncQueueMetricsSnapshot');
const {
  createCorrelationId,
  createStructuredLogger,
} = require('../shared/utils/structuredLogger');

const toBool = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
};

const isInternalMetricsSnapshotEnabled = (env = process.env) =>
  toBool(env.ENABLE_INTERNAL_METRICS_SNAPSHOT);

const metricsLogger = createStructuredLogger({
  service: 'internal-metrics',
  component: 'queue-metrics-snapshot',
});

const createInternalMetricsRouter = ({
  enabled = isInternalMetricsSnapshotEnabled(),
  authenticate = auth,
  authorizeSuperAdmin = authorize(['SuperAdmin']),
  getQueueSnapshot = getFileWorkflowQueueMetricsSnapshot,
  getAllQueueSnapshots = getAsyncQueueMetricsSnapshot,
} = {}) => {
  const router = express.Router();

  const requireInternalMetricsEnabled = (req, res, next) => {
    if (!enabled) {
      return res.status(404).json({
        success: false,
        message: 'Not found',
      });
    }
    return next();
  };

  router.get(
    '/queues',
    requireInternalMetricsEnabled,
    authenticate,
    authorizeSuperAdmin,
    (req, res) => {
      const correlationId =
        req.headers['x-correlation-id'] ||
        req.headers['x-request-id'] ||
        createCorrelationId('internal_metrics');
      const snapshot = getAllQueueSnapshots();

      metricsLogger.info({
        correlationId,
        stage: 'metrics_all_queues_snapshot_requested',
        status: 'metrics_snapshot',
        outcome: 'succeeded',
        cleanupMode: 'read_only',
        reason: null,
        actorUserId: req.user?.id || null,
      });

      return res.json({
        success: true,
        data: snapshot,
      });
    },
  );

  router.get(
    '/queues/file-workflow',
    requireInternalMetricsEnabled,
    authenticate,
    authorizeSuperAdmin,
    (req, res) => {
      const correlationId =
        req.headers['x-correlation-id'] ||
        req.headers['x-request-id'] ||
        createCorrelationId('internal_metrics');
      const snapshot = getQueueSnapshot();

      metricsLogger.info({
        correlationId,
        stage: 'metrics_snapshot_requested',
        status: 'metrics_snapshot',
        outcome: 'succeeded',
        cleanupMode: 'read_only',
        reason: null,
        actorUserId: req.user?.id || null,
      });

      return res.json({
        success: true,
        data: {
          queue: 'file-workflow',
          snapshot,
        },
      });
    },
  );

  return router;
};

module.exports = createInternalMetricsRouter();
module.exports.createInternalMetricsRouter = createInternalMetricsRouter;
module.exports.isInternalMetricsSnapshotEnabled = isInternalMetricsSnapshotEnabled;
