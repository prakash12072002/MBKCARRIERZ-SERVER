const crypto = require('crypto');
const { getRedisClient, isAvailable } = require('../../config/redis');
const {
  createCorrelationId,
  createStructuredLogger,
} = require('../../shared/utils/structuredLogger');
const {
  getFileWorkflowQueueMetricsSnapshot,
  recordFileWorkflowQueueMetric,
  resetFileWorkflowQueueMetrics,
} = require('./fileWorkflowQueueMetrics');

const FILE_WORKFLOW_QUEUE_KEY = 'mbk:file-workflow:queue:v1';
const FILE_WORKFLOW_QUEUE_POLL_INTERVAL_MS = Math.max(
  100,
  Number.parseInt(process.env.FILE_WORKFLOW_QUEUE_POLL_INTERVAL_MS || '500', 10) || 500,
);
const FILE_WORKFLOW_QUEUE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.FILE_WORKFLOW_QUEUE_CONCURRENCY || '2', 10) || 2,
);
const DEFAULT_JOB_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.FILE_WORKFLOW_JOB_MAX_ATTEMPTS || '3', 10) || 3,
);

const inMemoryQueue = [];
const handlers = new Map();
let workerStarted = false;
let activeWorkers = 0;
let tickTimer = null;

const queueLogger = createStructuredLogger({
  service: 'file-workflow-queue',
  component: 'worker',
});

const toSafeString = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const extractTelemetryFromJob = (job = {}) => {
  const payload = job?.payload || {};
  return {
    correlationId: toSafeString(payload?.correlationId || job?.correlationId),
    trainerId: toSafeString(payload?.trainerId),
    documentId: toSafeString(payload?.documentId),
    scheduleId: toSafeString(payload?.scheduleId),
    attendanceId: toSafeString(payload?.attendanceId),
    cleanupMode: toSafeString(payload?.contextLabel || payload?.cleanupMode),
  };
};

const logQueueTelemetry = (level, fields = {}) => {
  const method = typeof queueLogger[level] === 'function' ? level : 'info';
  queueLogger[method]({
    correlationId: fields.correlationId || null,
    stage: fields.stage || null,
    trainerId: fields.trainerId || null,
    documentId: fields.documentId || null,
    scheduleId: fields.scheduleId || null,
    attendanceId: fields.attendanceId || null,
    status: fields.status || null,
    attempt: Number.isFinite(fields.attempt) ? fields.attempt : null,
    outcome: fields.outcome || null,
    cleanupMode: fields.cleanupMode || null,
    reason: fields.reason || null,
    jobId: fields.jobId || null,
    jobType: fields.jobType || null,
    queueMode: fields.queueMode || null,
  });
};

const now = () => Date.now();

