const multer = require("multer");
const path = require("path");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "application/octet-stream",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);
    const allowedExtensions = new Set([
      ".jpeg",
      ".jpg",
      ".png",
      ".pdf",
      ".doc",
      ".docx",
    ]);

    const extname = allowedExtensions.has(
      path.extname(file.originalname).toLowerCase(),
    );
    const mimetype = allowedMimeTypes.has(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    }

    cb(
      new Error(
        "Invalid file type. Only JPG, PNG, PDF, DOC, and DOCX are allowed.",
      ),
    );
  },
});

const documentsUploadLogger = createStructuredLogger({
  service: "documents",
  component: "upload-middleware",
});

const resolveCorrelationId = (req, createCorrelationIdLoader = createCorrelationId) => (
  req?.headers?.["x-correlation-id"]
  || req?.headers?.["x-request-id"]
  || req?.correlationId
  || createCorrelationIdLoader("doc_upload_mw")
);

const resolveRouteFamily = (url = "") => {
  if (url.includes("/api/v1/documents")) return "v1-documents";
  if (url.includes("/api/trainer-documents")) return "legacy-documents";
  return null;
};

const logUploadMiddlewareTelemetry = (logger, level, fields = {}) => {
  const method = typeof logger?.[level] === "function" ? level : "info";
  logger?.[method]?.({
    correlationId: fields.correlationId || null,
    stage: fields.stage || null,
    trainerId: fields.trainerId || null,
    documentId: fields.documentId || null,
    scheduleId: fields.scheduleId || null,
    status: fields.status || null,
    attempt: Number.isFinite(fields.attempt) ? fields.attempt : null,
    outcome: fields.outcome || null,
    cleanupMode: fields.cleanupMode || null,
    reason: fields.reason || null,
    routeFamily: fields.routeFamily || null,
    uploadField: fields.uploadField || null,
  });
};

const createUploadTrainerDocumentMiddleware = ({
  uploadInstance = upload,
  logger = documentsUploadLogger,
  createCorrelationIdLoader = createCorrelationId,
} = {}) => (req, res, next) => {
  const uploadMiddleware = uploadInstance.fields([
    { name: "document", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]);
  const correlationId = resolveCorrelationId(req, createCorrelationIdLoader);
  req.correlationId = req.correlationId || correlationId;
  const routeFamily = resolveRouteFamily(req?.originalUrl || req?.url || "");
  const trainerId = req?.params?.trainerId || req?.body?.targetTrainerId || null;

  uploadMiddleware(req, res, (err) => {
    if (err) {
      logUploadMiddlewareTelemetry(logger, "warn", {
        correlationId,
        trainerId,
        stage: "upload_middleware_error",
        status: "upload_middleware",
        outcome: "failed",
        cleanupMode: "upload_validation",
        reason: err.message,
        routeFamily,
      });
      return next(err);
    }

    if (req.files) {
      if (req.files.document && req.files.document[0]) {
        req.file = req.files.document[0];
      } else if (req.files.file && req.files.file[0]) {
        req.file = req.files.file[0];
      }
    }

    if (req.file) {
      logUploadMiddlewareTelemetry(logger, "debug", {
        correlationId,
        trainerId,
        stage: "upload_middleware_file_resolved",
        status: "upload_middleware",
        outcome: "succeeded",
        cleanupMode: "upload_field_mapping",
        routeFamily,
        uploadField: req.file.fieldname,
      });
    } else {
      logUploadMiddlewareTelemetry(logger, "debug", {
        correlationId,
        trainerId,
        stage: "upload_middleware_file_missing",
        status: "upload_middleware",
        outcome: "empty",
        cleanupMode: "upload_field_mapping",
        routeFamily,
      });
    }

    next();
  });
};

const uploadTrainerDocumentMiddleware = createUploadTrainerDocumentMiddleware();

module.exports = {
  createUploadTrainerDocumentMiddleware,
  uploadTrainerDocumentMiddleware,
};
