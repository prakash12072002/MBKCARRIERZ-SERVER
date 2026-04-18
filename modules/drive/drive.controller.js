const { createCorrelationId } = require("../../shared/utils/structuredLogger");
const { createFullStructure, isTrainingDriveEnabled } = require("./driveGateway");
const { executeSyncDb, resolveDriveSyncErrorPayload } = require("./driveSync.service");

const createFullStructureHandler = () => async (req, res) => {
  try {
    const { company, course, college, department, batch, rootFolderId, totalDays } =
      req.body || {};

    if (!company || !course || !(batch || college || department)) {
      return res.status(400).json({
        success: false,
        message:
          "company and course are required. Provide batch or provide college/department so batch can be generated.",
      });
    }

    if (!isTrainingDriveEnabled() && !String(rootFolderId || "").trim()) {
      return res.status(400).json({
        success: false,
        message:
          "Google Drive training root folder is not configured. Set GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_ID (or GOOGLE_DRIVE_TRAINING_PARENT_FOLDER_ID) or pass rootFolderId in request.",
      });
    }

    const structure = await createFullStructure({
      company,
      course,
      college,
      department: department || null,
      batch: batch || null,
      rootFolderId,
      totalDays,
    });

    return res.status(201).json({
      success: true,
      message:
        "Drive hierarchy created successfully (Trainer-Uploads > Company > Course > [College] > Department/Batch > Day_1..Day_12 with Attendance and GeoTag subfolders).",
      data: structure,
    });
  } catch (error) {
    const driveError = resolveDriveSyncErrorPayload(
      error,
      "Failed to create full Drive hierarchy",
    );
    return res.status(driveError.statusCode).json({
      success: false,
      message: driveError.message,
      error: driveError.error,
      errorCode: driveError.errorCode,
    });
  }
};

const createSyncDbHandler = (overrides = {}) => async (req, res) => {
  try {
    const requestCorrelationId = String(
      req.correlationId || req.headers?.["x-correlation-id"] || "",
    ).trim();
    const correlationId =
      requestCorrelationId || createCorrelationId("drive_sync");

    const result = await executeSyncDb({
      body: req.body || {},
      query: req.query || {},
      actor: req.user || {},
      correlationId,
      overrides,
    });

    if (result.dryRun) {
      return res.json({
        success: true,
        message:
          "Drive sync dry-run analysis completed. No database mutations were performed.",
        data: {
          dryRun: true,
          scope: result.dryRunScope,
          normalizeDuplicates: result.normalizeDuplicates,
          canonicalMappingsOnly: result.canonicalMappingsOnly,
          reconciliation: result.reconciliation,
          canonicalMapping: result.canonicalMapping,
        },
      });
    }

    return res.json({
      success: true,
      message:
        "Drive folder IDs synced into Company, Course, College, Department, and Day records.",
      data: {
        ...result.counts,
        normalizeDuplicates: result.normalizeDuplicates,
        canonicalMappingsOnly: result.canonicalMappingsOnly,
        reconciliation: result.reconciliation,
        canonicalMapping: result.canonicalMapping,
      },
    });
  } catch (error) {
    const explicitStatusCode = Number(error?.statusCode);
    if (Number.isFinite(explicitStatusCode) && explicitStatusCode >= 400 && explicitStatusCode < 500) {
      return res.status(explicitStatusCode).json({
        success: false,
        message: String(error?.message || "Drive sync request failed"),
      });
    }

    const driveError = resolveDriveSyncErrorPayload(
      error,
      "Failed to sync Drive folder IDs into database",
    );
    return res.status(driveError.statusCode).json({
      success: false,
      message: driveError.message,
      error: driveError.error,
      errorCode: driveError.errorCode,
    });
  }
};

module.exports = {
  createFullStructureHandler,
  createSyncDbHandler,
};