const generateJobId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${now()}-${Math.random().toString(16).slice(2)}`;

const canUseRedisQueue = () => {
  try {
    const redis = getRedisClient();
    return isAvailable() && redis?.status === 'ready';
  } catch (_error) {
    return false;
  }
};

const serializeJob = (job) => JSON.stringify(job);

const parseJob = (raw) => {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    recordFileWorkflowQueueMetric({
      jobType: 'unknown',
      outcome: 'parseFailed',
    });
    logQueueTelemetry('error', {
      stage: 'job_parse_failed',
      status: 'parse',
      outcome: 'failed',
      reason: error.message,
      jobType: 'unknown',
    });
    return null;
  }
};

const pushToQueueStorage = async (job) => {
  if (canUseRedisQueue()) {
    const redis = getRedisClient();
    await redis.lpush(FILE_WORKFLOW_QUEUE_KEY, serializeJob(job));
    return 'redis';
  }

  inMemoryQueue.unshift(job);
  return 'memory';
};

const pullNextJob = async () => {
  if (canUseRedisQueue()) {
    const redis = getRedisClient();
    const raw = await redis.rpop(FILE_WORKFLOW_QUEUE_KEY);
    return parseJob(raw);
  }

  if (!inMemoryQueue.length) return null;
  return inMemoryQueue.pop();
};

const resolveRetryDelayMs = (attempt) => {
  const initialDelayMs = Math.max(
    100,
    Number.parseInt(process.env.FILE_WORKFLOW_RETRY_INITIAL_DELAY_MS || '500', 10) || 500,
  );
  const maxDelayMs = Math.max(
    initialDelayMs,
    Number.parseInt(process.env.FILE_WORKFLOW_RETRY_MAX_DELAY_MS || '10000', 10) || 10000,
  );
  const multiplier = Math.max(
    1,
    Number.parseInt(process.env.FILE_WORKFLOW_RETRY_BACKOFF_MULTIPLIER || '2', 10) || 2,
  );

  return Math.min(initialDelayMs * multiplier ** Math.max(0, attempt - 1), maxDelayMs);
};

const scheduleRetry = async (job, errorMessage) => {
  const attempt = Number.parseInt(job?.attempt || '0', 10) + 1;
  const maxAttempts = Number.parseInt(job?.maxAttempts || `${DEFAULT_JOB_MAX_ATTEMPTS}`, 10);
  const telemetry = extractTelemetryFromJob(job);

  if (!Number.isFinite(maxAttempts) || attempt > maxAttempts) {
    recordFileWorkflowQueueMetric({
      jobType: job?.type,
      outcome: 'dropped',
    });
    logQueueTelemetry('error', {
      ...telemetry,
      stage: 'job_retry_exhausted',
      status: 'retry',
      outcome: 'dropped',
      attempt,
      reason: errorMessage,
      jobId: job?.id || null,
      jobType: job?.type || null,
    });
    return;
  }

  const nextJob = {
    ...job,
    attempt,
    lastError: errorMessage,
    queuedAt: now(),
  };

  const retryDelayMs = resolveRetryDelayMs(attempt);
  recordFileWorkflowQueueMetric({
    jobType: job?.type,
    outcome: 'retried',
  });
  logQueueTelemetry('warn', {
    ...telemetry,
    stage: 'job_retry_scheduled',
    status: 'retry',
    outcome: 'scheduled',
    attempt,
    reason: errorMessage,
    jobId: job?.id || null,
    jobType: job?.type || null,
  });
  setTimeout(() => {
    pushToQueueStorage(nextJob).catch((queueError) => {
      recordFileWorkflowQueueMetric({
        jobType: nextJob?.type,
        outcome: 'enqueueFailed',
      });
      logQueueTelemetry('error', {
        ...telemetry,
        stage: 'job_retry_enqueue_failed',
        status: 'retry',
        outcome: 'failed',
        attempt,
        reason: queueError.message,
        jobId: nextJob?.id || null,
        jobType: nextJob?.type || null,
      });
    });
  }, retryDelayMs);
};

const processJob = async (job) => {
  if (!job?.type) return;

  const handler = handlers.get(job.type);
  const attempt = Number.parseInt(job?.attempt || '0', 10) + 1;
  const telemetry = extractTelemetryFromJob(job);
  if (!handler) {
    recordFileWorkflowQueueMetric({
      jobType: job?.type,
      outcome: 'dropped',
    });
    logQueueTelemetry('warn', {
      ...telemetry,
      stage: 'job_no_handler',
      status: 'dispatch',
      outcome: 'dropped',
      attempt,
      reason: 'No handler registered',
      jobId: job?.id || null,
      jobType: job?.type || null,
    });
    return;
  }

  recordFileWorkflowQueueMetric({
    jobType: job?.type,
    outcome: 'started',
  });
  logQueueTelemetry('info', {
    ...telemetry,
    stage: 'job_started',
    status: 'processing',
    outcome: 'started',
    attempt,
    jobId: job?.id || null,
    jobType: job?.type || null,
  });
  try {
    await handler(job.payload || {}, job);
    recordFileWorkflowQueueMetric({
      jobType: job?.type,
      outcome: 'succeeded',
    });
    logQueueTelemetry('info', {
      ...telemetry,
      stage: 'job_completed',
      status: 'processing',
      outcome: 'succeeded',
      attempt,
      jobId: job?.id || null,
      jobType: job?.type || null,
    });
  } catch (error) {
    recordFileWorkflowQueueMetric({
      jobType: job?.type,
      outcome: 'failed',
    });
    logQueueTelemetry('warn', {
      ...telemetry,
      stage: 'job_failed',
      status: 'processing',
      outcome: 'failed',
      attempt,
      reason: error?.message || 'Unknown error',
      jobId: job?.id || null,
      jobType: job?.type || null,
    });
    await scheduleRetry(job, error?.message || 'Unknown error');
  }
};

const tickWorker = async () => {
  if (activeWorkers >= FILE_WORKFLOW_QUEUE_CONCURRENCY) return;
  activeWorkers += 1;

  try {
    const job = await pullNextJob();
    if (!job) return;
    await processJob(job);
  } catch (error) {
    logQueueTelemetry('error', {
      stage: 'worker_tick_failed',
      status: 'worker',
      outcome: 'failed',
      reason: error.message,
    });
  } finally {
    activeWorkers = Math.max(0, activeWorkers - 1);
  }
};

const startFileWorkflowQueueWorker = () => {
  if (workerStarted) return;

  workerStarted = true;
  tickTimer = setInterval(() => {
    void tickWorker();
  }, FILE_WORKFLOW_QUEUE_POLL_INTERVAL_MS);
  if (typeof tickTimer.unref === 'function') {
    tickTimer.unref();
  }

  logQueueTelemetry('info', {
    stage: 'worker_started',
    status: 'worker',
    outcome: 'started',
    cleanupMode: 'polling',
    attempt: 1,
    reason: null,
    queueMode: canUseRedisQueue() ? 'redis' : 'memory',
  });
};

const stopFileWorkflowQueueWorker = () => {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  workerStarted = false;
};

const registerFileWorkflowJobHandler = (jobType, handler) => {
  if (!jobType || typeof handler !== 'function') {
    throw new Error('registerFileWorkflowJobHandler requires a valid jobType and handler');
  }

  handlers.set(String(jobType), handler);
  startFileWorkflowQueueWorker();
};

const enqueueFileWorkflowJob = async ({
  type,
  payload = {},
  maxAttempts = DEFAULT_JOB_MAX_ATTEMPTS,
}) => {
  if (!type) {
    throw new Error('enqueueFileWorkflowJob requires a job type');
  }

  startFileWorkflowQueueWorker();

  const job = {
    id: generateJobId(),
    type: String(type),
    payload,
    correlationId: toSafeString(payload?.correlationId) || createCorrelationId('file_job'),
    attempt: 0,
    maxAttempts,
    queuedAt: now(),
  };

  const mode = await pushToQueueStorage(job);
  recordFileWorkflowQueueMetric({
    jobType: job.type,
    outcome: 'queued',
  });
  const telemetry = extractTelemetryFromJob(job);
  logQueueTelemetry('info', {
    ...telemetry,
    stage: 'job_queued',
    status: 'queued',
    outcome: 'queued',
    attempt: 0,
    jobId: job.id,
    jobType: job.type,
    queueMode: mode,
  });
  return {
    queued: true,
    mode,
    jobId: job.id,
    type: job.type,
  };
};

module.exports = {
  enqueueFileWorkflowJob,
  getFileWorkflowQueueMetricsSnapshot,
  registerFileWorkflowJobHandler,
  resetFileWorkflowQueueMetrics,
  startFileWorkflowQueueWorker,
  stopFileWorkflowQueueWorker,
};
