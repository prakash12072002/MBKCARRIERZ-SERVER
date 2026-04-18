import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.DISABLE_REDIS = process.env.DISABLE_REDIS || "1";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  normalizeAttendanceVerificationStatus,
  normalizeAttendanceFinalStatus,
  normalizeCheckOutVerificationStatus,
} = require("../../utils/statusNormalizer.js");
const { verifyGeoTag } = require("../../utils/verify.js");
const {
  assignScheduleFeed,
  bulkCreateSchedulesFeed,
  bulkUploadSchedulesFeed,
  buildDepartmentDaysPayload,
  buildTrainerSchedulesPayload,
  createScheduleFeed,
  deleteScheduleFeed,
  getScheduleDetailsFeed,
  listLiveDashboardFeed,
  listScheduleAssociationsFeed,
  listSchedulesFeed,
  listTrainerSchedulesFeed,
  updateScheduleFeed,
} = require("../../modules/schedules/schedules.service.js");
const {
  getAttendanceLegacyDetails,
  listAttendanceByCollege,
  listAttendanceDocuments,
  listAttendanceByTrainer,
  listAttendanceBySchedule,
} = require("../../modules/attendance/attendance.service.js");
const {
  approachTrainerDocumentsFeed,
  listMyDocumentsFeed,
  listTrainerDocumentsFeed,
  moveTrainerToReviewFeed,
  queueTrainerDocumentCleanup,
  submitVerificationFeed,
  uploadTrainerDocumentFeed,
  updateTrainerStatusFeed,
  verifyDocumentFeed,
} = require("../../modules/documents/documents.service.js");
const {
  sendNotification,
  sendSMS,
  sendWhatsApp,
} = require("../../services/notificationService.js");
const {
  autoCreateTrainerAdminChannels,
  createBroadcastChannel,
  deleteChannelForEveryone,
  __logStreamChatTelemetry,
} = require("../../services/streamChatService.js");
const {
  createChatFeed,
  createChatBroadcastFeed,
  createDirectChatFeed,
  createChatGroupFeed,
  addChatGroupMembersFeed,
  clearChatChannelMessagesFeed,
  deleteChatChannelFeed,
  leaveChatChannelFeed,
  removeChatGroupMemberFeed,
  removeUserFromChatChannelFeed,
  sendChatMessageFeed,
  deleteChatMessageFeed,
  deleteChatMessageForEveryoneFeed,
  deleteChatMessageForMeFeed,
  getChatBootstrapFeed,
  getChatFullBootstrapFeed,
  getChatInfoFeed,
  getChatQuickBootstrapFeed,
  listChatListFeed,
  listChatChannelAuditLogFeed,
  listChatMessageHistoryFeed,
  listChatMessageSearchFeed,
  listChatSearchFeed,
  listChatValidationLogsFeed,
} = require("../../modules/chat/chat.service.js");
const {
  createUploadTrainerDocumentMiddleware,
} = require("../../modules/documents/documents.upload.js");
const {
  createResolveScheduleFolderFields,
  syncDriveHierarchyMetadata,
} = require("../../modules/schedules/schedules.drive.js");
const {
  parseAssignScheduleBody,
  parseAssignScheduleParams,
  parseBulkCreateScheduleBody,
  parseBulkUploadScheduleContext,
  parseCreateScheduleBody,
  parseDeleteScheduleParams,
  parseDeleteSchedulePayload,
  parseAssociationsQuery,
  parseDepartmentDaysQuery,
  parseScheduleDetailParams,
  parseUpdateScheduleBody,
  parseUpdateScheduleParams,
} = require("../../modules/schedules/schedules.schema.js");
const {
  parseAttendanceListQuery,
} = require("../../modules/attendance/attendance.schema.js");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger.js");
const {
  buildControllerErrorTelemetry,
  resolveRequestCorrelationId,
} = require("../../shared/utils/controllerTelemetry.js");
const {
  isInternalMetricsSnapshotEnabled,
} = require("../../routes/internalMetricsRoutes.js");
const {
  getFileWorkflowQueueMetricsSnapshot,
  recordFileWorkflowQueueMetric,
  resetFileWorkflowQueueMetrics,
  stopFileWorkflowQueueMetricsPersistence,
} = require("../../jobs/queues/fileWorkflowQueueMetrics.js");
const {
  getAsyncQueueMetricsSnapshot,
} = require("../../jobs/queues/asyncQueueMetricsSnapshot.js");
const {
  createQueueMetricsRetentionCleaner,
  createQueueMetricsPersistenceRuntime,
  createQueueMetricsSnapshotWriter,
  isQueueMetricsPersistenceEnabled,
  resolveQueueMetricsRetentionDays,
} = require("../../jobs/queues/fileWorkflowQueueMetricsPersistence.js");
const {
  mergeDriveAssetEntries,
  normalizeDocumentType,
  createDriveSyncReconciliationSummary,
  createDriveSyncDryRunSummary,
  inferDocumentTypeFromMixedFile,
  buildScanFolderCandidates,
  buildDepartmentDayFolderNormalizationPreview,
  applyDepartmentDayFolderDuplicateCleanup,
  appendNormalizationPreview,
} = require("../../modules/drive/driveSyncReconciliation.js");
const attendanceRoutes = require("../../routes/attendanceRoutes.js");
const {
  validateAssignedScheduleUpload,
  validateCheckOutSessionState,
  resolveCanonicalUploadFolders,
} = attendanceRoutes;

const buildTimestamp = (isoDateTime) =>
  Math.floor(new Date(isoDateTime).getTime() / 1000);

const tests = [
  {
    name: "normalizeAttendanceVerificationStatus maps aliases",
    run: () => {
      assert.equal(normalizeAttendanceVerificationStatus("APPROVE"), "approved");
      assert.equal(
        normalizeAttendanceVerificationStatus("in progress"),
        "pending",
      );
      assert.equal(normalizeAttendanceVerificationStatus("REJECT"), "rejected");
    },
  },
  {
    name: "normalizeAttendanceFinalStatus keeps canonical states",
    run: () => {
      assert.equal(normalizeAttendanceFinalStatus("verified"), "COMPLETED");
      assert.equal(normalizeAttendanceFinalStatus("under_review"), "PENDING");
      assert.equal(normalizeAttendanceFinalStatus("unknown", "PENDING"), "PENDING");
    },
  },
  {
    name: "normalizeCheckOutVerificationStatus maps geotag statuses",
    run: () => {
      assert.equal(
        normalizeCheckOutVerificationStatus("auto verified"),
        "AUTO_VERIFIED",
      );
      assert.equal(
        normalizeCheckOutVerificationStatus("manual-review"),
        "MANUAL_REVIEW_REQUIRED",
      );
      assert.equal(normalizeCheckOutVerificationStatus("pending"), "PENDING_CHECKOUT");
      assert.equal(normalizeCheckOutVerificationStatus("reject"), "REJECTED");
    },
  },
  {
    name: "drive sync reconciliation summary starts with stable zero counters",
    run: () => {
      const summary = createDriveSyncReconciliationSummary();
      assert.equal(summary.totalScanned, 0);
      assert.equal(summary.attendanceBackfilled, 0);
      assert.equal(summary.geoTagBackfilled, 0);
      assert.equal(summary.refreshedLinks, 0);
      assert.equal(summary.duplicateDayFoldersCleared, 0);
      assert.equal(summary.canonicalMappingsUpdated, 0);
      assert.equal(summary.skippedAmbiguous, 0);
      assert.equal(summary.unchanged, 0);
      assert.equal(summary.schedulesReconciled, 0);
      assert.deepEqual(summary.errors, []);
    },
  },
  {
    name: "drive sync dry-run summary starts with stable preview counters",
    run: () => {
      const summary = createDriveSyncDryRunSummary();
      assert.equal(summary.totalScanned, 0);
      assert.equal(summary.candidateMatches, 0);
      assert.equal(summary.attendanceWouldBackfill, 0);
      assert.equal(summary.geoWouldBackfill, 0);
      assert.equal(summary.refreshedLinksWouldChange, 0);
      assert.equal(summary.duplicateDayFoldersWouldClear, 0);
      assert.equal(summary.canonicalMappingsWouldChange, 0);
      assert.equal(summary.skippedAmbiguous, 0);
      assert.equal(summary.unchanged, 0);
      assert.equal(summary.schedulesReconciled, 0);
      assert.equal(summary.normalization.departmentsAnalyzed, 0);
      assert.equal(summary.normalization.dayFoldersDetected, 0);
      assert.equal(summary.normalization.duplicateDayFolders, 0);
      assert.deepEqual(summary.warnings, []);
      assert.deepEqual(summary.errors, []);
    },
  },
  {
    name: "drive sync mergeDriveAssetEntries deduplicates by drive file id",
    run: () => {
      const merged = mergeDriveAssetEntries(
        [
          {
            fileId: "file-1",
            fileName: "existing.pdf",
            fileUrl: "https://drive.google.com/uc?export=view&id=file-1",
            fileType: "attendance",
          },
        ],
        [
          {
            fileId: "file-1",
            fileName: "existing.pdf",
            webViewLink: "https://drive.google.com/file/d/file-1/view",
            fileType: "attendance",
          },
          {
            fileId: "file-2",
            fileName: "new.jpg",
            fileUrl: "https://drive.google.com/uc?export=view&id=file-2",
            fileType: "geotag",
          },
        ],
      );

      assert.equal(merged.length, 2);
      assert.ok(
        merged.some(
          (entry) =>
            entry.fileId === "file-1" &&
            entry.webViewLink === "https://drive.google.com/file/d/file-1/view",
        ),
      );
      assert.ok(
        merged.some((entry) => entry.fileId === "file-2" && entry.fileType === "geotag"),
      );
    },
  },
  {
    name: "drive sync normalizeDocumentType keeps legacy-safe file type aliases",
    run: () => {
      assert.equal(normalizeDocumentType("attendance"), "attendance");
      assert.equal(normalizeDocumentType("Geo"), "geotag");
      assert.equal(normalizeDocumentType("GeoTagImage"), "geotag");
      assert.equal(normalizeDocumentType("unknown"), "other");
    },
  },
  {
    name: "drive sync inferDocumentTypeFromMixedFile maps extensions and mime types safely",
    run: () => {
      assert.equal(
        inferDocumentTypeFromMixedFile({ name: "attendance-sheet.xlsx" }),
        "attendance",
      );
      assert.equal(
        inferDocumentTypeFromMixedFile({
          name: "checkout-photo.jpg",
          mimeType: "image/jpeg",
        }),
        "geotag",
      );
      assert.equal(
        inferDocumentTypeFromMixedFile({ name: "unknown.bin", mimeType: "application/octet-stream" }),
        "other",
      );
    },
  },
  {
    name: "drive sync buildScanFolderCandidates deduplicates folder ids and prefers explicit source types",
    run: () => {
      const candidates = buildScanFolderCandidates({
        schedule: {
          attendanceFolderId: "FOLDER-ATT",
          geoTagFolderId: "FOLDER-GEO",
          dayFolderId: "FOLDER-DAY",
          driveFolderId: "FOLDER-DAY",
        },
        attendance: {
          driveFolderId: "FOLDER-DAY",
          driveAssets: {
            folderIds: {
              attendance: "FOLDER-ATT",
              geoTag: "FOLDER-GEO",
              day: "FOLDER-DAY",
            },
          },
        },
      });

      assert.equal(candidates.length, 3);
      assert.ok(
        candidates.some(
          (entry) => entry.folderId === "FOLDER-ATT" && entry.sourceType === "attendance",
        ),
      );
      assert.ok(
        candidates.some(
          (entry) => entry.folderId === "FOLDER-GEO" && entry.sourceType === "geotag",
        ),
      );
      assert.ok(
        candidates.some(
          (entry) => entry.folderId === "FOLDER-DAY" && entry.sourceType === "mixed",
        ),
      );
    },
  },
  {
    name: "drive sync normalization preview detects duplicate day folders and chooses canonical deterministically",
    run: async () => {
      const department = {
        _id: "DEPT-1",
        name: "CSE",
        driveFolderId: "FOLDER-DEPT-1",
        dayFolders: [{ day: 5, folderId: "DAY5-B" }],
      };
      const schedules = [{ dayNumber: 5, dayFolderId: "DAY5-B" }];
      const listDriveFolderChildrenLoader = async ({ folderId }) => {
        if (folderId === "FOLDER-DEPT-1") {
          return [
            {
              id: "DAY5-A",
              name: "Day_5",
              mimeType: "application/vnd.google-apps.folder",
              createdTime: "2026-03-01T10:00:00.000Z",
            },
            {
              id: "DAY5-B",
              name: "Day_5",
              mimeType: "application/vnd.google-apps.folder",
              createdTime: "2026-03-02T10:00:00.000Z",
            },
          ];
        }

        if (folderId === "DAY5-B") {
          return [
            {
              id: "DAY5-B-ATT",
              name: "Attendance",
              mimeType: "application/vnd.google-apps.folder",
            },
            {
              id: "DAY5-B-GEO",
              name: "GeoTag",
              mimeType: "application/vnd.google-apps.folder",
            },
          ];
        }

        return [];
      };

      const { preview, canonicalByDay } = await buildDepartmentDayFolderNormalizationPreview({
        department,
        schedules,
        listDriveFolderChildrenLoader,
      });

      assert.equal(preview.dayFoldersDetected, 2);
      assert.equal(preview.duplicateDayFolders, 1);
      assert.equal(canonicalByDay[5].dayFolderId, "DAY5-B");
      assert.equal(canonicalByDay[5].attendanceFolderId, "DAY5-B-ATT");
      assert.equal(canonicalByDay[5].geoTagFolderId, "DAY5-B-GEO");
    },
  },
  {
    name: "drive sync normalization preview prefers mapped canonical subfolder ids over same-name duplicates",
    run: async () => {
      const department = {
        _id: "DEPT-1",
        name: "CSE",
        driveFolderId: "FOLDER-DEPT-1",
        dayFolders: [
          {
            day: 6,
            folderId: "DAY6-A",
            attendanceFolderId: "DAY6-ATT-B",
            geoTagFolderId: "DAY6-GEO-B",
          },
        ],
      };
      const schedules = [{ dayNumber: 6, dayFolderId: "DAY6-A" }];
      const listDriveFolderChildrenLoader = async ({ folderId }) => {
        if (folderId === "FOLDER-DEPT-1") {
          return [
            {
              id: "DAY6-A",
              name: "Day_6",
              mimeType: "application/vnd.google-apps.folder",
            },
          ];
        }

        if (folderId === "DAY6-A") {
          return [
            {
              id: "DAY6-ATT-A",
              name: "Attendance",
              mimeType: "application/vnd.google-apps.folder",
            },
            {
              id: "DAY6-ATT-B",
              name: "Attendance",
              mimeType: "application/vnd.google-apps.folder",
            },
            {
              id: "DAY6-GEO-A",
              name: "GeoTag",
              mimeType: "application/vnd.google-apps.folder",
            },
            {
              id: "DAY6-GEO-B",
              name: "GeoTag",
              mimeType: "application/vnd.google-apps.folder",
            },
          ];
        }

        return [];
      };

      const { canonicalByDay } = await buildDepartmentDayFolderNormalizationPreview({
        department,
        schedules,
        listDriveFolderChildrenLoader,
      });

      assert.equal(canonicalByDay[6].dayFolderId, "DAY6-A");
      assert.equal(canonicalByDay[6].attendanceFolderId, "DAY6-ATT-B");
      assert.equal(canonicalByDay[6].geoTagFolderId, "DAY6-GEO-B");
    },
  },
  {
    name: "drive sync normalization preview treats Checkout folder as legacy and keeps GeoTag canonical rule",
    run: async () => {
      const department = {
        _id: "DEPT-2",
        name: "IOT",
        driveFolderId: "FOLDER-DEPT-2",
      };
      const listDriveFolderChildrenLoader = async ({ folderId }) => {
        if (folderId === "FOLDER-DEPT-2") {
          return [
            {
              id: "DAY1-X",
              name: "Day_1",
              mimeType: "application/vnd.google-apps.folder",
            },
          ];
        }
        if (folderId === "DAY1-X") {
          return [
            {
              id: "DAY1-ATT",
              name: "Attendance",
              mimeType: "application/vnd.google-apps.folder",
            },
            {
              id: "DAY1-CHK",
              name: "Checkout",
              mimeType: "application/vnd.google-apps.folder",
            },
          ];
        }
        return [];
      };

      const { preview, canonicalByDay } = await buildDepartmentDayFolderNormalizationPreview({
        department,
        schedules: [{ dayNumber: 1, dayFolderId: "DAY1-X" }],
        listDriveFolderChildrenLoader,
      });

      assert.equal(canonicalByDay[1].attendanceFolderId, "DAY1-ATT");
      assert.equal(canonicalByDay[1].geoTagFolderId, null);
      assert.equal(preview.ambiguousDayFolders, 1);
      assert.ok(
        preview.warnings.some((item) => String(item).toLowerCase().includes("checkout")),
      );
    },
  },
  {
    name: "drive sync duplicate cleanup helper is non-destructive and reports warnings",
    run: async () => {
      const summary = createDriveSyncReconciliationSummary();
      const cleanupCalls = [];
      const result = await applyDepartmentDayFolderDuplicateCleanup({
        department: { _id: "DEPT-1", driveFolderId: "DRV-DEPT-1" },
        schedules: [],
        summary,
        dryRun: false,
        preview: {
          duplicateDayFolders: 2,
          days: [
            {
              dayNumber: 7,
              canonical: { dayFolderId: "DAY7-B", dayFolderName: "Day_7" },
              duplicates: [{ folderId: "DAY7-A", folderName: "Day_7" }],
            },
            {
              dayNumber: 8,
              canonical: { dayFolderId: "DAY8-C", dayFolderName: "Day_8" },
              duplicates: [{ folderId: "DAY8-A", folderName: "Day_8" }],
            },
          ],
        },
        canonicalByDay: {},
        mergeDuplicateDriveFoldersLoader: async (payload) => {
          cleanupCalls.push(payload);
          return {
            removedFolderIds: payload.folderName === "Day_7" ? ["DAY7-A"] : ["DAY8-A"],
            cleanupWarnings: [],
          };
        },
      });

      assert.equal(result.duplicateDayFoldersDetected, 2);
      assert.equal(result.duplicateDayFoldersCleared, 0);
      assert.equal(summary.duplicateDayFoldersCleared, 0);
      assert.equal(cleanupCalls.length, 0);
      assert.ok(
        result.warnings.some((item) =>
          String(item).toLowerCase().includes("non-destructive"),
        ),
      );
    },
  },
  {
    name: "drive sync duplicate cleanup helper dry-run reports would-clear without mutating",
    run: async () => {
      const summary = createDriveSyncDryRunSummary();
      const cleanupCalls = [];
      const result = await applyDepartmentDayFolderDuplicateCleanup({
        department: { _id: "DEPT-1", driveFolderId: "DRV-DEPT-1" },
        schedules: [],
        summary,
        dryRun: true,
        preview: {
          duplicateDayFolders: 3,
          days: [],
        },
        canonicalByDay: {},
        mergeDuplicateDriveFoldersLoader: async (payload) => {
          cleanupCalls.push(payload);
          return { removedFolderIds: [] };
        },
      });

      assert.equal(result.duplicateDayFoldersDetected, 3);
      assert.equal(result.duplicateDayFoldersCleared, 0);
      assert.equal(summary.duplicateDayFoldersWouldClear, 3);
      assert.equal(cleanupCalls.length, 0);
    },
  },
  {
    name: "drive sync normalization summary append keeps aggregate counters",
    run: () => {
      const summary = createDriveSyncDryRunSummary();
      appendNormalizationPreview(summary, {
        departmentId: "DEPT-1",
        dayFoldersDetected: 4,
        duplicateDayFolders: 1,
        canonicalDayFolders: 3,
        ambiguousDayFolders: 1,
        filesMatchedSafely: 8,
        proposedActions: { keep: 3, link: 2, move: 1, skip: 1 },
      });

      assert.equal(summary.normalization.departmentsAnalyzed, 1);
      assert.equal(summary.normalization.dayFoldersDetected, 4);
      assert.equal(summary.normalization.duplicateDayFolders, 1);
      assert.equal(summary.normalization.filesMatchedSafely, 8);
      assert.equal(summary.normalization.proposedActions.link, 2);
      assert.equal(summary.normalization.departments.length, 1);
    },
  },
  {
    name: "drive sync buildScanFolderCandidates keeps canonical folder hints highest priority",
    run: () => {
      const candidates = buildScanFolderCandidates({
        schedule: {
          canonicalAttendanceFolderId: "CAN-ATT",
          canonicalGeoTagFolderId: "CAN-GEO",
          canonicalDayFolderId: "CAN-DAY",
          attendanceFolderId: "CAN-ATT",
          geoTagFolderId: "CAN-GEO",
          dayFolderId: "CAN-DAY",
        },
        attendance: {},
      });

      assert.ok(
        candidates.some(
          (entry) => entry.folderId === "CAN-ATT" && entry.sourceType === "canonical_attendance",
        ),
      );
      assert.ok(
        candidates.some(
          (entry) => entry.folderId === "CAN-GEO" && entry.sourceType === "canonical_geotag",
        ),
      );
      assert.ok(
        candidates.some(
          (entry) => entry.folderId === "CAN-DAY" && entry.sourceType === "canonical_day",
        ),
      );
    },
  },
  {
    name: "attendance list parser maps pending/manual/completed checkout filters with legacy-safe aliases",
    run: () => {
      const pending = parseAttendanceListQuery({
        view: "geo-verification",
        checkOutVerificationStatus: "pending_or_review",
      });
      const manualReview = parseAttendanceListQuery({
        view: "geo-verification",
        checkOutVerificationStatus: "manual_review",
      });
      const completed = parseAttendanceListQuery({
        view: "geo-verification",
        checkOutVerificationStatus: "completed",
      });
      const manuallyVerified = parseAttendanceListQuery({
        view: "geo-verification",
        checkOutVerificationStatus: "manually_verified",
      });

      assert.equal(pending.checkOutVerificationStatus, "PENDING_OR_REVIEW");
      assert.equal(manualReview.checkOutVerificationStatus, "MANUAL_REVIEW_REQUIRED");
      assert.equal(completed.checkOutVerificationStatus, "COMPLETED_OR_VERIFIED");
      assert.equal(manuallyVerified.checkOutVerificationStatus, "COMPLETED_OR_VERIFIED");
    },
  },
  {
    name: "attendance upload guard rejects inactive, cancelled, and completed schedules",
    run: () => {
      const baseSchedule = {
        _id: "507f1f77bcf86cd799439010",
        trainerId: "507f1f77bcf86cd799439011",
        collegeId: "507f1f77bcf86cd799439012",
        dayNumber: 3,
      };

      const inactive = validateAssignedScheduleUpload({
        schedule: { ...baseSchedule, isActive: false },
        trainerId: "507f1f77bcf86cd799439011",
        collegeId: "507f1f77bcf86cd799439012",
        dayNumber: 3,
      });
      const cancelled = validateAssignedScheduleUpload({
        schedule: { ...baseSchedule, status: "cancelled" },
        trainerId: "507f1f77bcf86cd799439011",
        collegeId: "507f1f77bcf86cd799439012",
        dayNumber: 3,
      });
      const completed = validateAssignedScheduleUpload({
        schedule: { ...baseSchedule, status: "COMPLETED" },
        trainerId: "507f1f77bcf86cd799439011",
        collegeId: "507f1f77bcf86cd799439012",
        dayNumber: 3,
      });

      assert.equal(inactive?.status, 403);
      assert.match(inactive?.message || "", /inactive/i);
      assert.equal(cancelled?.status, 403);
      assert.match(cancelled?.message || "", /cancelled/i);
      assert.equal(completed?.status, 403);
      assert.match(completed?.message || "", /completed/i);
    },
  },
  {
    name: "checkout session guard rejects cancelled and already-completed sessions",
    run: () => {
      const cancelled = validateCheckOutSessionState({
        attendance: {
          status: "cancelled",
          checkOutVerificationStatus: "PENDING_CHECKOUT",
        },
        mode: "check-out",
      });
      const completed = validateCheckOutSessionState({
        attendance: {
          status: "Present",
          checkOutVerificationStatus: "AUTO_VERIFIED",
        },
        mode: "check-out",
      });

      assert.equal(cancelled?.status, 400);
      assert.match(cancelled?.message || "", /cancelled/i);
      assert.equal(completed?.status, 400);
      assert.match(completed?.message || "", /already completed/i);
    },
  },
  {
    name: "geo upload session guard keeps non-cancelled pending sessions actionable",
    run: () => {
      const result = validateCheckOutSessionState({
        attendance: {
          status: "Present",
          checkOutVerificationStatus: "MANUAL_REVIEW_REQUIRED",
        },
        mode: "geo-upload",
      });

      assert.equal(result, null);
    },
  },
  {
    name: "checkout session guard rejects records already marked final completed",
    run: () => {
      const completed = validateCheckOutSessionState({
        attendance: {
          status: "Present",
          checkOutVerificationStatus: "PENDING_CHECKOUT",
          finalStatus: "COMPLETED",
        },
        mode: "check-out",
      });

      assert.equal(completed?.status, 400);
      assert.match(completed?.message || "", /already completed/i);
    },
  },
  {
    name: "attendance checkout upload path prefers canonical geoTagFolderId over same-name fallback folder",
    run: async () => {
      const ensureCalls = [];
      const ensureDriveFolderLoader = async ({ folderName, parentFolderId }) => {
        ensureCalls.push({ folderName, parentFolderId });
        return {
          id: `${folderName.toUpperCase()}-FALLBACK-ID`,
          name: folderName,
          webViewLink: `https://drive/${folderName.toLowerCase()}-fallback`,
        };
      };

      const result = await resolveCanonicalUploadFolders({
        scheduleDoc: {
          dayFolderId: "DAY-CANON-1",
          geoTagFolderId: "GEO-CANON-1",
          geoTagFolderName: "GeoTag",
          geoTagFolderLink: "https://drive/geo-canon-1",
          attendanceFolderId: "ATT-CANON-1",
          attendanceFolderName: "Attendance",
          attendanceFolderLink: "https://drive/att-canon-1",
        },
        dayEntry: {
          // Simulates same-name duplicate/fallback candidates from legacy mapping.
          geoTagFolderId: "GEO-DUPLICATE-LEGACY",
          geoTagFolderName: "GeoTag",
          attendanceFolderId: "ATT-DUPLICATE-LEGACY",
          attendanceFolderName: "Attendance",
        },
        dayFolderId: "DAY-CANON-1",
        ensureDriveFolderLoader,
      });

      assert.equal(result.geoTagFolder.id, "GEO-CANON-1");
      assert.equal(ensureCalls.length, 0);
    },
  },
  {
    name: "attendance upload path prefers canonical attendanceFolderId over same-name fallback folder",
    run: async () => {
      const ensureCalls = [];
      const ensureDriveFolderLoader = async ({ folderName, parentFolderId }) => {
        ensureCalls.push({ folderName, parentFolderId });
        return {
          id: `${folderName.toUpperCase()}-FALLBACK-ID`,
          name: folderName,
          webViewLink: `https://drive/${folderName.toLowerCase()}-fallback`,
        };
      };

      const result = await resolveCanonicalUploadFolders({
        scheduleDoc: {
          dayFolderId: "DAY-CANON-2",
          attendanceFolderId: "ATT-CANON-2",
          attendanceFolderName: "Attendance",
          attendanceFolderLink: "https://drive/att-canon-2",
        },
        dayEntry: {
          attendanceFolderId: "ATT-DUPLICATE-LEGACY",
          attendanceFolderName: "Attendance",
          geoTagFolderId: "GEO-DUPLICATE-LEGACY",
          geoTagFolderName: "GeoTag",
        },
        dayFolderId: "DAY-CANON-2",
        ensureDriveFolderLoader,
      });

      assert.equal(result.attendanceFolder.id, "ATT-CANON-2");
      assert.equal(
        ensureCalls.some((call) => call.folderName === "Attendance"),
        false,
      );
    },
  },
  {
    name: "attendance and checkout upload fallback folders are used only when canonical ids are missing",
    run: async () => {
      const ensureCalls = [];
      const ensureDriveFolderLoader = async ({ folderName, parentFolderId }) => {
        ensureCalls.push({ folderName, parentFolderId });
        return {
          id: `${folderName.toUpperCase()}-FALLBACK-ID`,
          name: folderName,
          webViewLink: `https://drive/${folderName.toLowerCase()}-fallback`,
        };
      };

      const result = await resolveCanonicalUploadFolders({
        scheduleDoc: {
          dayFolderId: "DAY-CANON-3",
          dayFolderName: "Day_3",
        },
        dayEntry: {
          day: 3,
          folderId: "DAY-DUPLICATE-LEGACY",
          folderName: "Day_3",
        },
        dayFolderId: "DAY-CANON-3",
        ensureDriveFolderLoader,
      });

      assert.equal(result.attendanceFolder.id, "ATTENDANCE-FALLBACK-ID");
      assert.equal(result.geoTagFolder.id, "GEOTAG-FALLBACK-ID");
      assert.deepEqual(ensureCalls, [
        { folderName: "Attendance", parentFolderId: "DAY-CANON-3" },
        { folderName: "GeoTag", parentFolderId: "DAY-CANON-3" },
      ]);
    },
  },
  {
    name: "verifyGeoTag auto-verifies when location/date match",
    run: () => {
      const result = verifyGeoTag({
        geoData: {
          latitude: 12.9717,
          longitude: 77.5947,
          timestamp: buildTimestamp("2026-04-01T09:30:00+05:30"),
        },
        ocrData: {
          latitude: 12.9717,
          longitude: 77.5947,
          timestamp: buildTimestamp("2026-04-01T09:30:20+05:30"),
        },
        assignedDate: "2026-04-01",
        collegeLocation: { lat: 12.9716, lng: 77.5946 },
      });

      assert.equal(result.status, "COMPLETED");
      assert.equal(result.reason, "Location and date verified");
      assert.equal(typeof result.distance, "number");
    },
  },
  {
    name: "verifyGeoTag keeps verification when EXIF is valid even if OCR stamp parse mismatches",
    run: () => {
      const result = verifyGeoTag({
        geoData: {
          latitude: 12.9717,
          longitude: 77.5947,
          timestamp: buildTimestamp("2026-04-01T09:30:00+05:30"),
        },
        ocrData: {
          // Simulates OCR misread from stamped text.
          latitude: 12.9617,
          longitude: 77.5847,
          timestamp: buildTimestamp("2026-04-01T11:30:00+05:30"),
        },
        assignedDate: "2026-04-01",
        collegeLocation: { lat: 12.9716, lng: 77.5946 },
      });

      assert.equal(result.status, "COMPLETED");
      assert.equal(result.reasonCode, "VERIFIED");
      assert.equal(result.report?.comparisons?.exifOcrGeoMismatch, true);
      assert.equal(result.report?.comparisons?.exifOcrTimeMismatch, true);
    },
  },
  {
    name: "verifyGeoTag requests manual review when metadata is missing",
    run: () => {
      const result = verifyGeoTag({
        geoData: {},
        ocrData: {},
        assignedDate: "2026-04-01",
        collegeLocation: { lat: 12.9716, lng: 77.5946 },
      });

      assert.equal(result.status, "PENDING");
      assert.match(
        result.reason,
        /(No readable location|Missing EXIF GPS metadata)/i,
      );
      assert.equal(result.latitude, null);
      assert.equal(result.longitude, null);
    },
  },
  {
    name: "structured logger respects level gating",
    run: () => {
      const writes = [];
      const sink = {
        debug: (...args) => writes.push({ level: "debug", args }),
        info: (...args) => writes.push({ level: "info", args }),
        warn: (...args) => writes.push({ level: "warn", args }),
        error: (...args) => writes.push({ level: "error", args }),
        log: (...args) => writes.push({ level: "log", args }),
      };

      const logger = createStructuredLogger({
        service: "unit",
        component: "logger",
        level: "warn",
        sink,
      });

      logger.info({ stage: "should-not-log" });
      logger.warn({ stage: "should-log" });

      assert.equal(writes.length, 1);
      assert.equal(writes[0].level, "warn");

      const [prefix, payload] = writes[0].args;
      const parsed = JSON.parse(payload);
      assert.equal(prefix, "[OBS]");
      assert.equal(parsed.level, "warn");
      assert.equal(parsed.service, "unit");
      assert.equal(parsed.component, "logger");
      assert.equal(parsed.stage, "should-log");
    },
  },
  {
    name: "structured logger emits standardized payload fields",
    run: () => {
      const writes = [];
      const sink = {
        info: (...args) => writes.push(args),
      };

      const logger = createStructuredLogger({
        service: "documents",
        component: "upload-flow",
        level: "info",
        sink,
      });

      logger.info({
        correlationId: "doc_upload_123",
        stage: "upload_started",
        trainerId: "TRN-100",
        status: "accepted",
        outcome: "started",
      });

      assert.equal(writes.length, 1);
      const [prefix, payload] = writes[0];
      const parsed = JSON.parse(payload);

      assert.equal(prefix, "[OBS]");
      assert.equal(parsed.level, "info");
      assert.equal(parsed.service, "documents");
      assert.equal(parsed.component, "upload-flow");
      assert.equal(parsed.correlationId, "doc_upload_123");
      assert.equal(parsed.stage, "upload_started");
      assert.equal(parsed.trainerId, "TRN-100");
      assert.equal(parsed.status, "accepted");
      assert.equal(parsed.outcome, "started");
      assert.equal(typeof parsed.ts, "string");
    },
  },
  {
    name: "createCorrelationId keeps prefixed legacy-safe format",
    run: () => {
      const correlationId = createCorrelationId("doc_upload");
      assert.match(correlationId, /^doc_upload_\d+_[a-z0-9]{8}$/i);
    },
  },
  {
    name: "controller telemetry helper keeps correlation + payload shaping parity",
    run: () => {
      const req = {
        headers: {
          "x-correlation-id": "corr-from-header",
        },
      };
      const error = new Error("controller failed");

      const payload = buildControllerErrorTelemetry(req, {
        stage: "list_entities_failed",
        error,
        fields: {
          statusCode: 500,
          entityId: "ENTITY-1",
        },
      });

      assert.equal(payload.correlationId, "corr-from-header");
      assert.equal(payload.stage, "list_entities_failed");
      assert.equal(payload.status, "controller");
      assert.equal(payload.outcome, "failed");
      assert.equal(payload.cleanupMode, "none");
      assert.equal(payload.reason, "controller failed");
      assert.equal(payload.statusCode, 500);
      assert.equal(payload.entityId, "ENTITY-1");
    },
  },
  {
    name: "controller telemetry helper generates fallback correlation id when missing",
    run: () => {
      const correlationId = resolveRequestCorrelationId(
        { headers: {} },
        {
          prefix: "ctrl_test",
          createCorrelationIdLoader: (prefix) => `${prefix}_generated`,
        },
      );
      assert.equal(correlationId, "ctrl_test_generated");
    },
  },
  {
    name: "queue metrics persistence flag parser keeps disabled-by-default behavior",
    run: () => {
      assert.equal(isQueueMetricsPersistenceEnabled({}), false);
      assert.equal(
        isQueueMetricsPersistenceEnabled({
          ENABLE_QUEUE_METRICS_PERSISTENCE: "1",
        }),
        true,
      );
      assert.equal(
        isQueueMetricsPersistenceEnabled({
          ENABLE_QUEUE_METRICS_PERSISTENCE: "true",
        }),
        true,
      );
      assert.equal(
        isQueueMetricsPersistenceEnabled({
          ENABLE_QUEUE_METRICS_PERSISTENCE: "0",
        }),
        false,
      );
    },
  },
  {
    name: "queue metrics retention-days parser keeps unset-as-noop behavior",
    run: () => {
      assert.equal(resolveQueueMetricsRetentionDays({}), null);
      assert.equal(
        resolveQueueMetricsRetentionDays({
          QUEUE_METRICS_RETENTION_DAYS: "",
        }),
        null,
      );
      assert.equal(
        resolveQueueMetricsRetentionDays({
          QUEUE_METRICS_RETENTION_DAYS: "7",
        }),
        7,
      );
      assert.equal(
        resolveQueueMetricsRetentionDays({
          QUEUE_METRICS_RETENTION_DAYS: "0",
        }),
        null,
      );
      assert.equal(
        resolveQueueMetricsRetentionDays({
          QUEUE_METRICS_RETENTION_DAYS: "invalid",
        }),
        null,
      );
    },
  },
  {
    name: "queue metrics snapshot writer is no-op when persistence is disabled",
    run: () => {
      const writer = createQueueMetricsSnapshotWriter({
        enabled: false,
      });
      const result = writer.writeSnapshot({
        queue: "file-workflow",
        snapshot: {
          totals: { queued: 1 },
        },
      });

      assert.equal(result.written, false);
      assert.equal(result.reason, "disabled");
    },
  },
  {
    name: "queue metrics snapshot writer persists JSONL snapshot when enabled",
    run: () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "mbk-queue-metrics-"),
      );

      try {
        const writer = createQueueMetricsSnapshotWriter({
          enabled: true,
          outputDir: tempDir,
          nowLoader: () => new Date("2026-04-05T12:00:00.000Z"),
        });

        const writeResult = writer.writeSnapshot({
          queue: "file-workflow",
          source: "unit-test",
          snapshot: {
            totals: {
              queued: 2,
              started: 1,
              succeeded: 1,
              failed: 0,
              retried: 0,
              dropped: 0,
              enqueueFailed: 0,
              parseFailed: 0,
            },
          },
        });

        assert.equal(writeResult.written, true);
        const expectedFile = path.join(tempDir, "queue-metrics-2026-04-05.jsonl");
        assert.equal(writeResult.filePath, expectedFile);
        const lines = fs
          .readFileSync(expectedFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        assert.equal(lines.length, 1);

        const entry = JSON.parse(lines[0]);
        assert.equal(entry.queue, "file-workflow");
        assert.equal(entry.source, "unit-test");
        assert.equal(entry.ts, "2026-04-05T12:00:00.000Z");
        assert.equal(entry.snapshot.totals.queued, 2);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "queue metrics persistence runtime keeps disabled no-op behavior",
    run: () => {
      let writeCount = 0;
      const runtime = createQueueMetricsPersistenceRuntime({
        enabled: false,
        getSnapshotLoader: () => ({
          totals: { queued: 1 },
        }),
        writer: {
          writeSnapshot: () => {
            writeCount += 1;
            return { written: true };
          },
        },
      });

      assert.equal(runtime.start(), false);
      const persistResult = runtime.persistOnce();
      assert.equal(persistResult.written, false);
      assert.equal(persistResult.reason, "disabled");
      assert.equal(writeCount, 0);
      assert.equal(runtime.isRunning(), false);
    },
  },
  {
    name: "queue metrics retention cleanup keeps disabled path as no-op",
    run: () => {
      const cleaner = createQueueMetricsRetentionCleaner({
        enabled: false,
        retentionDays: 7,
      });
      const result = cleaner.cleanup({
        force: true,
        correlationId: "queue_retention_disabled_test",
      });
      assert.equal(result.cleaned, false);
      assert.equal(result.reason, "disabled");
    },
  },
  {
    name: "queue metrics retention cleanup deletes only files older than threshold",
    run: () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "mbk-queue-retention-"),
      );

      try {
        const fileNames = [
          "queue-metrics-2026-03-30.jsonl",
          "queue-metrics-2026-04-01.jsonl",
          "queue-metrics-2026-04-03.jsonl",
          "queue-metrics-2026-04-05.jsonl",
          "not-a-metrics-file.txt",
        ];
        for (const fileName of fileNames) {
          fs.writeFileSync(path.join(tempDir, fileName), "sample\n", "utf8");
        }

        const cleaner = createQueueMetricsRetentionCleaner({
          enabled: true,
          retentionDays: 3,
          outputDir: tempDir,
          nowLoader: () => new Date("2026-04-05T12:00:00.000Z"),
        });

        const cleanupResult = cleaner.cleanup({
          force: true,
          correlationId: "queue_retention_enabled_test",
        });

        assert.equal(cleanupResult.cleaned, true);
        assert.equal(cleanupResult.deletedCount, 2);
        assert.equal(cleanupResult.scannedCount, 4);
        assert.equal(cleanupResult.cutoff, "2026-04-03");

        assert.equal(
          fs.existsSync(path.join(tempDir, "queue-metrics-2026-03-30.jsonl")),
          false,
        );
        assert.equal(
          fs.existsSync(path.join(tempDir, "queue-metrics-2026-04-01.jsonl")),
          false,
        );
        assert.equal(
          fs.existsSync(path.join(tempDir, "queue-metrics-2026-04-03.jsonl")),
          true,
        );
        assert.equal(
          fs.existsSync(path.join(tempDir, "queue-metrics-2026-04-05.jsonl")),
          true,
        );
        assert.equal(
          fs.existsSync(path.join(tempDir, "not-a-metrics-file.txt")),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "queue metrics persistence runtime keeps current metrics file after retention cleanup",
    run: () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "mbk-queue-runtime-retention-"),
      );

      try {
        const runtime = createQueueMetricsPersistenceRuntime({
          enabled: true,
          intervalMs: 60000,
          getSnapshotLoader: () => ({
            totals: { queued: 4 },
          }),
          writer: createQueueMetricsSnapshotWriter({
            enabled: true,
            outputDir: tempDir,
            nowLoader: () => new Date("2026-04-05T12:00:00.000Z"),
          }),
          retentionCleaner: createQueueMetricsRetentionCleaner({
            enabled: true,
            retentionDays: 1,
            outputDir: tempDir,
            nowLoader: () => new Date("2026-04-05T12:00:00.000Z"),
          }),
          setIntervalLoader: () => ({ unref: () => {} }),
          clearIntervalLoader: () => {},
        });

        const staleFile = path.join(tempDir, "queue-metrics-2026-04-04.jsonl");
        fs.writeFileSync(staleFile, "stale\n", "utf8");

        const writeResult = runtime.persistOnce({
          queue: "file-workflow",
          source: "unit-test-runtime",
          correlationId: "queue_runtime_retention_test",
        });

        assert.equal(writeResult.written, true);
        const currentFile = path.join(tempDir, "queue-metrics-2026-04-05.jsonl");
        assert.equal(fs.existsSync(currentFile), true);
        assert.equal(fs.existsSync(staleFile), false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "documents upload middleware keeps file field mapping and emits structured telemetry",
    run: async () => {
      const telemetryWrites = [];
      const middleware = createUploadTrainerDocumentMiddleware({
        uploadInstance: {
          fields: () => (_req, _res, callback) => callback(null),
        },
        logger: {
          debug: (payload) => telemetryWrites.push({ level: "debug", payload }),
          info: (payload) => telemetryWrites.push({ level: "info", payload }),
          warn: (payload) => telemetryWrites.push({ level: "warn", payload }),
          error: (payload) => telemetryWrites.push({ level: "error", payload }),
        },
        createCorrelationIdLoader: () => "doc_upload_mw_test_1",
      });

      const req = {
        headers: {},
        originalUrl: "/api/trainer-documents/upload",
        params: { trainerId: "TRN-UP-MW-1" },
        files: {
          document: [{ fieldname: "document", originalname: "sample.pdf" }],
        },
      };

      const nextResult = await new Promise((resolve) => {
        middleware(req, {}, (error) => resolve(error || null));
      });

      assert.equal(nextResult, null);
      assert.equal(req.file?.fieldname, "document");
      assert.equal(req.correlationId, "doc_upload_mw_test_1");
      assert.equal(telemetryWrites.length, 1);
      assert.equal(telemetryWrites[0].level, "debug");
      assert.equal(
        telemetryWrites[0].payload.stage,
        "upload_middleware_file_resolved",
      );
      assert.equal(
        telemetryWrites[0].payload.status,
        "upload_middleware",
      );
      assert.equal(telemetryWrites[0].payload.outcome, "succeeded");
      assert.equal(telemetryWrites[0].payload.cleanupMode, "upload_field_mapping");
      assert.equal(telemetryWrites[0].payload.routeFamily, "legacy-documents");
      assert.equal(telemetryWrites[0].payload.uploadField, "document");
    },
  },
  {
    name: "documents upload middleware keeps error pass-through and telemetry parity",
    run: async () => {
      const telemetryWrites = [];
      const middleware = createUploadTrainerDocumentMiddleware({
        uploadInstance: {
          fields: () => (_req, _res, callback) =>
            callback(new Error("multer failed")),
        },
        logger: {
          debug: (payload) => telemetryWrites.push({ level: "debug", payload }),
          info: (payload) => telemetryWrites.push({ level: "info", payload }),
          warn: (payload) => telemetryWrites.push({ level: "warn", payload }),
          error: (payload) => telemetryWrites.push({ level: "error", payload }),
        },
        createCorrelationIdLoader: () => "doc_upload_mw_test_2",
      });

      const req = {
        headers: {},
        originalUrl: "/api/v1/documents/upload",
        body: { targetTrainerId: "TRN-UP-MW-2" },
      };

      const nextResult = await new Promise((resolve) => {
        middleware(req, {}, (error) => resolve(error || null));
      });

      assert.equal(nextResult?.message, "multer failed");
      assert.equal(req.correlationId, "doc_upload_mw_test_2");
      assert.equal(telemetryWrites.length, 1);
      assert.equal(telemetryWrites[0].level, "warn");
      assert.equal(telemetryWrites[0].payload.stage, "upload_middleware_error");
      assert.equal(telemetryWrites[0].payload.status, "upload_middleware");
      assert.equal(telemetryWrites[0].payload.outcome, "failed");
      assert.equal(telemetryWrites[0].payload.cleanupMode, "upload_validation");
      assert.equal(telemetryWrites[0].payload.routeFamily, "v1-documents");
      assert.equal(telemetryWrites[0].payload.trainerId, "TRN-UP-MW-2");
      assert.equal(telemetryWrites[0].payload.reason, "multer failed");
    },
  },
  {
    name: "internal metrics snapshot flag parser keeps debug-only gating defaults",
    run: () => {
      assert.equal(isInternalMetricsSnapshotEnabled({}), false);
      assert.equal(
        isInternalMetricsSnapshotEnabled({
          ENABLE_INTERNAL_METRICS_SNAPSHOT: "1",
        }),
        true,
      );
      assert.equal(
        isInternalMetricsSnapshotEnabled({
          ENABLE_INTERNAL_METRICS_SNAPSHOT: "true",
        }),
        true,
      );
      assert.equal(
        isInternalMetricsSnapshotEnabled({
          ENABLE_INTERNAL_METRICS_SNAPSHOT: "0",
        }),
        false,
      );
    },
  },
  {
    name: "notification service sendSMS keeps unconfigured path and structured telemetry parity",
    run: async () => {
      const writes = [];
      const result = await sendSMS("+919999999999", "Test message", {
        twilioClient: null,
        correlationId: "notif_sms_test_corr_1",
        logger: {
          warn: (payload) => writes.push(payload),
        },
      });

      assert.deepEqual(result, {
        success: false,
        skipped: true,
        error: "Twilio not configured",
      });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].correlationId, "notif_sms_test_corr_1");
      assert.equal(writes[0].stage, "sms_send_skipped_unconfigured");
      assert.equal(writes[0].status, "notification_dispatch");
      assert.equal(writes[0].outcome, "skipped");
      assert.equal(writes[0].notifyChannel, "sms");
    },
  },
  {
    name: "notification service sendNotification propagates correlation id to async channel loaders",
    run: async () => {
      let capturedSmsCorrelation = null;
      let capturedWhatsappCorrelation = null;

      const response = await sendNotification(
        null,
        {
          userId: "USER-NOTIFY-1",
          role: "Trainer",
          title: "Schedule Alert",
          message: "Please confirm",
          channels: ["sms", "whatsapp"],
          phone: "+919999999998",
          correlationId: "notif_dispatch_corr_1",
        },
        {
          sendSMSLoader: async (_phone, _message, options) => {
            capturedSmsCorrelation = options?.correlationId || null;
            return { success: true, sid: "SMS-SID-1" };
          },
          sendWhatsAppLoader: async (_phone, _vars, options) => {
            capturedWhatsappCorrelation = options?.correlationId || null;
            return { success: true, sid: "WA-SID-1" };
          },
        },
      );

      assert.equal(response.success, true);
      assert.equal(capturedSmsCorrelation, "notif_dispatch_corr_1");
      assert.equal(capturedWhatsappCorrelation, "notif_dispatch_corr_1");
    },
  },
  {
    name: "notification service sendNotification keeps async side-effect safety on channel loader failure",
    run: async () => {
      const response = await sendNotification(
        null,
        {
          userId: "USER-NOTIFY-2",
          role: "Trainer",
          title: "Schedule Alert",
          message: "Please confirm",
          channels: ["sms"],
          phone: "+919999999997",
          correlationId: "notif_dispatch_corr_2",
        },
        {
          sendSMSLoader: async () => {
            throw new Error("sms down");
          },
          logger: {
            error: () => {},
          },
        },
      );

      assert.equal(response.success, false);
      assert.equal(response.error, "sms down");
    },
  },
  {
    name: "stream chat telemetry helper keeps structured field consistency",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "info",
        {
          correlationId: "chat_bootstrap_test_corr_1",
          stage: "workspace_bootstrap_succeeded",
          status: "chat_bootstrap",
          outcome: "succeeded",
          userId: "USER-CHAT-1",
          role: "Trainer",
          cacheKey: "contacts_USER-CHAT-1",
        },
        {
          logger: {
            info: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(writes[0].correlationId, "chat_bootstrap_test_corr_1");
      assert.equal(writes[0].stage, "workspace_bootstrap_succeeded");
      assert.equal(writes[0].status, "chat_bootstrap");
      assert.equal(writes[0].outcome, "succeeded");
      assert.equal(writes[0].userId, "USER-CHAT-1");
      assert.equal(writes[0].cacheKey, "contacts_USER-CHAT-1");
    },
  },
  {
    name: "stream chat telemetry helper keeps correlation fallback and logger-level fallback behavior",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "warn",
        {
          stage: "contacts_cache_revalidation_failed",
          status: "chat_cache",
          outcome: "failed",
          reason: "redis timeout",
        },
        {
          logger: {
            info: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(typeof writes[0].correlationId, "string");
      assert.equal(writes[0].stage, "contacts_cache_revalidation_failed");
      assert.equal(writes[0].status, "chat_cache");
      assert.equal(writes[0].outcome, "failed");
      assert.equal(writes[0].reason, "redis timeout");
    },
  },
  {
    name: "stream chat telemetry helper keeps mutation telemetry field consistency",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "error",
        {
          correlationId: "chat_mutation_corr_1",
          stage: "group_member_add_failed",
          status: "chat_mutation",
          outcome: "failed",
          reason: "stream timeout",
          userId: "USER-SPOC-1",
          role: "SPOCAdmin",
          channelId: "group_123",
          cleanupMode: "none",
        },
        {
          logger: {
            error: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(writes[0].correlationId, "chat_mutation_corr_1");
      assert.equal(writes[0].stage, "group_member_add_failed");
      assert.equal(writes[0].status, "chat_mutation");
      assert.equal(writes[0].outcome, "failed");
      assert.equal(writes[0].reason, "stream timeout");
      assert.equal(writes[0].userId, "USER-SPOC-1");
      assert.equal(writes[0].role, "SPOCAdmin");
      assert.equal(writes[0].channelId, "group_123");
      assert.equal(writes[0].cleanupMode, "none");
    },
  },
  {
    name: "stream chat telemetry helper keeps mutation fallback defaults for missing fields",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "info",
        {
          stage: "direct_channel_started",
          status: "chat_mutation",
          outcome: "started",
        },
        {
          logger: {
            info: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(typeof writes[0].correlationId, "string");
      assert.equal(writes[0].stage, "direct_channel_started");
      assert.equal(writes[0].status, "chat_mutation");
      assert.equal(writes[0].outcome, "started");
      assert.equal(writes[0].cleanupMode, "none");
      assert.equal(writes[0].attempt, null);
    },
  },
  {
    name: "stream chat telemetry helper keeps announcement/avatar/token field consistency",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "info",
        {
          correlationId: "chat_ops_corr_1",
          stage: "announcement_send_succeeded",
          status: "chat_message",
          outcome: "succeeded",
          userId: "USER-CHAT-ANN-1",
          role: "SPOCAdmin",
          channelId: "portal-announcements",
        },
        {
          logger: {
            info: (payload) => writes.push(payload),
          },
        },
      );
      __logStreamChatTelemetry(
        "error",
        {
          correlationId: "chat_ops_corr_2",
          stage: "avatar_update_failed",
          status: "chat_profile",
          outcome: "failed",
          reason: "partial update failed",
          userId: "USER-CHAT-AVATAR-1",
          cleanupMode: "none",
        },
        {
          logger: {
            error: (payload) => writes.push(payload),
          },
        },
      );
      __logStreamChatTelemetry(
        "debug",
        {
          correlationId: "chat_ops_corr_3",
          stage: "token_generate_started",
          status: "chat_token",
          outcome: "started",
          userId: "USER-CHAT-TOKEN-1",
          role: "Trainer",
        },
        {
          logger: {
            debug: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 3);
      assert.equal(writes[0].stage, "announcement_send_succeeded");
      assert.equal(writes[0].status, "chat_message");
      assert.equal(writes[0].channelId, "portal-announcements");
      assert.equal(writes[1].stage, "avatar_update_failed");
      assert.equal(writes[1].status, "chat_profile");
      assert.equal(writes[1].cleanupMode, "none");
      assert.equal(writes[2].stage, "token_generate_started");
      assert.equal(writes[2].status, "chat_token");
      assert.equal(writes[2].role, "Trainer");
    },
  },
  {
    name: "stream chat telemetry helper keeps ops fallback defaults when optional fields are absent",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "warn",
        {
          stage: "announcement_send_failed",
          status: "chat_message",
          outcome: "failed",
          reason: "stream unavailable",
        },
        {
          logger: {
            warn: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(typeof writes[0].correlationId, "string");
      assert.equal(writes[0].stage, "announcement_send_failed");
      assert.equal(writes[0].status, "chat_message");
      assert.equal(writes[0].outcome, "failed");
      assert.equal(writes[0].reason, "stream unavailable");
      assert.equal(writes[0].cleanupMode, "none");
      assert.equal(writes[0].attempt, null);
      assert.equal(writes[0].userId, null);
      assert.equal(writes[0].channelId, null);
    },
  },
  {
    name: "stream chat telemetry helper keeps search and moderation field consistency",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "info",
        {
          correlationId: "chat_search_corr_1",
          stage: "message_search_succeeded",
          status: "chat_search",
          outcome: "succeeded",
          userId: "USER-CHAT-SEARCH-1",
        },
        {
          logger: {
            info: (payload) => writes.push(payload),
          },
        },
      );
      __logStreamChatTelemetry(
        "error",
        {
          correlationId: "chat_moderation_corr_1",
          stage: "channel_truncate_failed",
          status: "chat_moderation",
          outcome: "failed",
          reason: "stream truncate failed",
          userId: "USER-CHAT-MOD-1",
          role: "SuperAdmin",
          channelId: "chan_101",
          cleanupMode: "none",
        },
        {
          logger: {
            error: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 2);
      assert.equal(writes[0].stage, "message_search_succeeded");
      assert.equal(writes[0].status, "chat_search");
      assert.equal(writes[0].userId, "USER-CHAT-SEARCH-1");
      assert.equal(writes[1].stage, "channel_truncate_failed");
      assert.equal(writes[1].status, "chat_moderation");
      assert.equal(writes[1].reason, "stream truncate failed");
      assert.equal(writes[1].channelId, "chan_101");
      assert.equal(writes[1].cleanupMode, "none");
    },
  },
  {
    name: "stream chat telemetry helper keeps moderation fallback defaults for missing optional fields",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "warn",
        {
          stage: "message_delete_failed",
          status: "chat_moderation",
          outcome: "failed",
          reason: "message missing",
        },
        {
          logger: {
            warn: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(typeof writes[0].correlationId, "string");
      assert.equal(writes[0].stage, "message_delete_failed");
      assert.equal(writes[0].status, "chat_moderation");
      assert.equal(writes[0].outcome, "failed");
      assert.equal(writes[0].reason, "message missing");
      assert.equal(writes[0].cleanupMode, "none");
      assert.equal(writes[0].attempt, null);
      assert.equal(writes[0].channelId, null);
    },
  },
  {
    name: "stream chat telemetry helper keeps auto-create stage consistency",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "info",
        {
          correlationId: "chat_auto_create_corr_1",
          stage: "auto_create_channels_succeeded",
          status: "chat_mutation",
          outcome: "succeeded",
          userId: "TRN-CHAT-1",
          role: "Trainer",
        },
        {
          logger: {
            info: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(writes[0].correlationId, "chat_auto_create_corr_1");
      assert.equal(writes[0].stage, "auto_create_channels_succeeded");
      assert.equal(writes[0].status, "chat_mutation");
      assert.equal(writes[0].outcome, "succeeded");
      assert.equal(writes[0].userId, "TRN-CHAT-1");
      assert.equal(writes[0].role, "Trainer");
    },
  },
  {
    name: "autoCreateTrainerAdminChannels keeps non-blocking safety on malformed payload",
    run: async () => {
      const response = await autoCreateTrainerAdminChannels(
        {},
        [{}],
        { correlationId: "chat_auto_create_corr_2" },
      );

      assert.equal(response, undefined);
    },
  },
  {
    name: "stream chat telemetry helper keeps delete-channel stage consistency",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "info",
        {
          correlationId: "chat_delete_channel_corr_1",
          stage: "channel_delete_for_everyone_succeeded",
          status: "chat_moderation",
          outcome: "succeeded",
          userId: "USER-SUPERADMIN-1",
          role: "SuperAdmin",
          channelId: "channel_abc",
        },
        {
          logger: {
            info: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(writes[0].correlationId, "chat_delete_channel_corr_1");
      assert.equal(writes[0].stage, "channel_delete_for_everyone_succeeded");
      assert.equal(writes[0].status, "chat_moderation");
      assert.equal(writes[0].outcome, "succeeded");
      assert.equal(writes[0].userId, "USER-SUPERADMIN-1");
      assert.equal(writes[0].role, "SuperAdmin");
      assert.equal(writes[0].channelId, "channel_abc");
    },
  },
  {
    name: "stream chat telemetry helper keeps broadcast-create stage consistency",
    run: () => {
      const writes = [];
      __logStreamChatTelemetry(
        "info",
        {
          correlationId: "chat_broadcast_corr_1",
          stage: "broadcast_channel_create_succeeded",
          status: "chat_mutation",
          outcome: "succeeded",
          userId: "USER-SUPERADMIN-1",
          role: "SuperAdmin",
          channelId: "broadcast_101",
        },
        {
          logger: {
            info: (payload) => writes.push(payload),
          },
        },
      );

      assert.equal(writes.length, 1);
      assert.equal(writes[0].correlationId, "chat_broadcast_corr_1");
      assert.equal(writes[0].stage, "broadcast_channel_create_succeeded");
      assert.equal(writes[0].status, "chat_mutation");
      assert.equal(writes[0].outcome, "succeeded");
      assert.equal(writes[0].userId, "USER-SUPERADMIN-1");
      assert.equal(writes[0].role, "SuperAdmin");
      assert.equal(writes[0].channelId, "broadcast_101");
    },
  },
  {
    name: "createBroadcastChannel keeps validation behavior and correlation-aware telemetry on failure",
    run: async () => {
      const writes = [];
      const testLogger = {
        debug: (payload) => writes.push({ level: "debug", ...payload }),
        info: (payload) => writes.push({ level: "info", ...payload }),
        error: (payload) => writes.push({ level: "error", ...payload }),
      };

      await assert.rejects(
        () =>
          createBroadcastChannel(
            {
              _id: "USER-SUPERADMIN-1",
              role: "SuperAdmin",
            },
            { name: "   ", description: "" },
            {
              correlationId: "chat_broadcast_corr_2",
              logger: testLogger,
            },
          ),
        (error) => {
          assert.equal(error?.statusCode, 500);
          assert.equal(error?.message, "Broadcast name is required");
          return true;
        },
      );

      assert.equal(writes.length, 2);
      assert.equal(writes[0].level, "debug");
      assert.equal(writes[0].correlationId, "chat_broadcast_corr_2");
      assert.equal(writes[0].stage, "broadcast_channel_create_started");
      assert.equal(writes[0].status, "chat_mutation");
      assert.equal(writes[0].outcome, "started");

      assert.equal(writes[1].level, "error");
      assert.equal(writes[1].correlationId, "chat_broadcast_corr_2");
      assert.equal(writes[1].stage, "broadcast_channel_create_failed");
      assert.equal(writes[1].status, "chat_mutation");
      assert.equal(writes[1].outcome, "failed");
      assert.equal(writes[1].reason, "Broadcast name is required");
      assert.equal(writes[1].cleanupMode, "none");
    },
  },
  {
    name: "deleteChannelForEveryone keeps unauthorized guard behavior",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChannelForEveryone(
            {
              _id: "USER-TRAINER-1",
              role: "Trainer",
            },
            "channel_unauth",
          ),
        (error) => {
          assert.equal(error?.statusCode, 403);
          assert.equal(error?.message, "Unauthorized: Super Admin role required");
          return true;
        },
      );
    },
  },
  {
    name: "chat create feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedUserId = null;
      let capturedCreateArgs = null;

      const payload = await createChatFeed({
        currentUserId: "USER-CHAT-CREATE-UNIT-1",
        payload: {
          mode: "private",
          targetUserId: "USER-CHAT-TARGET-UNIT-1",
        },
        findChatActorLoader: async ({ userId }) => {
          capturedUserId = userId;
          return {
            _id: "USER-CHAT-CREATE-UNIT-1",
            name: "Create Unit User",
            role: "Trainer",
            blockedUsers: [],
            isActive: true,
          };
        },
        createChatLoader: async ({ currentUser, payload: createPayload }) => {
          capturedCreateArgs = { currentUser, payload: createPayload };
          return {
            _id: "CHAT-CREATE-UNIT-1",
            isGroup: false,
          };
        },
      });

      assert.equal(capturedUserId, "USER-CHAT-CREATE-UNIT-1");
      assert.deepEqual(capturedCreateArgs, {
        currentUser: {
          _id: "USER-CHAT-CREATE-UNIT-1",
          name: "Create Unit User",
          role: "Trainer",
          blockedUsers: [],
          isActive: true,
        },
        payload: {
          mode: "private",
          targetUserId: "USER-CHAT-TARGET-UNIT-1",
        },
      });
      assert.deepEqual(payload, {
        success: true,
        message: "Chat created",
        data: {
          _id: "CHAT-CREATE-UNIT-1",
          isGroup: false,
        },
      });
    },
  },
  {
    name: "chat create feed keeps explicit user-not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          createChatFeed({
            currentUserId: "USER-CHAT-CREATE-UNIT-404",
            payload: { mode: "private" },
            findChatActorLoader: async () => null,
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "User not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat create feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          createChatFeed({
            currentUserId: "USER-CHAT-CREATE-UNIT-500",
            payload: { mode: "private", targetUserId: "USER-500" },
            findChatActorLoader: async () => ({
              _id: "USER-CHAT-CREATE-UNIT-500",
              role: "Trainer",
            }),
            createChatLoader: async () => {
              throw new Error("chat create backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "chat create backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat direct feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedUserId = null;
      let capturedCreateArgs = null;

      const payload = await createDirectChatFeed({
        currentUserId: "USER-CHAT-DIRECT-UNIT-1",
        payload: {
          memberId: "USER-CHAT-DIRECT-TARGET-1",
        },
        findChatActorLoader: async ({ userId }) => {
          capturedUserId = userId;
          return {
            _id: "USER-CHAT-DIRECT-UNIT-1",
            name: "Direct Unit User",
            role: "Trainer",
          };
        },
        createDirectChatLoader: async ({ currentUser, payload: createPayload }) => {
          capturedCreateArgs = { currentUser, payload: createPayload };
          return {
            channelId: "CHANNEL-DIRECT-UNIT-1",
            created: true,
          };
        },
      });

      assert.equal(capturedUserId, "USER-CHAT-DIRECT-UNIT-1");
      assert.deepEqual(capturedCreateArgs, {
        currentUser: {
          _id: "USER-CHAT-DIRECT-UNIT-1",
          name: "Direct Unit User",
          role: "Trainer",
        },
        payload: {
          memberId: "USER-CHAT-DIRECT-TARGET-1",
        },
      });
      assert.deepEqual(payload, {
        success: true,
        channelId: "CHANNEL-DIRECT-UNIT-1",
        created: true,
      });
    },
  },
  {
    name: "chat direct feed keeps null-user pass-through parity",
    run: async () => {
      let capturedCurrentUser = "__unset__";
      await assert.rejects(
        () =>
          createDirectChatFeed({
            currentUserId: "USER-CHAT-DIRECT-UNIT-NULL",
            payload: { memberId: "USER-2" },
            findChatActorLoader: async () => null,
            createDirectChatLoader: async ({ currentUser }) => {
              capturedCurrentUser = currentUser;
              const error = new Error("Cannot read properties of null (reading '_id')");
              error.statusCode = 500;
              throw error;
            },
          }),
        (error) => {
          assert.equal(capturedCurrentUser, null);
          assert.equal(error?.statusCode, 500);
          assert.equal(error?.message, "Cannot read properties of null (reading '_id')");
          return true;
        },
      );
    },
  },
  {
    name: "chat direct feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          createDirectChatFeed({
            currentUserId: "USER-CHAT-DIRECT-UNIT-400",
            payload: {},
            findChatActorLoader: async () => ({
              _id: "USER-CHAT-DIRECT-UNIT-400",
              role: "Trainer",
            }),
            createDirectChatLoader: async () => {
              const error = new Error("Member ID is required for direct channel");
              error.statusCode = 400;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 400);
          assert.equal(error?.message, "Member ID is required for direct channel");
          return true;
        },
      );
    },
  },
  {
    name: "chat group create feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedUserId = null;
      let capturedCreateArgs = null;

      const payload = await createChatGroupFeed({
        currentUserId: "USER-CHAT-GROUP-CREATE-UNIT-1",
        payload: {
          name: "Group Unit One",
          memberIds: ["GROUP-MEMBER-UNIT-1", "GROUP-MEMBER-UNIT-2"],
        },
        findChatActorLoader: async ({ userId }) => {
          capturedUserId = userId;
          return {
            _id: "USER-CHAT-GROUP-CREATE-UNIT-1",
            name: "Group Create Unit User",
            role: "SPOCAdmin",
          };
        },
        createGroupChatLoader: async ({ currentUser, payload: createPayload }) => {
          capturedCreateArgs = { currentUser, payload: createPayload };
          return {
            channelId: "GROUP-CHANNEL-UNIT-1",
            created: true,
          };
        },
      });

      assert.equal(capturedUserId, "USER-CHAT-GROUP-CREATE-UNIT-1");
      assert.deepEqual(capturedCreateArgs, {
        currentUser: {
          _id: "USER-CHAT-GROUP-CREATE-UNIT-1",
          name: "Group Create Unit User",
          role: "SPOCAdmin",
        },
        payload: {
          name: "Group Unit One",
          memberIds: ["GROUP-MEMBER-UNIT-1", "GROUP-MEMBER-UNIT-2"],
        },
      });
      assert.deepEqual(payload, {
        success: true,
        channelId: "GROUP-CHANNEL-UNIT-1",
        created: true,
      });
    },
  },
  {
    name: "chat group create feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          createChatGroupFeed({
            currentUserId: "USER-CHAT-GROUP-CREATE-UNIT-400",
            payload: {},
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
              role: "SPOCAdmin",
            }),
            createGroupChatLoader: async () => {
              const error = new Error("Group name is required");
              error.statusCode = 400;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 400);
          assert.equal(error?.message, "Group name is required");
          return true;
        },
      );
    },
  },
  {
    name: "chat group create feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          createChatGroupFeed({
            currentUserId: "USER-CHAT-GROUP-CREATE-UNIT-500",
            payload: {
              name: "Group Unit Error",
              memberIds: ["GROUP-MEMBER-UNIT-500"],
            },
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            createGroupChatLoader: async () => {
              throw new Error("group create backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "group create backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat broadcast feed keeps degraded publish parity and announcement response shape",
    run: async () => {
      const emitted = [];
      const logs = [];

      const result = await createChatBroadcastFeed({
        io: { emit: (...args) => emitted.push(args) },
        currentUserId: "USER-CHAT-BROADCAST-UNIT-1",
        payload: {
          text: "Important admin update",
          attachments: [{ type: "file", name: "notice.pdf" }],
        },
        findChatActorLoader: async () => ({
          _id: "USER-CHAT-BROADCAST-UNIT-1",
          id: "USER-CHAT-BROADCAST-UNIT-1",
          role: "SuperAdmin",
          name: "Admin Unit",
          email: "admin.unit@example.com",
        }),
        listBroadcastRecipientsLoader: async () => [
          { _id: "RECIPIENT-UNIT-1", role: "Trainer" },
          { _id: "RECIPIENT-UNIT-2", role: "SPOCAdmin" },
        ],
        createBroadcastNotificationsLoader: async () => ({}),
        sendAnnouncementLoader: async () => {
          throw new Error("stream unavailable");
        },
        logValidationLoader: async ({ payload }) => {
          logs.push(payload);
        },
        nowLoader: () => 1775000000000,
        isoDateLoader: () => "2026-04-06T10:00:00.000Z",
      });

      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.responsePayload, {
        success: true,
        mode: "announcement",
        recipientsResolved: 2,
        streamMessageId: null,
        socketEvent: "receive_message",
      });

      assert.equal(emitted.length, 1);
      assert.equal(emitted[0][0], "receive_message");
      assert.equal(emitted[0][1].broadcastId, "broadcast-1775000000000");
      assert.equal(emitted[0][1].sentAt, "2026-04-06T10:00:00.000Z");

      assert.equal(logs.length, 2);
      assert.equal(logs[0].event, "announcement_stream_publish_degraded");
      assert.equal(logs[0].action, "broadcast");
      assert.equal(logs[1].event, "announcement_sent");
      assert.equal(logs[1].details.recipientsResolved, 2);
    },
  },
  {
    name: "chat broadcast feed keeps channel-create fallback success shape",
    run: async () => {
      const logs = [];

      const result = await createChatBroadcastFeed({
        currentUserId: "USER-CHAT-BROADCAST-UNIT-2",
        payload: {
          name: "Broadcast Unit Channel",
          description: "Unit broadcast channel",
        },
        findChatActorLoader: async () => ({
          _id: "USER-CHAT-BROADCAST-UNIT-2",
          id: "USER-CHAT-BROADCAST-UNIT-2",
          role: "Admin",
          name: "Admin Channel",
        }),
        createBroadcastChannelLoader: async () => ({
          channelId: "BROADCAST-UNIT-CHANNEL-1",
          name: "Broadcast Unit Channel",
          members: ["USER-CHAT-BROADCAST-UNIT-2", "RECIPIENT-UNIT-3"],
        }),
        logValidationLoader: async ({ payload }) => {
          logs.push(payload);
        },
      });

      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.responsePayload, {
        success: true,
        mode: "channel",
        channelId: "BROADCAST-UNIT-CHANNEL-1",
        name: "Broadcast Unit Channel",
        members: ["USER-CHAT-BROADCAST-UNIT-2", "RECIPIENT-UNIT-3"],
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].event, "broadcast_channel_created");
      assert.equal(logs[0].action, "broadcast");
    },
  },
  {
    name: "chat broadcast feed keeps validation and failure mapping parity",
    run: async () => {
      const userNotFound = await createChatBroadcastFeed({
        currentUserId: "USER-CHAT-BROADCAST-UNIT-404",
        payload: { text: "any" },
        findChatActorLoader: async () => null,
      });
      assert.equal(userNotFound.statusCode, 404);
      assert.deepEqual(userNotFound.responsePayload, { message: "User not found" });

      const noInput = await createChatBroadcastFeed({
        currentUserId: "USER-CHAT-BROADCAST-UNIT-400",
        payload: {},
        findChatActorLoader: async () => ({
          _id: "USER-CHAT-BROADCAST-UNIT-400",
          role: "SuperAdmin",
        }),
      });
      assert.equal(noInput.statusCode, 400);
      assert.deepEqual(noInput.responsePayload, {
        message: "Announcement text or broadcast name is required",
      });

      const fatalLogs = [];
      await assert.rejects(
        () =>
          createChatBroadcastFeed({
            currentUserId: "USER-CHAT-BROADCAST-UNIT-500",
            payload: { text: "hello" },
            findChatActorLoader: async () => ({
              _id: "USER-CHAT-BROADCAST-UNIT-500",
              role: "SuperAdmin",
            }),
            listBroadcastRecipientsLoader: async () => {
              throw new Error("recipient lookup failed");
            },
            logValidationLoader: async ({ payload }) => {
              fatalLogs.push(payload);
            },
          }),
        (error) => {
          assert.equal(error?.message, "recipient lookup failed");
          return true;
        },
      );
      assert.equal(fatalLogs.length, 1);
      assert.equal(fatalLogs[0].event, "broadcast_failed");
      assert.equal(fatalLogs[0].action, "broadcast");
    },
  },
  {
    name: "chat message-send feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await sendChatMessageFeed({
        io: { to: () => ({ emit: () => {} }) },
        currentUserId: "USER-CHAT-SEND-UNIT-1",
        payload: {
          type: "text",
          content: "Hello from unit test",
        },
        findChatActorLoader: async ({ userId }) => ({
          _id: userId,
          name: "Sender Unit",
          role: "Trainer",
          blockedUsers: [],
          isActive: true,
        }),
        sendChatMessageLoader: async ({ io, currentUser, payload }) => {
          capturedArgs = { io, currentUser, payload };
          return {
            id: "MSG-SEND-UNIT-1",
            type: payload.type,
            content: payload.content,
          };
        },
      });

      assert.equal(typeof capturedArgs?.io?.to, "function");
      assert.equal(String(capturedArgs?.currentUser?._id), "USER-CHAT-SEND-UNIT-1");
      assert.deepEqual(capturedArgs?.payload, {
        type: "text",
        content: "Hello from unit test",
      });
      assert.deepEqual(payload, {
        success: true,
        message: "Message sent",
        allowedTypes: ["text", "image", "video", "pdf", "audio", "voice"],
        data: {
          id: "MSG-SEND-UNIT-1",
          type: "text",
          content: "Hello from unit test",
        },
      });
    },
  },
  {
    name: "chat message-send feed keeps sender-not-found status parity",
    run: async () => {
      await assert.rejects(
        () =>
          sendChatMessageFeed({
            currentUserId: "USER-CHAT-SEND-UNIT-404",
            payload: { type: "text", content: "hello" },
            findChatActorLoader: async () => null,
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "User not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat message-send feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          sendChatMessageFeed({
            currentUserId: "USER-CHAT-SEND-UNIT-400",
            payload: { type: "text", content: "" },
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
              role: "Trainer",
              blockedUsers: [],
              isActive: true,
            }),
            sendChatMessageLoader: async () => {
              const error = new Error("content/text is required for text messages");
              error.statusCode = 400;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 400);
          assert.equal(error?.message, "content/text is required for text messages");
          return true;
        },
      );
    },
  },
  {
    name: "chat message-send feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          sendChatMessageFeed({
            currentUserId: "USER-CHAT-SEND-UNIT-500",
            payload: { type: "text", content: "hello" },
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
              role: "Trainer",
              blockedUsers: [],
              isActive: true,
            }),
            sendChatMessageLoader: async () => {
              throw new Error("send-message backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "send-message backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat delete-for-me feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await deleteChatMessageForMeFeed({
        io: { to: () => ({ emit: () => {} }) },
        actorId: "USER-CHAT-DEL-ME-UNIT-1",
        messageId: "MSG-CHAT-DEL-ME-UNIT-1",
        deleteMessageForMeLoader: async ({ io, actorId, messageId }) => {
          capturedArgs = { io, actorId, messageId };
          return {
            success: true,
            scope: "me",
            messageId,
            userId: actorId,
          };
        },
      });

      assert.equal(typeof capturedArgs?.io?.to, "function");
      assert.deepEqual(
        { actorId: capturedArgs?.actorId, messageId: capturedArgs?.messageId },
        {
          actorId: "USER-CHAT-DEL-ME-UNIT-1",
          messageId: "MSG-CHAT-DEL-ME-UNIT-1",
        },
      );
      assert.deepEqual(payload, {
        success: true,
        message: "Message deleted for you",
        data: {
          success: true,
          scope: "me",
          messageId: "MSG-CHAT-DEL-ME-UNIT-1",
          userId: "USER-CHAT-DEL-ME-UNIT-1",
        },
      });
    },
  },
  {
    name: "chat delete-for-me feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChatMessageForMeFeed({
            actorId: "USER-CHAT-DEL-ME-UNIT-400",
            messageId: "",
            deleteMessageForMeLoader: async () => {
              const error = new Error("messageId is required");
              error.statusCode = 400;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 400);
          assert.equal(error?.message, "messageId is required");
          return true;
        },
      );
    },
  },
  {
    name: "chat delete-for-me feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChatMessageForMeFeed({
            actorId: "USER-CHAT-DEL-ME-UNIT-500",
            messageId: "MSG-500",
            deleteMessageForMeLoader: async () => {
              throw new Error("delete-for-me backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "delete-for-me backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat delete-for-everyone feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await deleteChatMessageForEveryoneFeed({
        io: { to: () => ({ emit: () => {} }) },
        actorId: "USER-CHAT-DEL-EVERY-UNIT-1",
        messageId: "MSG-CHAT-DEL-EVERY-UNIT-1",
        deleteMessageForEveryoneLoader: async ({ io, actorId, messageId }) => {
          capturedArgs = { io, actorId, messageId };
          return {
            success: true,
            scope: "everyone",
            messageId,
            deletedBy: actorId,
          };
        },
      });

      assert.equal(typeof capturedArgs?.io?.to, "function");
      assert.deepEqual(
        { actorId: capturedArgs?.actorId, messageId: capturedArgs?.messageId },
        {
          actorId: "USER-CHAT-DEL-EVERY-UNIT-1",
          messageId: "MSG-CHAT-DEL-EVERY-UNIT-1",
        },
      );
      assert.deepEqual(payload, {
        success: true,
        message: "Message deleted for everyone",
        data: {
          success: true,
          scope: "everyone",
          messageId: "MSG-CHAT-DEL-EVERY-UNIT-1",
          deletedBy: "USER-CHAT-DEL-EVERY-UNIT-1",
        },
      });
    },
  },
  {
    name: "chat delete-for-everyone feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChatMessageForEveryoneFeed({
            actorId: "USER-CHAT-DEL-EVERY-UNIT-403",
            messageId: "MSG-403",
            deleteMessageForEveryoneLoader: async () => {
              const error = new Error("Only sender can delete for everyone");
              error.statusCode = 403;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 403);
          assert.equal(error?.message, "Only sender can delete for everyone");
          return true;
        },
      );
    },
  },
  {
    name: "chat delete-for-everyone feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChatMessageForEveryoneFeed({
            actorId: "USER-CHAT-DEL-EVERY-UNIT-500",
            messageId: "MSG-500",
            deleteMessageForEveryoneLoader: async () => {
              throw new Error("delete-for-everyone backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "delete-for-everyone backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat delete-message feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await deleteChatMessageFeed({
        currentUserId: "USER-CHAT-DEL-UNIT-1",
        messageId: "MSG-CHAT-DEL-UNIT-1",
        deleteMessageLoader: async ({ currentUserId, messageId }) => {
          capturedArgs = { currentUserId, messageId };
          return {
            deleted: true,
            messageId,
            deletedBy: currentUserId,
          };
        },
      });

      assert.deepEqual(capturedArgs, {
        currentUserId: "USER-CHAT-DEL-UNIT-1",
        messageId: "MSG-CHAT-DEL-UNIT-1",
      });
      assert.deepEqual(payload, {
        success: true,
        deleted: true,
        messageId: "MSG-CHAT-DEL-UNIT-1",
        deletedBy: "USER-CHAT-DEL-UNIT-1",
      });
    },
  },
  {
    name: "chat delete-message feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChatMessageFeed({
            currentUserId: "USER-CHAT-DEL-UNIT-404",
            messageId: "MSG-404",
            deleteMessageLoader: async () => {
              const error = new Error("Message not found");
              error.statusCode = 404;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "Message not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat delete-message feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChatMessageFeed({
            currentUserId: "USER-CHAT-DEL-UNIT-500",
            messageId: "MSG-500",
            deleteMessageLoader: async () => {
              throw new Error("delete-message backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "delete-message backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat leave-channel feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await leaveChatChannelFeed({
        currentUserId: "USER-CHAT-LEAVE-UNIT-1",
        channelId: "CHANNEL-LEAVE-UNIT-1",
        type: "messaging",
        findChatActorLoader: async ({ userId }) => ({
          _id: userId,
          role: "Trainer",
        }),
        removeChannelMemberLoader: async ({ currentUser, channelId, memberId, type }) => {
          capturedArgs = { currentUser, channelId, memberId, type };
          return {
            left: true,
            channelId,
            memberId,
            type,
          };
        },
      });

      assert.equal(String(capturedArgs?.currentUser?._id), "USER-CHAT-LEAVE-UNIT-1");
      assert.deepEqual(
        {
          channelId: capturedArgs?.channelId,
          memberId: capturedArgs?.memberId,
          type: capturedArgs?.type,
        },
        {
          channelId: "CHANNEL-LEAVE-UNIT-1",
          memberId: "USER-CHAT-LEAVE-UNIT-1",
          type: "messaging",
        },
      );
      assert.deepEqual(payload, {
        success: true,
        left: true,
        channelId: "CHANNEL-LEAVE-UNIT-1",
        memberId: "USER-CHAT-LEAVE-UNIT-1",
        type: "messaging",
      });
    },
  },
  {
    name: "chat leave-channel feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          leaveChatChannelFeed({
            currentUserId: "USER-CHAT-LEAVE-UNIT-404",
            channelId: "CHANNEL-LEAVE-UNIT-404",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            removeChannelMemberLoader: async () => {
              const error = new Error("Channel not found");
              error.statusCode = 404;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "Channel not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat leave-channel feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          leaveChatChannelFeed({
            currentUserId: "USER-CHAT-LEAVE-UNIT-500",
            channelId: "CHANNEL-LEAVE-UNIT-500",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            removeChannelMemberLoader: async () => {
              throw new Error("leave-channel backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "leave-channel backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat channel remove-user feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await removeUserFromChatChannelFeed({
        currentUserId: "USER-CHAT-REMOVE-UNIT-1",
        channelId: "CHANNEL-REMOVE-UNIT-1",
        memberId: "MEMBER-REMOVE-UNIT-1",
        type: "messaging",
        findChatActorLoader: async ({ userId }) => ({
          _id: userId,
          role: "SPOCAdmin",
        }),
        removeUserFromChannelLoader: async ({ currentUser, channelId, memberId, type }) => {
          capturedArgs = { currentUser, channelId, memberId, type };
          return {
            removed: true,
            channelId,
            memberId,
            type,
          };
        },
      });

      assert.equal(String(capturedArgs?.currentUser?._id), "USER-CHAT-REMOVE-UNIT-1");
      assert.deepEqual(
        {
          channelId: capturedArgs?.channelId,
          memberId: capturedArgs?.memberId,
          type: capturedArgs?.type,
        },
        {
          channelId: "CHANNEL-REMOVE-UNIT-1",
          memberId: "MEMBER-REMOVE-UNIT-1",
          type: "messaging",
        },
      );
      assert.deepEqual(payload, {
        success: true,
        removed: true,
        channelId: "CHANNEL-REMOVE-UNIT-1",
        memberId: "MEMBER-REMOVE-UNIT-1",
        type: "messaging",
      });
    },
  },
  {
    name: "chat channel remove-user feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          removeUserFromChatChannelFeed({
            currentUserId: "USER-CHAT-REMOVE-UNIT-404",
            channelId: "CHANNEL-REMOVE-UNIT-404",
            memberId: "MEMBER-REMOVE-UNIT-404",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            removeUserFromChannelLoader: async () => {
              const error = new Error("Channel not found");
              error.statusCode = 404;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "Channel not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat channel remove-user feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          removeUserFromChatChannelFeed({
            currentUserId: "USER-CHAT-REMOVE-UNIT-500",
            channelId: "CHANNEL-REMOVE-UNIT-500",
            memberId: "MEMBER-REMOVE-UNIT-500",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            removeUserFromChannelLoader: async () => {
              throw new Error("remove-user backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "remove-user backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat channel clear-messages feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await clearChatChannelMessagesFeed({
        currentUserId: "USER-CHAT-CLEAR-UNIT-1",
        channelId: "CHANNEL-CLEAR-UNIT-1",
        type: "messaging",
        findChatActorLoader: async ({ userId }) => ({
          _id: userId,
          role: "SPOCAdmin",
        }),
        clearChannelMessagesLoader: async ({ currentUser, channelId, type }) => {
          capturedArgs = { currentUser, channelId, type };
          return {
            cleared: true,
            channelId,
            type,
          };
        },
      });

      assert.equal(String(capturedArgs?.currentUser?._id), "USER-CHAT-CLEAR-UNIT-1");
      assert.deepEqual(
        {
          channelId: capturedArgs?.channelId,
          type: capturedArgs?.type,
        },
        {
          channelId: "CHANNEL-CLEAR-UNIT-1",
          type: "messaging",
        },
      );
      assert.deepEqual(payload, {
        success: true,
        cleared: true,
        channelId: "CHANNEL-CLEAR-UNIT-1",
        type: "messaging",
      });
    },
  },
  {
    name: "chat channel clear-messages feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          clearChatChannelMessagesFeed({
            currentUserId: "USER-CHAT-CLEAR-UNIT-404",
            channelId: "CHANNEL-CLEAR-UNIT-404",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            clearChannelMessagesLoader: async () => {
              const error = new Error("Channel not found");
              error.statusCode = 404;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "Channel not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat channel clear-messages feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          clearChatChannelMessagesFeed({
            currentUserId: "USER-CHAT-CLEAR-UNIT-500",
            channelId: "CHANNEL-CLEAR-UNIT-500",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            clearChannelMessagesLoader: async () => {
              throw new Error("clear-history backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "clear-history backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat channel delete feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await deleteChatChannelFeed({
        currentUserId: "USER-CHAT-CHANNEL-DELETE-UNIT-1",
        channelId: "CHANNEL-DELETE-UNIT-1",
        findChatActorLoader: async ({ userId }) => ({
          _id: userId,
          role: "Admin",
        }),
        deleteChatChannelLoader: async ({ currentUser, channelId, type }) => {
          capturedArgs = { currentUser, channelId, type };
          return {
            deleted: true,
            channelId,
            type,
          };
        },
      });

      assert.equal(String(capturedArgs?.currentUser?._id), "USER-CHAT-CHANNEL-DELETE-UNIT-1");
      assert.deepEqual(
        {
          channelId: capturedArgs?.channelId,
          type: capturedArgs?.type,
        },
        {
          channelId: "CHANNEL-DELETE-UNIT-1",
          type: "messaging",
        },
      );
      assert.deepEqual(payload, {
        success: true,
        deleted: true,
        channelId: "CHANNEL-DELETE-UNIT-1",
        type: "messaging",
      });
    },
  },
  {
    name: "chat channel delete feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChatChannelFeed({
            currentUserId: "USER-CHAT-CHANNEL-DELETE-UNIT-404",
            channelId: "CHANNEL-DELETE-UNIT-404",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            deleteChatChannelLoader: async () => {
              const error = new Error("Channel not found");
              error.statusCode = 404;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "Channel not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat channel delete feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteChatChannelFeed({
            currentUserId: "USER-CHAT-CHANNEL-DELETE-UNIT-500",
            channelId: "CHANNEL-DELETE-UNIT-500",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            deleteChatChannelLoader: async () => {
              throw new Error("delete-channel backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "delete-channel backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat group remove-member feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await removeChatGroupMemberFeed({
        currentUserId: "USER-CHAT-GROUP-REMOVE-UNIT-1",
        groupId: "GROUP-REMOVE-UNIT-1",
        userIdToRemove: "USER-REMOVE-UNIT-1",
        findChatActorLoader: async ({ userId }) => ({
          _id: userId,
          role: "SPOCAdmin",
        }),
        removeGroupMemberLoader: async ({ currentUser, groupId, userIdToRemove }) => {
          capturedArgs = { currentUser, groupId, userIdToRemove };
          return {
            removed: true,
            groupId,
            userId: userIdToRemove,
          };
        },
      });

      assert.equal(String(capturedArgs?.currentUser?._id), "USER-CHAT-GROUP-REMOVE-UNIT-1");
      assert.deepEqual(
        {
          groupId: capturedArgs?.groupId,
          userIdToRemove: capturedArgs?.userIdToRemove,
        },
        {
          groupId: "GROUP-REMOVE-UNIT-1",
          userIdToRemove: "USER-REMOVE-UNIT-1",
        },
      );
      assert.deepEqual(payload, {
        success: true,
        removed: true,
        groupId: "GROUP-REMOVE-UNIT-1",
        userId: "USER-REMOVE-UNIT-1",
      });
    },
  },
  {
    name: "chat group remove-member feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          removeChatGroupMemberFeed({
            currentUserId: "USER-CHAT-GROUP-REMOVE-UNIT-404",
            groupId: "GROUP-REMOVE-UNIT-404",
            userIdToRemove: "USER-REMOVE-UNIT-404",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            removeGroupMemberLoader: async () => {
              const error = new Error("Group not found");
              error.statusCode = 404;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "Group not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat group remove-member feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          removeChatGroupMemberFeed({
            currentUserId: "USER-CHAT-GROUP-REMOVE-UNIT-500",
            groupId: "GROUP-REMOVE-UNIT-500",
            userIdToRemove: "USER-REMOVE-UNIT-500",
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            removeGroupMemberLoader: async () => {
              throw new Error("group remove-member backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "group remove-member backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat group add-members feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedArgs = null;
      const payload = await addChatGroupMembersFeed({
        currentUserId: "USER-CHAT-GROUP-ADD-UNIT-1",
        groupId: "GROUP-ADD-UNIT-1",
        memberIds: ["MEMBER-ADD-UNIT-1", "MEMBER-ADD-UNIT-2"],
        findChatActorLoader: async ({ userId }) => ({
          _id: userId,
          role: "SPOCAdmin",
        }),
        addGroupMembersLoader: async ({ currentUser, groupId, memberIds }) => {
          capturedArgs = { currentUser, groupId, memberIds };
          return {
            addedMemberIds: memberIds,
          };
        },
      });

      assert.equal(String(capturedArgs?.currentUser?._id), "USER-CHAT-GROUP-ADD-UNIT-1");
      assert.deepEqual(
        {
          groupId: capturedArgs?.groupId,
          memberIds: capturedArgs?.memberIds,
        },
        {
          groupId: "GROUP-ADD-UNIT-1",
          memberIds: ["MEMBER-ADD-UNIT-1", "MEMBER-ADD-UNIT-2"],
        },
      );
      assert.deepEqual(payload, {
        success: true,
        addedMemberIds: ["MEMBER-ADD-UNIT-1", "MEMBER-ADD-UNIT-2"],
      });
    },
  },
  {
    name: "chat group add-members feed keeps validation/status error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          addChatGroupMembersFeed({
            currentUserId: "USER-CHAT-GROUP-ADD-UNIT-400",
            groupId: "GROUP-ADD-UNIT-400",
            memberIds: [],
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            addGroupMembersLoader: async () => {
              const error = new Error("memberIds are required");
              error.statusCode = 400;
              throw error;
            },
          }),
        (error) => {
          assert.equal(error?.statusCode, 400);
          assert.equal(error?.message, "memberIds are required");
          return true;
        },
      );
    },
  },
  {
    name: "chat group add-members feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          addChatGroupMembersFeed({
            currentUserId: "USER-CHAT-GROUP-ADD-UNIT-500",
            groupId: "GROUP-ADD-UNIT-500",
            memberIds: ["MEMBER-ADD-UNIT-500"],
            findChatActorLoader: async ({ userId }) => ({
              _id: userId,
            }),
            addGroupMembersLoader: async () => {
              throw new Error("group add-members backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "group add-members backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat bootstrap feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedUserId = null;
      let capturedBootstrapUser = null;

      const payload = await getChatBootstrapFeed({
        currentUserId: "USER-CHAT-BOOTSTRAP-UNIT-1",
        findUserByIdLoader: async ({ userId }) => {
          capturedUserId = userId;
          return {
            _id: "USER-CHAT-BOOTSTRAP-UNIT-1",
            name: "Bootstrap Unit User",
            role: "Trainer",
          };
        },
        createWorkspaceBootstrapLoader: async ({ user }) => {
          capturedBootstrapUser = user;
          return {
            enabled: true,
            token: "token-bootstrap-unit-1",
            apiKey: "stream-key-unit-1",
            currentUser: {
              id: "USER-CHAT-BOOTSTRAP-UNIT-1",
              name: "Bootstrap Unit User",
              role: "Trainer",
            },
            users: {
              "USER-CHAT-BOOTSTRAP-UNIT-1": {
                id: "USER-CHAT-BOOTSTRAP-UNIT-1",
                name: "Bootstrap Unit User",
                role: "Trainer",
              },
            },
            permissions: { canStartDirectChat: true },
            directContacts: [],
            groupCandidates: [],
            channelIds: ["channel-boot-unit-1"],
            announcementChannel: { id: "announcement" },
            announcementChannelId: "announcement",
          };
        },
      });

      assert.equal(capturedUserId, "USER-CHAT-BOOTSTRAP-UNIT-1");
      assert.deepEqual(capturedBootstrapUser, {
        _id: "USER-CHAT-BOOTSTRAP-UNIT-1",
        name: "Bootstrap Unit User",
        role: "Trainer",
      });
      assert.deepEqual(payload, {
        success: true,
        enabled: true,
        token: "token-bootstrap-unit-1",
        apiKey: "stream-key-unit-1",
        currentUser: {
          id: "USER-CHAT-BOOTSTRAP-UNIT-1",
          name: "Bootstrap Unit User",
          role: "Trainer",
        },
        users: {
          "USER-CHAT-BOOTSTRAP-UNIT-1": {
            id: "USER-CHAT-BOOTSTRAP-UNIT-1",
            name: "Bootstrap Unit User",
            role: "Trainer",
          },
        },
        permissions: { canStartDirectChat: true },
        directContacts: [],
        groupCandidates: [],
        channelIds: ["channel-boot-unit-1"],
        announcementChannel: { id: "announcement" },
        announcementChannelId: "announcement",
        bootstrap: {
          enabled: true,
          token: "token-bootstrap-unit-1",
          apiKey: "stream-key-unit-1",
          currentUser: {
            id: "USER-CHAT-BOOTSTRAP-UNIT-1",
            name: "Bootstrap Unit User",
            role: "Trainer",
          },
          users: {
            "USER-CHAT-BOOTSTRAP-UNIT-1": {
              id: "USER-CHAT-BOOTSTRAP-UNIT-1",
              name: "Bootstrap Unit User",
              role: "Trainer",
            },
          },
          permissions: { canStartDirectChat: true },
          directContacts: [],
          groupCandidates: [],
          channelIds: ["channel-boot-unit-1"],
          announcementChannel: { id: "announcement" },
          announcementChannelId: "announcement",
        },
        user: {
          id: "USER-CHAT-BOOTSTRAP-UNIT-1",
          name: "Bootstrap Unit User",
          role: "Trainer",
        },
      });
    },
  },
  {
    name: "chat bootstrap feed keeps explicit user-not-found guard parity",
    run: async () => {
      await assert.rejects(
        () =>
          getChatBootstrapFeed({
            currentUserId: "USER-CHAT-BOOTSTRAP-UNIT-404",
            findUserByIdLoader: async () => null,
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "User not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat bootstrap feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          getChatBootstrapFeed({
            currentUserId: "USER-CHAT-BOOTSTRAP-UNIT-500",
            findUserByIdLoader: async () => ({
              _id: "USER-CHAT-BOOTSTRAP-UNIT-500",
            }),
            createWorkspaceBootstrapLoader: async () => {
              throw new Error("chat bootstrap backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "chat bootstrap backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat quick-bootstrap feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedUserId = null;
      let capturedQuickBootstrapUser = null;

      const payload = await getChatQuickBootstrapFeed({
        currentUserId: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
        findUserByIdLoader: async ({ userId }) => {
          capturedUserId = userId;
          return {
            _id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
            name: "Quick Bootstrap Unit User",
            role: "Trainer",
          };
        },
        createWorkspaceQuickBootstrapLoader: async ({ user }) => {
          capturedQuickBootstrapUser = user;
          return {
            enabled: true,
            token: "token-quick-bootstrap-unit-1",
            apiKey: "stream-key-quick-unit-1",
            currentUser: {
              id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
              name: "Quick Bootstrap Unit User",
              role: "Trainer",
            },
            users: {
              "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1": {
                id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
                name: "Quick Bootstrap Unit User",
                role: "Trainer",
              },
            },
            permissions: { canStartDirectChat: true },
            directContacts: [],
            groupCandidates: [],
            channelIds: ["channel-quick-boot-unit-1"],
            announcementChannel: { id: "announcement" },
            announcementChannelId: "announcement",
          };
        },
      });

      assert.equal(capturedUserId, "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1");
      assert.deepEqual(capturedQuickBootstrapUser, {
        _id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
        name: "Quick Bootstrap Unit User",
        role: "Trainer",
      });
      assert.deepEqual(payload, {
        success: true,
        enabled: true,
        token: "token-quick-bootstrap-unit-1",
        apiKey: "stream-key-quick-unit-1",
        currentUser: {
          id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
          name: "Quick Bootstrap Unit User",
          role: "Trainer",
        },
        users: {
          "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1": {
            id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
            name: "Quick Bootstrap Unit User",
            role: "Trainer",
          },
        },
        permissions: { canStartDirectChat: true },
        directContacts: [],
        groupCandidates: [],
        channelIds: ["channel-quick-boot-unit-1"],
        announcementChannel: { id: "announcement" },
        announcementChannelId: "announcement",
        bootstrap: {
          enabled: true,
          token: "token-quick-bootstrap-unit-1",
          apiKey: "stream-key-quick-unit-1",
          currentUser: {
            id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
            name: "Quick Bootstrap Unit User",
            role: "Trainer",
          },
          users: {
            "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1": {
              id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
              name: "Quick Bootstrap Unit User",
              role: "Trainer",
            },
          },
          permissions: { canStartDirectChat: true },
          directContacts: [],
          groupCandidates: [],
          channelIds: ["channel-quick-boot-unit-1"],
          announcementChannel: { id: "announcement" },
          announcementChannelId: "announcement",
        },
        user: {
          id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-1",
          name: "Quick Bootstrap Unit User",
          role: "Trainer",
        },
      });
    },
  },
  {
    name: "chat quick-bootstrap feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          getChatQuickBootstrapFeed({
            currentUserId: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-500",
            findUserByIdLoader: async () => ({
              _id: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-500",
            }),
            createWorkspaceQuickBootstrapLoader: async () => {
              throw new Error("chat quick bootstrap backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "chat quick bootstrap backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat quick-bootstrap feed keeps explicit user-not-found guard parity",
    run: async () => {
      await assert.rejects(
        () =>
          getChatQuickBootstrapFeed({
            currentUserId: "USER-CHAT-QUICK-BOOTSTRAP-UNIT-404",
            findUserByIdLoader: async () => null,
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "User not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat full-bootstrap feed keeps success shape and payload pass-through parity",
    run: async () => {
      let capturedUserId = null;
      let capturedFullBootstrapUser = null;

      const payload = await getChatFullBootstrapFeed({
        currentUserId: "USER-CHAT-FULL-BOOTSTRAP-UNIT-1",
        findUserByIdLoader: async ({ userId }) => {
          capturedUserId = userId;
          return {
            _id: "USER-CHAT-FULL-BOOTSTRAP-UNIT-1",
            name: "Full Bootstrap Unit User",
            role: "Trainer",
          };
        },
        createWorkspaceFullBootstrapLoader: async ({ user }) => {
          capturedFullBootstrapUser = user;
          return {
            directContacts: [
              {
                portalUserId: "USER-TRAINER-3",
                name: "Trainer Three",
                roleLabel: "Trainer",
                image: null,
              },
            ],
            groupCandidates: [],
            users: {
              "USER-TRAINER-3": {
                id: "USER-TRAINER-3",
                name: "Trainer Three",
                role: "Trainer",
                image: null,
              },
            },
          };
        },
      });

      assert.equal(capturedUserId, "USER-CHAT-FULL-BOOTSTRAP-UNIT-1");
      assert.deepEqual(capturedFullBootstrapUser, {
        _id: "USER-CHAT-FULL-BOOTSTRAP-UNIT-1",
        name: "Full Bootstrap Unit User",
        role: "Trainer",
      });
      assert.deepEqual(payload, {
        success: true,
        directContacts: [
          {
            portalUserId: "USER-TRAINER-3",
            name: "Trainer Three",
            roleLabel: "Trainer",
            image: null,
          },
        ],
        groupCandidates: [],
        users: {
          "USER-TRAINER-3": {
            id: "USER-TRAINER-3",
            name: "Trainer Three",
            role: "Trainer",
            image: null,
          },
        },
      });
    },
  },
  {
    name: "chat full-bootstrap feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          getChatFullBootstrapFeed({
            currentUserId: "USER-CHAT-FULL-BOOTSTRAP-UNIT-500",
            findUserByIdLoader: async () => ({
              _id: "USER-CHAT-FULL-BOOTSTRAP-UNIT-500",
            }),
            createWorkspaceFullBootstrapLoader: async () => {
              throw new Error("chat full bootstrap backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "chat full bootstrap backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat full-bootstrap feed keeps explicit user-not-found guard parity",
    run: async () => {
      await assert.rejects(
        () =>
          getChatFullBootstrapFeed({
            currentUserId: "USER-CHAT-FULL-BOOTSTRAP-UNIT-404",
            findUserByIdLoader: async () => null,
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "User not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat list feed keeps success shape and query/filter pass-through parity",
    run: async () => {
      let capturedQuery = null;
      const payload = await listChatListFeed({
        currentUserId: "USER-CHAT-LIST-UNIT-1",
        query: {
          search: "hello-list",
          page: "3",
          limit: "12",
        },
        listChatsLoader: async ({ query }) => {
          capturedQuery = query;
          return {
            total: 1,
            page: 3,
            limit: 12,
            data: [{ id: "CHAT-LIST-1", name: "Hello list" }],
          };
        },
      });

      assert.deepEqual(capturedQuery, {
        currentUserId: "USER-CHAT-LIST-UNIT-1",
        search: "hello-list",
        page: "3",
        limit: "12",
      });
      assert.deepEqual(payload, {
        success: true,
        total: 1,
        page: 3,
        limit: 12,
        data: [{ id: "CHAT-LIST-1", name: "Hello list" }],
      });
    },
  },
  {
    name: "chat list feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          listChatListFeed({
            currentUserId: "USER-CHAT-LIST-UNIT-2",
            query: { search: "", page: 1, limit: 30 },
            listChatsLoader: async () => {
              throw new Error("chat list backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "chat list backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat search feed keeps success shape and query/filter pass-through parity",
    run: async () => {
      let capturedQuery = null;
      const payload = await listChatSearchFeed({
        currentUserId: "USER-CHAT-SEARCH-UNIT-1",
        query: {
          search: "hello",
          page: "2",
          limit: "15",
        },
        searchChatMessagesLoader: async ({ query }) => {
          capturedQuery = query;
          return {
            total: 1,
            page: 2,
            limit: 15,
            data: [{ id: "MSG-1", content: "hello world" }],
            users: {
              "USER-CHAT-SEARCH-UNIT-1": {
                id: "USER-CHAT-SEARCH-UNIT-1",
                name: "Requester",
              },
            },
          };
        },
      });

      assert.deepEqual(capturedQuery, {
        currentUserId: "USER-CHAT-SEARCH-UNIT-1",
        search: "hello",
        page: "2",
        limit: "15",
      });
      assert.deepEqual(payload, {
        success: true,
        total: 1,
        page: 2,
        limit: 15,
        data: [{ id: "MSG-1", content: "hello world" }],
        users: {
          "USER-CHAT-SEARCH-UNIT-1": {
            id: "USER-CHAT-SEARCH-UNIT-1",
            name: "Requester",
          },
        },
      });
    },
  },
  {
    name: "chat search feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          listChatSearchFeed({
            currentUserId: "USER-CHAT-SEARCH-UNIT-2",
            query: { search: "hello", page: 1, limit: 20 },
            searchChatMessagesLoader: async () => {
              throw new Error("search backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "search backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat message search feed keeps success shape and query/filter pass-through parity",
    run: async () => {
      let capturedQuery = null;
      const payload = await listChatMessageSearchFeed({
        currentUserId: "USER-CHAT-MSG-SEARCH-UNIT-1",
        query: {
          search: "hello-message",
          page: "2",
          limit: "10",
        },
        searchChatMessagesLoader: async ({ query }) => {
          capturedQuery = query;
          return {
            total: 1,
            page: 2,
            limit: 10,
            data: [{ id: "MSG-M-1", content: "hello-message" }],
            users: {},
          };
        },
      });

      assert.deepEqual(capturedQuery, {
        currentUserId: "USER-CHAT-MSG-SEARCH-UNIT-1",
        search: "hello-message",
        page: "2",
        limit: "10",
      });
      assert.deepEqual(payload, {
        success: true,
        total: 1,
        page: 2,
        limit: 10,
        data: [{ id: "MSG-M-1", content: "hello-message" }],
        users: {},
      });
    },
  },
  {
    name: "chat message search feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          listChatMessageSearchFeed({
            currentUserId: "USER-CHAT-MSG-SEARCH-UNIT-2",
            query: { search: "hello-message", page: 1, limit: 20 },
            searchChatMessagesLoader: async () => {
              throw new Error("message search backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "message search backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat message history feed keeps success shape and query pass-through parity",
    run: async () => {
      let capturedQuery = null;
      const payload = await listChatMessageHistoryFeed({
        currentUserId: "USER-CHAT-HISTORY-UNIT-1",
        otherUserId: "USER-CHAT-HISTORY-OTHER-UNIT-1",
        query: {
          page: "2",
          limit: "25",
        },
        getChatMessageHistoryLoader: async ({ query }) => {
          capturedQuery = query;
          return {
            total: 2,
            page: 2,
            limit: 25,
            data: [{ id: "MSG-H-2" }, { id: "MSG-H-1" }],
          };
        },
      });

      assert.deepEqual(capturedQuery, {
        currentUserId: "USER-CHAT-HISTORY-UNIT-1",
        otherUserId: "USER-CHAT-HISTORY-OTHER-UNIT-1",
        page: "2",
        limit: "25",
      });
      assert.deepEqual(payload, {
        success: true,
        total: 2,
        page: 2,
        limit: 25,
        data: [{ id: "MSG-H-2" }, { id: "MSG-H-1" }],
      });
    },
  },
  {
    name: "chat message history feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          listChatMessageHistoryFeed({
            currentUserId: "USER-CHAT-HISTORY-UNIT-2",
            otherUserId: "USER-CHAT-HISTORY-OTHER-UNIT-2",
            query: { page: 1, limit: 50 },
            getChatMessageHistoryLoader: async () => {
              throw new Error("message history backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "message history backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat info feed keeps success shape and query pass-through parity",
    run: async () => {
      let capturedQuery = null;
      const payload = await getChatInfoFeed({
        currentUserId: "USER-CHAT-INFO-UNIT-1",
        chatId: "CHAT-INFO-UNIT-1",
        query: {
          mediaLimit: 250,
          fileLimit: 120,
          linkLimit: 90,
        },
        getChatInfoLoader: async ({ query }) => {
          capturedQuery = query;
          return {
            chat: { _id: "CHAT-INFO-UNIT-1" },
            members: [],
            media: [],
            documents: [],
            links: [],
          };
        },
      });

      assert.deepEqual(capturedQuery, {
        currentUserId: "USER-CHAT-INFO-UNIT-1",
        chatId: "CHAT-INFO-UNIT-1",
        mediaLimit: 250,
        fileLimit: 120,
        linkLimit: 90,
      });
      assert.deepEqual(payload, {
        success: true,
        data: {
          chat: { _id: "CHAT-INFO-UNIT-1" },
          members: [],
          media: [],
          documents: [],
          links: [],
        },
      });
    },
  },
  {
    name: "chat info feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          getChatInfoFeed({
            currentUserId: "USER-CHAT-INFO-UNIT-2",
            chatId: "CHAT-INFO-UNIT-2",
            query: {
              mediaLimit: 100,
              fileLimit: 100,
              linkLimit: 100,
            },
            getChatInfoLoader: async () => {
              throw new Error("chat info backend failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "chat info backend failed");
          return true;
        },
      );
    },
  },
  {
    name: "chat channel audit-log feed keeps success shape and query pass-through parity",
    run: async () => {
      let capturedQuery = null;
      const payload = await listChatChannelAuditLogFeed({
        channelId: "CHANNEL-AUDIT-UNIT-1",
        query: {
          limit: "50",
          page: "3",
        },
        listChannelAuditLogsLoader: async ({ query }) => {
          capturedQuery = query;
          return {
            total: 2,
            data: [{ event: "message_sent" }, { event: "message_deleted" }],
          };
        },
      });

      assert.deepEqual(capturedQuery, {
        channelId: "CHANNEL-AUDIT-UNIT-1",
        limit: "50",
        page: "3",
      });
      assert.deepEqual(payload, {
        success: true,
        logs: [{ event: "message_sent" }, { event: "message_deleted" }],
        total: 2,
      });
    },
  },
  {
    name: "chat channel audit-log feed keeps empty-state compatibility defaults",
    run: async () => {
      const payload = await listChatChannelAuditLogFeed({
        channelId: "CHANNEL-AUDIT-UNIT-2",
        query: {
          limit: 100,
          page: 1,
        },
        listChannelAuditLogsLoader: async () => ({
          data: null,
          total: undefined,
        }),
      });

      assert.deepEqual(payload, {
        success: true,
        logs: [],
        total: 0,
      });
    },
  },
  {
    name: "chat validation logs feed keeps role-based user filter parity for non-admin requester",
    run: async () => {
      let capturedQuery = null;
      const payload = await listChatValidationLogsFeed({
        requesterId: "USER-TRAINER-LOG-1",
        query: {
          page: "2",
          limit: "25",
          userId: "USER-OTHER-LOG-1",
          action: "broadcast",
        },
        findRequesterByIdLoader: async () => ({
          _id: "USER-TRAINER-LOG-1",
          role: "Trainer",
        }),
        listValidationLogsLoader: async ({ query }) => {
          capturedQuery = query;
          return {
            total: 1,
            page: 2,
            limit: 25,
            data: [{ action: "broadcast" }],
          };
        },
      });

      assert.equal(capturedQuery.userId, "USER-TRAINER-LOG-1");
      assert.equal(capturedQuery.action, "broadcast");
      assert.deepEqual(payload, {
        success: true,
        total: 1,
        page: 2,
        limit: 25,
        data: [{ action: "broadcast" }],
      });
    },
  },
  {
    name: "chat validation logs feed keeps role-based user filter parity for admin requester",
    run: async () => {
      let capturedQuery = null;
      await listChatValidationLogsFeed({
        requesterId: "USER-SUPERADMIN-LOG-1",
        query: {
          userId: "USER-FILTER-LOG-1",
          lane: "broadcast",
        },
        findRequesterByIdLoader: async () => ({
          _id: "USER-SUPERADMIN-LOG-1",
          role: "SuperAdmin",
        }),
        listValidationLogsLoader: async ({ query }) => {
          capturedQuery = query;
          return {
            total: 0,
            page: 1,
            limit: 100,
            data: [],
          };
        },
      });

      assert.equal(capturedQuery.userId, "USER-FILTER-LOG-1");
      assert.equal(capturedQuery.lane, "broadcast");
    },
  },
  {
    name: "chat validation logs feed preserves requester-not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          listChatValidationLogsFeed({
            requesterId: "USER-NOT-FOUND-LOG-1",
            query: {},
            findRequesterByIdLoader: async () => null,
            listValidationLogsLoader: async () => ({
              total: 0,
              page: 1,
              limit: 100,
              data: [],
            }),
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "User not found");
          return true;
        },
      );
    },
  },
  {
    name: "chat broadcast feed degraded publish path uses structured logging and no ad-hoc console warn",
    run: () => {
      const chatServicePath = path.resolve(
        process.cwd(),
        "modules",
        "chat",
        "chat.service.js",
      );
      const source = fs.readFileSync(chatServicePath, "utf8");

      assert.doesNotMatch(source, /console\.warn\(/);
      assert.match(source, /void logValidationLoader\(\{/);
      assert.match(source, /event:\s*"announcement_stream_publish_degraded"/);
      assert.match(source, /action:\s*"broadcast"/);
      assert.match(source, /status:\s*"failed"/);
    },
  },
  {
    name: "chat broadcast feed announcement response contract stays unchanged",
    run: () => {
      const chatServicePath = path.resolve(
        process.cwd(),
        "modules",
        "chat",
        "chat.service.js",
      );
      const source = fs.readFileSync(chatServicePath, "utf8");

      assert.match(source, /mode:\s*"announcement"/);
      assert.match(source, /recipientsResolved:\s*recipients\.length/);
      assert.match(source, /streamMessageId/);
      assert.match(source, /socketEvent:\s*"receive_message"/);
    },
  },
  {
    name: "chat routes keep mutation handlers adapter-only (no inline async bodies)",
    run: () => {
      const chatRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "chatRoutes.mjs",
      );
      const source = fs.readFileSync(chatRoutesPath, "utf8");

      assert.doesNotMatch(
        source,
        /router\.(post|put|patch|delete)\([\s\S]*?async\s*\(req,\s*res\)\s*=>/,
      );
      assert.match(source, /chatChannelDeleteController/);
      assert.match(source, /chatBroadcastController/);
    },
  },
  {
    name: "attendance schedule feed keeps success shape and query pass-through parity",
    run: async () => {
      let capturedScheduleId = null;
      const payload = await listAttendanceBySchedule({
        scheduleId: "SCHEDULE-ATT-UNIT-1",
        findAttendanceByScheduleIdLoader: async (scheduleId) => {
          capturedScheduleId = scheduleId;
          return [
            { _id: "ATT-1", scheduleId: "SCHEDULE-ATT-UNIT-1" },
            { _id: "ATT-2", scheduleId: "SCHEDULE-ATT-UNIT-1" },
          ];
        },
      });

      assert.equal(capturedScheduleId, "SCHEDULE-ATT-UNIT-1");
      assert.deepEqual(payload, {
        success: true,
        data: [
          { _id: "ATT-1", scheduleId: "SCHEDULE-ATT-UNIT-1" },
          { _id: "ATT-2", scheduleId: "SCHEDULE-ATT-UNIT-1" },
        ],
      });
    },
  },
  {
    name: "attendance schedule feed keeps empty-state not-found parity",
    run: async () => {
      const payload = await listAttendanceBySchedule({
        scheduleId: "SCHEDULE-ATT-UNIT-EMPTY",
        findAttendanceByScheduleIdLoader: async () => [],
      });

      assert.deepEqual(payload, {
        success: true,
        data: [],
      });
    },
  },
  {
    name: "attendance schedule feed keeps invalid-id/error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          listAttendanceBySchedule({
            scheduleId: "bad-id",
            findAttendanceByScheduleIdLoader: async () => {
              throw new Error(
                'Cast to ObjectId failed for value "bad-id" (type string) at path "scheduleId" for model "Attendance"',
              );
            },
          }),
        (error) => {
          assert.match(error?.message || "", /Cast to ObjectId failed/);
          return true;
        },
      );
    },
  },
  {
    name: "attendance legacy schedule route stays adapter-delegated",
    run: () => {
      const attendanceRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "attendanceRoutes.js",
      );
      const source = fs.readFileSync(attendanceRoutesPath, "utf8");

      assert.match(
        source,
        /router\.get\('\/schedule\/:scheduleId',\s*getAttendanceScheduleController\);/,
      );
      assert.doesNotMatch(
        source,
        /router\.get\('\/schedule\/:scheduleId',\s*async\s*\(req,\s*res\)\s*=>/,
      );
    },
  },
  {
    name: "attendance geo upload handler keeps non-actionable schedule guard parity",
    run: () => {
      const attendanceRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "attendanceRoutes.js",
      );
      const source = fs.readFileSync(attendanceRoutesPath, "utf8");

      assert.match(source, /const uploadAccessError = validateAssignedScheduleUpload\(\{/);
      assert.match(source, /const geoUploadSessionStateError = validateCheckOutSessionState\(\{/);
    },
  },
  {
    name: "attendance check-out handler keeps stale session guard parity",
    run: () => {
      const attendanceRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "attendanceRoutes.js",
      );
      const source = fs.readFileSync(attendanceRoutesPath, "utf8");

      assert.match(source, /const scheduleActionabilityError = validateAssignedScheduleUpload\(\{/);
      assert.match(source, /const checkOutSessionStateError = validateCheckOutSessionState\(\{/);
    },
  },
  {
    name: "attendance geo-verification list keeps manual-review visibility fallbacks",
    run: () => {
      const attendanceServicePath = path.resolve(
        process.cwd(),
        "modules",
        "attendance",
        "attendance.service.js",
      );
      const source = fs.readFileSync(attendanceServicePath, "utf8");

      assert.match(source, /"checkOut\.time":\s*\{\s*\$exists:\s*true,\s*\$ne:\s*null\s*\}/);
      assert.match(source, /query\.checkOutVerificationStatus === "PENDING_OR_REVIEW"/);
      assert.match(source, /"MANUAL_REVIEW_REQUIRED"/);
      assert.match(source, /checkOutVerificationStatus:\s*\{\s*\$exists:\s*false\s*\},\s*[\s\S]*geoVerificationStatus:\s*"pending"/);
      assert.match(source, /query\.checkOutVerificationStatus === "COMPLETED_OR_VERIFIED"/);
      assert.match(source, /checkOutVerificationStatus:\s*\{\s*\$in:\s*\["AUTO_VERIFIED",\s*"VERIFIED"\]\s*\}/);
    },
  },
  {
    name: "attendance trainer workflow selects schedule actionability fields for guards",
    run: () => {
      const attendanceRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "attendanceRoutes.js",
      );
      const source = fs.readFileSync(attendanceRoutesPath, "utf8");

      assert.match(
        source,
        /Schedule\.findById\(scheduleId\)\.select\('[^']*status[^']*isActive[^']*'\)/,
      );
      assert.match(
        source,
        /Schedule\.findById\(scheduleObjectId\)[\s\S]*?\.select\('[^']*status[^']*scheduledDate[^']*isActive[^']*'\)/,
      );
      assert.match(
        source,
        /Schedule\.find\(\{ trainerId: trainer\._id \}\)[\s\S]*?\.select\('[^']*status[^']*scheduledDate[^']*isActive[^']*'\)/,
      );
    },
  },
  {
    name: "attendance details feed keeps success shape and id pass-through parity",
    run: async () => {
      let capturedAttendanceId = null;
      const payload = await getAttendanceLegacyDetails({
        attendanceId: "ATT-DETAIL-1001",
        findAttendanceDetailsByIdLoader: async (attendanceId) => {
          capturedAttendanceId = attendanceId;
          return { _id: "ATT-DETAIL-1001", status: "approved" };
        },
      });

      assert.equal(capturedAttendanceId, "ATT-DETAIL-1001");
      assert.deepEqual(payload, {
        success: true,
        data: { _id: "ATT-DETAIL-1001", status: "approved" },
      });
    },
  },
  {
    name: "attendance details feed keeps not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          getAttendanceLegacyDetails({
            attendanceId: "ATT-DETAIL-MISSING",
            findAttendanceDetailsByIdLoader: async () => null,
          }),
        (error) => {
          assert.equal(error?.statusCode, 404);
          assert.equal(error?.message, "Attendance not found");
          return true;
        },
      );
    },
  },
  {
    name: "attendance details feed keeps invalid-id/error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          getAttendanceLegacyDetails({
            attendanceId: "bad-id",
            findAttendanceDetailsByIdLoader: async () => {
              throw new Error(
                'Cast to ObjectId failed for value "bad-id" (type string) at path "_id" for model "Attendance"',
              );
            },
          }),
        (error) => {
          assert.match(error?.message || "", /Cast to ObjectId failed/);
          return true;
        },
      );
    },
  },
  {
    name: "attendance legacy details route stays adapter-delegated",
    run: () => {
      const attendanceRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "attendanceRoutes.js",
      );
      const source = fs.readFileSync(attendanceRoutesPath, "utf8");

      assert.match(
        source,
        /router\.get\('\/:id\/details',\s*getAttendanceLegacyDetailsController\);/,
      );
      assert.doesNotMatch(
        source,
        /router\.get\('\/:id\/details',\s*async\s*\(req,\s*res\)\s*=>/,
      );
    },
  },
  {
    name: "attendance trainer feed keeps success shape and query pass-through parity",
    run: async () => {
      let capturedPayload = null;
      const payload = await listAttendanceByTrainer({
        trainerId: "TRN-ATT-1001",
        month: "4",
        year: "2026",
        findAttendanceByTrainerIdLoader: async (loaderPayload) => {
          capturedPayload = loaderPayload;
          return [{ _id: "ATT-T-1", trainerId: "TRN-ATT-1001" }];
        },
      });

      assert.deepEqual(capturedPayload, {
        trainerId: "TRN-ATT-1001",
        month: "4",
        year: "2026",
      });
      assert.deepEqual(payload, {
        success: true,
        count: 1,
        data: [{ _id: "ATT-T-1", trainerId: "TRN-ATT-1001" }],
      });
    },
  },
  {
    name: "attendance trainer feed keeps empty-state not-found parity",
    run: async () => {
      const payload = await listAttendanceByTrainer({
        trainerId: "TRN-ATT-EMPTY",
        month: undefined,
        year: undefined,
        findAttendanceByTrainerIdLoader: async () => [],
      });

      assert.deepEqual(payload, {
        success: true,
        count: 0,
        data: [],
      });
    },
  },
  {
    name: "attendance trainer feed keeps invalid-id/error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          listAttendanceByTrainer({
            trainerId: "bad-id",
            findAttendanceByTrainerIdLoader: async () => {
              throw new Error(
                'Cast to ObjectId failed for value "bad-id" (type string) at path "trainerId" for model "Attendance"',
              );
            },
          }),
        (error) => {
          assert.match(error?.message || "", /Cast to ObjectId failed/);
          return true;
        },
      );
    },
  },
  {
    name: "attendance legacy trainer route stays adapter-delegated",
    run: () => {
      const attendanceRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "attendanceRoutes.js",
      );
      const source = fs.readFileSync(attendanceRoutesPath, "utf8");

      assert.match(
        source,
        /router\.get\('\/trainer\/:trainerId',\s*getAttendanceTrainerController\);/,
      );
      assert.doesNotMatch(
        source,
        /router\.get\('\/trainer\/:trainerId',\s*async\s*\(req,\s*res\)\s*=>/,
      );
    },
  },
  {
    name: "attendance college feed keeps success shape and id pass-through parity",
    run: async () => {
      let capturedCollegeId = null;
      const payload = await listAttendanceByCollege({
        collegeId: "COL-ATT-1001",
        findAttendanceByCollegeIdLoader: async (collegeId) => {
          capturedCollegeId = collegeId;
          return [{ _id: "ATT-C-1", collegeId: "COL-ATT-1001" }];
        },
      });

      assert.equal(capturedCollegeId, "COL-ATT-1001");
      assert.deepEqual(payload, {
        success: true,
        data: [{ _id: "ATT-C-1", collegeId: "COL-ATT-1001" }],
      });
    },
  },
  {
    name: "attendance college feed keeps empty-state not-found parity",
    run: async () => {
      const payload = await listAttendanceByCollege({
        collegeId: "COL-ATT-EMPTY",
        findAttendanceByCollegeIdLoader: async () => [],
      });

      assert.deepEqual(payload, {
        success: true,
        data: [],
      });
    },
  },
  {
    name: "attendance college feed keeps invalid-id/error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          listAttendanceByCollege({
            collegeId: "bad-id",
            findAttendanceByCollegeIdLoader: async () => {
              throw new Error(
                'Cast to ObjectId failed for value "bad-id" (type string) at path "collegeId" for model "Attendance"',
              );
            },
          }),
        (error) => {
          assert.match(error?.message || "", /Cast to ObjectId failed/);
          return true;
        },
      );
    },
  },
  {
    name: "attendance legacy college route stays adapter-delegated",
    run: () => {
      const attendanceRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "attendanceRoutes.js",
      );
      const source = fs.readFileSync(attendanceRoutesPath, "utf8");

      assert.match(
        source,
        /router\.get\('\/college\/:collegeId',\s*getAttendanceCollegeController\);/,
      );
      assert.doesNotMatch(
        source,
        /router\.get\('\/college\/:collegeId',\s*async\s*\(req,\s*res\)\s*=>/,
      );
    },
  },
  {
    name: "attendance documents feed keeps success shape and filter pass-through parity",
    run: async () => {
      let capturedFilters = null;
      const payload = await listAttendanceDocuments({
        filters: {
          scheduleId: "507f1f77bcf86cd799439011",
          attendanceId: "507f1f77bcf86cd799439012",
          trainerId: "507f1f77bcf86cd799439013",
          status: "pending",
          fileType: "attendance",
        },
        findAttendanceDocumentsLoader: async ({ filters }) => {
          capturedFilters = filters;
          return [{ _id: "DOC-ATT-1", status: "pending" }];
        },
      });

      assert.deepEqual(capturedFilters, {
        scheduleId: "507f1f77bcf86cd799439011",
        attendanceId: "507f1f77bcf86cd799439012",
        trainerId: "507f1f77bcf86cd799439013",
        status: "pending",
        fileType: "attendance",
      });
      assert.deepEqual(payload, {
        success: true,
        count: 1,
        data: [{ _id: "DOC-ATT-1", status: "pending" }],
      });
    },
  },
  {
    name: "attendance documents feed keeps empty-state parity",
    run: async () => {
      const payload = await listAttendanceDocuments({
        filters: {},
        findAttendanceDocumentsLoader: async () => [],
      });

      assert.deepEqual(payload, {
        success: true,
        count: 0,
        data: [],
      });
    },
  },
  {
    name: "attendance documents feed keeps error pass-through parity",
    run: async () => {
      await assert.rejects(
        () =>
          listAttendanceDocuments({
            filters: { scheduleId: "bad-id" },
            findAttendanceDocumentsLoader: async () => {
              throw new Error("Documents query failed");
            },
          }),
        (error) => {
          assert.equal(error?.message, "Documents query failed");
          return true;
        },
      );
    },
  },
  {
    name: "attendance legacy documents route stays adapter-delegated",
    run: () => {
      const attendanceRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "attendanceRoutes.js",
      );
      const source = fs.readFileSync(attendanceRoutesPath, "utf8");

      assert.match(
        source,
        /router\.get\('\/documents',\s*getAttendanceDocumentsController\);/,
      );
      assert.doesNotMatch(
        source,
        /router\.get\('\/documents',\s*async\s*\(req,\s*res\)\s*=>/,
      );
    },
  },
  {
    name: "file workflow queue metrics aggregate totals and per-type counters",
    run: () => {
      stopFileWorkflowQueueMetricsPersistence();
      resetFileWorkflowQueueMetrics();

      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "queued",
      });
      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "started",
      });
      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "failed",
      });
      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "retried",
      });
      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "succeeded",
      });
      recordFileWorkflowQueueMetric({
        jobType: "drive.file.cleanup",
        outcome: "queued",
      });
      recordFileWorkflowQueueMetric({
        jobType: "drive.file.cleanup",
        outcome: "dropped",
      });

      const snapshot = getFileWorkflowQueueMetricsSnapshot();
      assert.equal(snapshot.totals.queued, 2);
      assert.equal(snapshot.totals.started, 1);
      assert.equal(snapshot.totals.failed, 1);
      assert.equal(snapshot.totals.retried, 1);
      assert.equal(snapshot.totals.succeeded, 1);
      assert.equal(snapshot.totals.dropped, 1);
      assert.equal(typeof snapshot.lastUpdatedAt, "string");
      assert.equal(
        snapshot.byType["attendance.drive.sync"].queued,
        1,
      );
      assert.equal(
        snapshot.byType["attendance.drive.sync"].succeeded,
        1,
      );
      assert.equal(
        snapshot.byType["drive.file.cleanup"].dropped,
        1,
      );
    },
  },
  {
    name: "file workflow queue metrics reset and unknown outcomes keep safe no-op behavior",
    run: () => {
      stopFileWorkflowQueueMetricsPersistence();
      resetFileWorkflowQueueMetrics();
      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "not-a-real-outcome",
      });
      const before = getFileWorkflowQueueMetricsSnapshot();
      assert.equal(before.totals.queued, 0);
      assert.equal(before.lastUpdatedAt, null);

      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "queued",
      });
      const afterQueued = getFileWorkflowQueueMetricsSnapshot();
      assert.equal(afterQueued.totals.queued, 1);

      resetFileWorkflowQueueMetrics();
      const afterReset = getFileWorkflowQueueMetricsSnapshot();
      assert.equal(afterReset.totals.queued, 0);
      assert.equal(Object.keys(afterReset.byType).length, 0);
      assert.equal(afterReset.lastUpdatedAt, null);
    },
  },
  {
    name: "async queue metrics snapshot aggregates queue totals safely",
    run: () => {
      stopFileWorkflowQueueMetricsPersistence();
      resetFileWorkflowQueueMetrics();
      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "queued",
      });
      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "started",
      });
      recordFileWorkflowQueueMetric({
        jobType: "attendance.drive.sync",
        outcome: "failed",
      });

      const snapshot = getAsyncQueueMetricsSnapshot();
      assert.equal(typeof snapshot.generatedAt, "string");
      assert.equal(snapshot.queues.fileWorkflow.totals.queued, 1);
      assert.equal(snapshot.queues.fileWorkflow.totals.started, 1);
      assert.equal(snapshot.queues.fileWorkflow.totals.failed, 1);
      assert.equal(snapshot.totals.queued, 1);
      assert.equal(snapshot.totals.started, 1);
      assert.equal(snapshot.totals.failed, 1);
      assert.equal(snapshot.totals.succeeded, 0);
    },
  },
  {
    name: "department day slots preserve first schedule per day and raw array shape",
    run: () => {
      const days = buildDepartmentDaysPayload({
        schedules: [
          {
            _id: "SCH-101",
            dayNumber: 1,
            trainerId: {
              _id: "TRN-1",
              trainerId: "T-1001",
              userId: { name: "Aisha Trainer" },
            },
            subject: "Day 1 Intro",
            scheduledDate: "2026-04-01T00:00:00.000Z",
            startTime: "09:00",
            endTime: "11:00",
            status: "scheduled",
          },
          {
            _id: "SCH-102",
            dayNumber: 1,
            trainerId: {
              _id: "TRN-2",
              trainerId: "T-1002",
              userId: { name: "Override Candidate" },
            },
            subject: "Should be ignored due to same day",
            status: "scheduled",
          },
        ],
        attendanceDocs: [],
      });

      assert.equal(Array.isArray(days), true);
      assert.equal(days.length, 12);
      assert.equal(days[0].id, "SCH-101");
      assert.equal(days[0].trainerName, "Aisha Trainer");
      assert.equal(days[0].label, "Day 1");
      assert.equal(days[1].id, "placeholder-2");
      assert.equal(days[1].status, "not_assigned");
      assert.equal(days[1].statusTooltip, "Trainer not assigned");
    },
  },
  {
    name: "department day slots compose attendance and geotag upload statuses",
    run: () => {
      const days = buildDepartmentDaysPayload({
        schedules: [
          {
            _id: "SCH-201",
            dayNumber: 1,
            trainerId: { _id: "TRN-1", userId: { name: "Trainer 1" } },
            status: "scheduled",
            dayStatus: "pending",
            startTime: "10:00",
            endTime: "12:00",
          },
          {
            _id: "SCH-202",
            dayNumber: 2,
            trainerId: { _id: "TRN-2", userId: { name: "Trainer 2" } },
            status: "scheduled",
          },
          {
            _id: "SCH-203",
            dayNumber: 3,
            trainerId: null,
            status: "scheduled",
          },
        ],
        attendanceDocs: [
          {
            scheduleId: "SCH-201",
            verificationStatus: "approved",
            geoVerificationStatus: "pending",
            checkOutVerificationStatus: "AUTO_VERIFIED",
            attendancePdfUrl: "attendance-day1.pdf",
            studentsPhotoUrl: "class-day1.jpg",
            latitude: 12.9717,
            longitude: 77.5947,
            studentsPresent: 30,
            studentsAbsent: 2,
          },
          {
            scheduleId: "SCH-202",
            verificationStatus: "rejected",
            geoVerificationStatus: "approved",
            attendancePdfUrl: "attendance-day2.pdf",
            studentsPhotoUrl: "class-day2.jpg",
          },
        ],
      });

      assert.equal(days[0].status, "completed");
      assert.equal(days[0].attendanceUploaded, true);
      assert.equal(days[0].geoTagUploaded, true);
      assert.equal(days[0].statusTooltip, "All documents uploaded");
      assert.equal(days[0].geoTag, "12.9717, 77.5947");

      assert.equal(days[1].status, "pending");
      assert.equal(days[1].attendanceUploaded, true);
      assert.equal(days[1].geoTagUploaded, true);
      assert.equal(days[1].statusTooltip, "Upload Missing Docs");

      assert.equal(days[2].status, "not_assigned");
      assert.equal(days[2].trainerName, "Not Assigned");
    },
  },
  {
    name: "department day slots keep compatibility defaults for empty attendance fields",
    run: () => {
      const days = buildDepartmentDaysPayload({
        schedules: [
          {
            _id: "SCH-301",
            dayNumber: 1,
            trainerId: { _id: "TRN-301", userId: { name: "Trainer 301" } },
            status: "scheduled",
          },
        ],
        attendanceDocs: [
          {
            scheduleId: "SCH-301",
            verificationStatus: "pending",
          },
        ],
      });

      assert.equal(days[0].verificationStatus, "pending");
      assert.equal(days[0].geoVerificationStatus, "pending");
      assert.equal(days[0].attendancePdfUrl, null);
      assert.deepEqual(days[0].checkOutGeoImageUrls, []);
      assert.deepEqual(days[0].activityPhotos, []);
      assert.deepEqual(days[0].activityVideos, []);
      assert.equal(days[0].studentsPresent, 0);
      assert.equal(days[0].studentsAbsent, 0);
      assert.equal(days[0].geoTag, null);
    },
  },
  {
    name: "department days query parser keeps legacy required-field behavior",
    run: () => {
      assert.throws(
        () => parseDepartmentDaysQuery({}),
        (error) =>
          error?.message === "departmentId is required"
          && error?.statusCode === 400,
      );
    },
  },
  {
    name: "schedule associations query parser keeps empty-query compatibility",
    run: () => {
      const parsed = parseAssociationsQuery({ any: "value" });
      assert.deepEqual(parsed, {});
    },
  },
  {
    name: "schedule details params parser keeps raw id behavior",
    run: () => {
      const parsed = parseScheduleDetailParams({ id: "  SCH-1001  " });
      assert.equal(parsed.scheduleId, "SCH-1001");
    },
  },
  {
    name: "assign schedule parsers keep legacy permissive body behavior",
    run: () => {
      const params = parseAssignScheduleParams({ id: " SCH-ASSIGN-1 " });
      const payload = parseAssignScheduleBody({
        trainerId: "TRN-2001",
        scheduledDate: "2026-04-05",
        startTime: "",
        endTime: "11:30",
        ignoredField: "ignored",
      });

      assert.equal(params.scheduleId, "SCH-ASSIGN-1");
      assert.deepEqual(payload, {
        trainerId: "TRN-2001",
        scheduledDate: "2026-04-05",
        startTime: "",
        endTime: "11:30",
      });
    },
  },
  {
    name: "create schedule parser keeps legacy permissive body behavior",
    run: () => {
      const payload = parseCreateScheduleBody({
        trainerId: "TRN-CREATE-1",
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "",
        dayNumber: 4,
        scheduledDate: "2026-05-01",
        startTime: "09:00",
        endTime: "11:00",
        subject: "Communication",
        createdBy: "USER-1",
        ignoredField: "ignore-me",
      });

      assert.deepEqual(payload, {
        trainerId: "TRN-CREATE-1",
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "",
        dayNumber: 4,
        scheduledDate: "2026-05-01",
        startTime: "09:00",
        endTime: "11:00",
        subject: "Communication",
        createdBy: "USER-1",
      });
    },
  },
  {
    name: "create schedule feed keeps defaults, derived fields, and side-effects parity",
    run: async () => {
      let createdPayload = null;
      let emailArgs = null;
      let inAppPayload = null;
      let chatArgs = null;

      const { responsePayload, sideEffectTask } = await createScheduleFeed({
        payload: {
          trainerId: "TRN-CREATE-2",
          companyId: "COMP-1",
          courseId: "COURSE-1",
          collegeId: "COLLEGE-1",
          departmentId: "",
          dayNumber: 2,
          scheduledDate: "2026-05-12",
          startTime: "10:00",
          endTime: "12:00",
          subject: "Mock Interview",
        },
        actorUserId: "USER-SPOC-1",
        io: { id: "io-create" },
        resolveScheduleFolderFields: async ({ fallbackFields }) => {
          assert.equal(fallbackFields.subject, "Mock Interview");
          return {
            driveFolderId: "DRIVE-D2",
            dayFolderId: "DAY-D2",
          };
        },
        getCollegeByIdLoader: async () => ({
          _id: "COLLEGE-1",
          name: "MBK College",
          principalName: "SPOC One",
          phone: "9000000000",
          location: {
            address: "Campus Address",
            lat: 12.97,
            lng: 77.59,
          },
        }),
        createScheduleLoader: async ({ schedulePayload }) => {
          createdPayload = schedulePayload;
          return {
            _id: "SCH-CREATE-2",
            ...schedulePayload,
          };
        },
        getTrainerByIdLoader: async ({ trainerId }) => {
          assert.equal(trainerId, "TRN-CREATE-2");
          return {
            _id: "TRN-CREATE-2",
            name: "Trainer Create",
            userId: {
              _id: "USER-TRN-CREATE",
              name: "Trainer Create User",
              email: "trainer.create@example.com",
            },
          };
        },
        getCourseByIdLoader: async () => ({
          title: "Communication Skills",
        }),
        getUserByIdLoader: async ({ userId }) => {
          assert.equal(userId, "USER-SPOC-1");
          return { _id: "USER-SPOC-1", name: "SPOC Admin" };
        },
        sendScheduleChangeEmailLoader: async (...args) => {
          emailArgs = args;
        },
        sendInAppNotificationLoader: async (_io, notificationPayload) => {
          inAppPayload = notificationPayload;
        },
        createTrainerAdminChannelsLoader: async (...args) => {
          chatArgs = args;
        },
      });

      await sideEffectTask;

      assert.equal(responsePayload.success, true);
      assert.equal(responsePayload.message, "Schedule created successfully");
      assert.equal(responsePayload.data._id, "SCH-CREATE-2");
      assert.equal(createdPayload.createdBy, "USER-SPOC-1");
      assert.equal(createdPayload.status, "scheduled");
      assert.equal(createdPayload.departmentId, null);
      assert.equal(createdPayload.driveFolderId, "DRIVE-D2");
      assert.equal(createdPayload.collegeLocation.address, "Campus Address");

      assert.equal(emailArgs?.[0], "trainer.create@example.com");
      assert.equal(emailArgs?.[3], "assignment");
      assert.equal(emailArgs?.[4], "New training session assigned by administrator.");
      assert.equal(inAppPayload?.title, "Training Assigned");
      assert.deepEqual(chatArgs, [
        {
          _id: "USER-TRN-CREATE",
          name: "Trainer Create User",
          email: "trainer.create@example.com",
        },
        [{ _id: "USER-SPOC-1", name: "SPOC Admin" }],
      ]);
    },
  },
  {
    name: "create schedule feed keeps side-effect safety parity",
    run: async () => {
      const { responsePayload, sideEffectTask } = await createScheduleFeed({
        payload: {
          trainerId: "TRN-CREATE-3",
          companyId: "COMP-1",
          courseId: "COURSE-1",
          collegeId: "COLLEGE-1",
          dayNumber: 3,
          scheduledDate: "2026-05-13",
          startTime: "09:30",
          endTime: "11:30",
          subject: "Aptitude",
        },
        actorUserId: "USER-SPOC-2",
        resolveScheduleFolderFields: async () => ({}),
        getCollegeByIdLoader: async () => ({
          _id: "COLLEGE-1",
          name: "College Side",
          location: {},
        }),
        createScheduleLoader: async ({ schedulePayload }) => ({
          _id: "SCH-CREATE-3",
          ...schedulePayload,
        }),
        getTrainerByIdLoader: async () => ({
          userId: {
            _id: "USER-TRN-CREATE-3",
            email: "trainer.side@example.com",
            name: "Trainer Side",
          },
        }),
        getCourseByIdLoader: async () => ({ title: "Course Side" }),
        sendScheduleChangeEmailLoader: async () => {
          throw new Error("smtp down");
        },
      });

      await sideEffectTask;
      assert.equal(responsePayload.success, true);
      assert.equal(responsePayload.message, "Schedule created successfully");
    },
  },
  {
    name: "create schedule feed keeps invalid-input error parity",
    run: async () => {
      await assert.rejects(
        () =>
          createScheduleFeed({
            payload: {
              trainerId: "TRN-CREATE-ERR",
            },
            getCollegeByIdLoader: async () => null,
            resolveScheduleFolderFields: async () => ({}),
            createScheduleLoader: async () => {
              throw new Error("Schedule validation failed: collegeId is required");
            },
          }),
        (error) => error?.message === "Schedule validation failed: collegeId is required",
      );
    },
  },
  {
    name: "bulk-create schedule parser keeps legacy body shape",
    run: () => {
      const payload = parseBulkCreateScheduleBody({
        schedules: [{ trainerId: "TRN-1" }],
        createdBy: "USER-1",
        ignoredField: "ignored",
      });

      assert.deepEqual(payload, {
        schedules: [{ trainerId: "TRN-1" }],
        createdBy: "USER-1",
      });
    },
  },
  {
    name: "bulk-upload schedule parser keeps legacy file+user context shape",
    run: () => {
      const payload = parseBulkUploadScheduleContext({
        file: { path: "/tmp/sheet.xlsx", originalname: "sheet.xlsx" },
        user: { id: "USER-SPOC-1" },
      });

      assert.deepEqual(payload, {
        file: { path: "/tmp/sheet.xlsx", originalname: "sheet.xlsx" },
        user: { id: "USER-SPOC-1" },
      });
    },
  },
  {
    name: "bulk-upload schedule feed keeps validation and cleanup parity",
    run: async () => {
      await assert.rejects(
        () => bulkUploadSchedulesFeed({ payload: {} }),
        (error) => error?.statusCode === 400 && error?.message === "No file uploaded",
      );

      let cleanupPath = null;
      await assert.rejects(
        () =>
          bulkUploadSchedulesFeed({
            payload: {
              file: { path: "/tmp/invalid.xlsx", originalname: "invalid.xlsx" },
              user: { id: "USER-SPOC-2", name: "SPOC Admin" },
            },
            readWorkbookLoader: () => ({ Sheets: {} }),
            fileExistsLoader: () => true,
            deleteFileLoader: (filePath) => {
              cleanupPath = filePath;
            },
          }),
        (error) => error?.statusCode === 400 && error?.message === "Sheet name must be 'Schedule'",
      );

      assert.equal(cleanupPath, "/tmp/invalid.xlsx");
    },
  },
  {
    name: "bulk-upload schedule feed keeps row-mapping and partial-success response parity",
    run: async () => {
      let cleanedPath = null;
      let invalidatedTrainerIds = null;
      let uploaderNotification = null;
      let activityLogPayload = null;
      let companyLookupCalls = 0;

      const { statusCode, responsePayload } = await bulkUploadSchedulesFeed({
        payload: {
          file: { path: "/tmp/upload.xlsx", originalname: "upload.xlsx" },
          user: { id: "USER-SPOC-3", name: "SPOC Admin 3" },
        },
        actorUserId: "USER-SPOC-3",
        actorUserName: "SPOC Admin 3",
        readWorkbookLoader: () => ({ Sheets: { Schedule: {} } }),
        sheetToRowsLoader: () => ([
          {
            Company: "MBK Company",
            Course: "MBA",
            College: "MBK College",
            TrainerID: "TRN-1001",
            Date: "2026-05-10",
            Day: "Sunday",
            StartTime: "09:30",
            EndTime: "11:30",
          },
          {
            Company: "MBK Company",
            Course: "MBA",
            College: "MBK College",
            Date: "2026-05-11",
          },
        ]),
        fileExistsLoader: () => true,
        deleteFileLoader: (filePath) => {
          cleanedPath = filePath;
        },
        findCompanyByNameLoader: async () => {
          companyLookupCalls += 1;
          return { _id: "COMP-1" };
        },
        findCourseByTitleAndCompanyLoader: async () => ({ _id: "COURSE-1" }),
        findCollegeByNameAndCourseLoader: async () => ({
          _id: "COL-1",
          location: { address: "Campus Road" },
          principalName: "SPOC Principal",
          phone: "9000000000",
        }),
        findTrainerByCustomIdLoader: async () => ({
          _id: "TRN-DB-1001",
          name: "Trainer One",
          userId: {
            _id: "USER-TRN-1001",
            name: "Trainer User One",
            email: "trainer1001@example.com",
          },
        }),
        findApprovedAttendanceByCollegeAndDateRangeLoader: async () => null,
        findScheduleByCollegeCourseAndDateRangeLoader: async () => null,
        findLastScheduleByCollegeLoader: async () => ({ dayNumber: 4 }),
        createScheduleInstanceLoader: async ({ payload }) => ({
          ...payload,
          toObject() {
            return { ...payload };
          },
        }),
        resolveScheduleFolderFields: async () => ({
          driveFolderId: "DAY-5-FOLDER",
        }),
        saveScheduleLoader: async ({ schedule }) => ({
          _id: "SCH-UPLOAD-1",
          ...schedule,
        }),
        invalidateTrainerScheduleCachesLoader: async (trainerIds) => {
          invalidatedTrainerIds = trainerIds;
        },
        createNotificationLoader: async ({ payload }) => {
          if (payload?.title === "Bulk Schedule Uploaded") uploaderNotification = payload;
        },
        createActivityLogLoader: async ({ payload }) => {
          activityLogPayload = payload;
        },
        sendBulkScheduleEmailLoader: () => Promise.reject(new Error("smtp down")),
        notifyTrainerScheduleLoader: () => Promise.reject(new Error("sms down")),
      });

      assert.equal(statusCode, 200);
      assert.equal(responsePayload.success, true);
      assert.equal(responsePayload.inserted, 1);
      assert.equal(responsePayload.skipped, 1);
      assert.equal(responsePayload.skippedDetails.length, 1);
      assert.equal(responsePayload.skippedDetails[0].rowNumber, 3);
      assert.equal(responsePayload.data.success, 1);
      assert.equal(responsePayload.data.failed, 1);
      assert.match(
        responsePayload.data.errors[0],
        /Row 3: Missing required fields in Row 3/,
      );
      assert.deepEqual(invalidatedTrainerIds, ["TRN-DB-1001"]);
      assert.equal(cleanedPath, "/tmp/upload.xlsx");
      assert.equal(companyLookupCalls, 1);
      assert.equal(uploaderNotification?.userId, "USER-SPOC-3");
      assert.equal(activityLogPayload?.action, "BULK_SCHEDULE_UPLOAD");
      assert.equal(activityLogPayload?.details?.fileName, "upload.xlsx");
    },
  },
  {
    name: "resolve schedule folder fields keeps fallback parity when drive is disabled",
    run: async () => {
      let companyLoaderCalled = false;
      let courseLoaderCalled = false;
      let collegeLoaderCalled = false;
      let dayFolderLookupCalled = false;

      const resolveScheduleFolderFields = createResolveScheduleFolderFields({
        loadDepartmentById: async ({ departmentId, select }) => {
          assert.equal(departmentId, "DEP-1");
          assert.equal(select, "dayFolders");
          dayFolderLookupCalled = true;
          return {
            dayFolders: [
              {
                day: 3,
                folderId: "DAY-3",
                folderName: "Day 3",
                folderLink: "https://drive/day-3",
                attendanceFolder: {
                  id: "ATT-3",
                  name: "Attendance 3",
                  link: "https://drive/att-3",
                },
                geoTagFolder: {
                  id: "GEO-3",
                  name: "Geo 3",
                  link: "https://drive/geo-3",
                },
              },
            ],
          };
        },
        isTrainingDriveEnabledLoader: () => false,
        loadCompanyById: async () => {
          companyLoaderCalled = true;
          return null;
        },
        loadCourseById: async () => {
          courseLoaderCalled = true;
          return null;
        },
        loadCollegeById: async () => {
          collegeLoaderCalled = true;
          return null;
        },
      });

      const payload = await resolveScheduleFolderFields({
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COL-1",
        departmentId: "DEP-1",
        dayNumber: 3,
        fallbackFields: {
          driveFolderId: "FALLBACK-DAY",
          attendanceFolderId: "FALLBACK-ATT",
          geoTagFolderId: "FALLBACK-GEO",
        },
      });

      assert.equal(dayFolderLookupCalled, true);
      assert.equal(companyLoaderCalled, false);
      assert.equal(courseLoaderCalled, false);
      assert.equal(collegeLoaderCalled, false);
      assert.deepEqual(payload, {
        dayFolderId: "DAY-3",
        dayFolderName: "Day 3",
        dayFolderLink: "https://drive/day-3",
        attendanceFolderId: "ATT-3",
        attendanceFolderName: "Attendance 3",
        attendanceFolderLink: "https://drive/att-3",
        geoTagFolderId: "GEO-3",
        geoTagFolderName: "Geo 3",
        geoTagFolderLink: "https://drive/geo-3",
        driveFolderId: "DAY-3",
        driveFolderName: "Day 3",
        driveFolderLink: "https://drive/day-3",
      });
    },
  },
  {
    name: "syncDriveHierarchyMetadata keeps department-priority metadata sync parity",
    run: async () => {
      let companySaveCalls = 0;
      let courseSaveCalls = 0;
      let collegeSaveCalls = 0;
      let departmentSaveCalls = 0;

      const company = {
        driveFolderId: "COMP-OLD",
        save: async () => { companySaveCalls += 1; },
      };
      const course = {
        driveFolderId: "COURSE-OLD",
        save: async () => { courseSaveCalls += 1; },
      };
      const college = {
        driveFolderId: "COLLEGE-OLD",
        save: async () => { collegeSaveCalls += 1; },
      };
      const department = {
        driveFolderId: "DEPT-OLD",
        dayFolders: [],
        save: async () => { departmentSaveCalls += 1; },
      };

      await syncDriveHierarchyMetadata({
        company,
        course,
        college,
        department,
        collegeHierarchy: {
          companyFolder: { id: "COMP-COLLEGE", name: "Company College", link: "link-company-college" },
          courseFolder: { id: "COURSE-COLLEGE", name: "Course College", link: "link-course-college" },
          collegeFolder: { id: "COLLEGE-COLLEGE", name: "College College", link: "link-college-college" },
        },
        departmentHierarchy: {
          companyFolder: { id: "COMP-DEPT", name: "Company Dept", link: "link-company-dept" },
          courseFolder: { id: "COURSE-DEPT", name: "Course Dept", link: "link-course-dept" },
          collegeFolder: { id: "COLLEGE-DEPT", name: "College Dept", link: "link-college-dept" },
          departmentFolder: { id: "DEPT-NEW", name: "Department New", link: "link-dept-new" },
          dayFoldersByDayNumber: {
            5: {
              id: "DAY-5",
              name: "Day 5",
              link: "link-day-5",
            },
          },
        },
        toDepartmentDayFoldersLoader: () => [
          { day: 5, folderId: "DAY-5", folderName: "Day 5", folderLink: "link-day-5" },
        ],
      });

      assert.equal(company.driveFolderId, "COMP-DEPT");
      assert.equal(course.driveFolderId, "COURSE-DEPT");
      assert.equal(college.driveFolderId, "COLLEGE-DEPT");
      assert.equal(department.driveFolderId, "DEPT-NEW");
      assert.deepEqual(department.dayFolders, [
        { day: 5, folderId: "DAY-5", folderName: "Day 5", folderLink: "link-day-5" },
      ]);
      assert.equal(companySaveCalls, 1);
      assert.equal(courseSaveCalls, 1);
      assert.equal(collegeSaveCalls, 1);
      assert.equal(departmentSaveCalls, 1);
    },
  },
  {
    name: "resolve schedule folder fields keeps ensured-day precedence and metadata-sync parity",
    run: async () => {
      const company = { _id: "COMP-1", driveFolderId: "COMP-OLD", save: async () => {} };
      const course = { _id: "COURSE-1", driveFolderId: "COURSE-OLD", save: async () => {} };
      const college = {
        _id: "COL-1",
        companyId: "COMP-1",
        courseId: "COURSE-1",
        driveFolderId: "COL-OLD",
        save: async () => {},
      };
      const department = {
        _id: "DEP-1",
        companyId: "COMP-1",
        courseId: "COURSE-1",
        driveFolderId: "DEP-OLD",
        dayFolders: [],
        save: async () => {},
      };

      let syncCalled = false;
      const resolveScheduleFolderFields = createResolveScheduleFolderFields({
        isTrainingDriveEnabledLoader: () => true,
        loadCompanyById: async () => company,
        loadCourseById: async () => course,
        loadCollegeById: async () => college,
        loadDepartmentById: async ({ select }) => {
          if (select === "dayFolders") {
            return {
              dayFolders: [
                {
                  day: 5,
                  folderId: "DAY-FALLBACK-5",
                  folderName: "Day Fallback 5",
                  folderLink: "fallback-day-5",
                },
              ],
            };
          }
          return department;
        },
        ensureDepartmentHierarchyLoader: async () => ({
          dayFoldersByDayNumber: {
            5: {
              id: "DAY-ENSURED-5",
              name: "Day Ensured 5",
              link: "ensured-day-5",
              attendanceFolder: {
                id: "ATT-ENSURED-5",
                name: "Attendance Ensured 5",
                link: "ensured-att-5",
              },
              geoTagFolder: {
                id: "GEO-ENSURED-5",
                name: "Geo Ensured 5",
                link: "ensured-geo-5",
              },
            },
          },
        }),
        syncDriveHierarchyMetadataLoader: async ({ departmentHierarchy }) => {
          syncCalled = Boolean(departmentHierarchy?.dayFoldersByDayNumber?.[5]?.id);
        },
      });

      const payload = await resolveScheduleFolderFields({
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COL-1",
        departmentId: "DEP-1",
        dayNumber: 5,
        fallbackFields: {
          driveFolderId: "FALLBACK-DAY",
          attendanceFolderId: "FALLBACK-ATT",
          geoTagFolderId: "FALLBACK-GEO",
        },
      });

      assert.equal(syncCalled, true);
      assert.deepEqual(payload, {
        dayFolderId: "DAY-ENSURED-5",
        dayFolderName: "Day Ensured 5",
        dayFolderLink: "ensured-day-5",
        attendanceFolderId: "ATT-ENSURED-5",
        attendanceFolderName: "Attendance Ensured 5",
        attendanceFolderLink: "ensured-att-5",
        geoTagFolderId: "GEO-ENSURED-5",
        geoTagFolderName: "Geo Ensured 5",
        geoTagFolderLink: "ensured-geo-5",
        driveFolderId: "DAY-ENSURED-5",
        driveFolderName: "Day Ensured 5",
        driveFolderLink: "ensured-day-5",
      });
    },
  },
  {
    name: "bulk-create schedule feed keeps insert/update/skip response parity",
    run: async () => {
      const bulkOps = [];
      const insertedPayload = [];
      let emailCalls = 0;
      let inAppCalls = 0;

      const { statusCode, responsePayload, sideEffectTask } = await bulkCreateSchedulesFeed({
        payload: {
          createdBy: "USER-BULK-1",
          schedules: [
            {
              trainerId: "TRN-1",
              companyId: "COMP-1",
              courseId: "COURSE-1",
              collegeId: "COL-1",
              departmentId: "DEP-1",
              dayNumber: 1,
              scheduledDate: "2026-05-01",
              startTime: "09:00",
              endTime: "11:00",
            },
            {
              trainerId: "TRN-2",
              companyId: "COMP-1",
              courseId: "COURSE-1",
              collegeId: "COL-1",
              departmentId: "DEP-2",
              dayNumber: 2,
              scheduledDate: "2026-05-02",
              startTime: "10:00",
              endTime: "12:00",
            },
            {
              trainerId: "TRN-X-DUP",
              companyId: "COMP-1",
              courseId: "COURSE-1",
              collegeId: "COL-1",
              departmentId: "DEP-2",
              dayNumber: 2,
              scheduledDate: "2026-05-03",
              startTime: "10:00",
              endTime: "12:00",
            },
          ],
        },
        actorUserId: "USER-SPOC-BULK",
        io: { id: "io-bulk" },
        resolveScheduleFolderFields: async ({ dayNumber }) => ({
          driveFolderId: `DRIVE-${dayNumber}`,
        }),
        listCollegesByIdsLoader: async () => [
          { _id: "COL-1", location: { address: "Bulk Campus" } },
        ],
        listExistingDaySlotSchedulesLoader: async () => [
          {
            _id: "SCH-UPD-1",
            trainerId: "TRN-OLD",
            collegeId: "COL-1",
            departmentId: "DEP-1",
            dayNumber: 1,
            scheduledDate: "2026-04-20",
            toObject() {
              return { _id: "SCH-UPD-1", dayNumber: 1 };
            },
          },
        ],
        insertManySchedulesLoader: async ({ schedules }) => {
          insertedPayload.push(...schedules);
          return [{ _id: "SCH-INS-1", ...schedules[0] }];
        },
        bulkWriteSchedulesLoader: async ({ operations }) => {
          bulkOps.push(...operations);
          return { modifiedCount: operations.length };
        },
        listSchedulesByIdsLoader: async () => [{
          _id: "SCH-UPD-1",
          trainerId: "TRN-1",
          collegeId: "COL-1",
          courseId: "COURSE-1",
          dayNumber: 1,
          scheduledDate: "2026-05-01",
          startTime: "09:00",
          endTime: "11:00",
        }],
        getTrainerByIdLoader: async ({ trainerId }) => ({
          _id: trainerId,
          name: `Trainer ${trainerId}`,
          userId: {
            _id: `USER-${trainerId}`,
            name: `User ${trainerId}`,
            email: `${trainerId.toLowerCase()}@example.com`,
          },
        }),
        getCollegeByIdLoader: async () => ({
          name: "Bulk College",
          principalName: "Bulk SPOC",
          phone: "99999",
          location: { address: "Bulk Address", lat: 12.9, lng: 77.6 },
        }),
        getCourseByIdLoader: async () => ({ title: "Bulk Course" }),
        getUserByIdLoader: async () => ({ _id: "USER-SPOC-BULK", name: "Admin Bulk" }),
        sendBulkScheduleEmailLoader: async () => {
          emailCalls += 1;
        },
        sendInAppNotificationLoader: async () => {
          inAppCalls += 1;
        },
        createTrainerAdminChannelsLoader: async () => {},
      });

      await sideEffectTask;

      assert.equal(statusCode, 200);
      assert.equal(responsePayload.success, true);
      assert.equal(responsePayload.inserted, 1);
      assert.equal(responsePayload.updated, 1);
      assert.equal(responsePayload.skipped, 1);
      assert.match(responsePayload.message, /1 schedules created, 1 schedules updated/);
      assert.equal(responsePayload.skippedDetails[0].reason, "Duplicate day assignment in request payload (same college, department, day)");
      assert.equal(Array.isArray(responsePayload.data), true);
      assert.equal(bulkOps.length, 1);
      assert.equal(insertedPayload.length, 1);
      assert.equal(insertedPayload[0].status, "scheduled");
      assert.equal(insertedPayload[0].createdBy, "USER-BULK-1");
      assert.equal(insertedPayload[0].driveFolderId, "DRIVE-2");
      assert.equal(emailCalls > 0, true);
      assert.equal(inAppCalls > 0, true);
    },
  },
  {
    name: "bulk-create schedule feed keeps validation and side-effect safety parity",
    run: async () => {
      await assert.rejects(
        () =>
          bulkCreateSchedulesFeed({
            payload: {
              schedules: [],
            },
          }),
        (error) => error?.statusCode === 400 && error?.message === "Schedules array is required",
      );

      const { responsePayload, sideEffectTask } = await bulkCreateSchedulesFeed({
        payload: {
          createdBy: "USER-BULK-2",
          schedules: [
            {
              trainerId: "TRN-10",
              companyId: "COMP-1",
              courseId: "COURSE-1",
              collegeId: "COL-1",
              departmentId: null,
              dayNumber: 4,
              scheduledDate: "2026-05-04",
              startTime: "09:00",
              endTime: "11:00",
            },
          ],
        },
        actorUserId: "USER-SPOC-BULK-2",
        resolveScheduleFolderFields: async () => ({}),
        listCollegesByIdsLoader: async () => [{ _id: "COL-1", location: {} }],
        listExistingDaySlotSchedulesLoader: async () => [],
        insertManySchedulesLoader: async ({ schedules }) => [{ _id: "SCH-INS-10", ...schedules[0] }],
        bulkWriteSchedulesLoader: async () => ({ modifiedCount: 0 }),
        listSchedulesByIdsLoader: async () => [],
        getTrainerByIdLoader: async () => ({
          userId: { _id: "USER-TRN-10", email: "trn10@example.com", name: "TRN10" },
        }),
        getCollegeByIdLoader: async () => ({ name: "College Safe" }),
        getCourseByIdLoader: async () => ({ title: "Course Safe" }),
        getUserByIdLoader: async () => ({ _id: "USER-SPOC-BULK-2" }),
        sendBulkScheduleEmailLoader: async () => {
          throw new Error("smtp down");
        },
      });

      await sideEffectTask;
      assert.equal(responsePayload.success, true);
      assert.equal(responsePayload.inserted, 1);
      assert.equal(responsePayload.updated, 0);
    },
  },
  {
    name: "assign schedule feed keeps reassignment, date/time, and response-shape parity",
    run: async () => {
      let invalidatedTrainerIds = null;
      let emailPayload = null;
      let chatPayload = null;
      let inAppNotificationPayload = null;

      const scheduleDoc = {
        _id: "SCH-ASSIGN-2",
        trainerId: "TRN-OLD",
        scheduledDate: "2026-04-01",
        startTime: "09:00",
        endTime: "11:00",
        status: "pending",
        dayNumber: 3,
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
        toObject() {
          return {
            _id: this._id,
            trainerId: this.trainerId,
            scheduledDate: this.scheduledDate,
            startTime: this.startTime,
            endTime: this.endTime,
            status: this.status,
          };
        },
      };

      const payload = await assignScheduleFeed({
        scheduleId: "SCH-ASSIGN-2",
        payload: {
          trainerId: "TRN-NEW",
          scheduledDate: "2026-04-10",
          // Legacy route keeps previous time when blank values are sent.
          startTime: "",
          endTime: "",
        },
        actorUserId: "USER-SPOC-1",
        io: { id: "socket-server" },
        listScheduleById: async ({ scheduleId }) => {
          assert.equal(scheduleId, "SCH-ASSIGN-2");
          return scheduleDoc;
        },
        resolveScheduleFolderFields: async ({ dayNumber, fallbackFields }) => {
          assert.equal(dayNumber, 3);
          assert.equal(fallbackFields._id, "SCH-ASSIGN-2");
          return {
            driveFolderId: "DAY-3-FOLDER",
          };
        },
        saveScheduleLoader: async ({ schedule }) => ({
          ...schedule,
        }),
        getTrainerByIdLoader: async ({ trainerId }) => {
          assert.equal(trainerId, "TRN-NEW");
          return {
            _id: "TRN-NEW",
            name: "Trainer New",
            userId: {
              _id: "USER-TRN-NEW",
              name: "Trainer New User",
              email: "trainer.new@example.com",
            },
          };
        },
        getCollegeByIdLoader: async () => ({
          name: "MBK College",
          principalName: "SPOC Name",
          phone: "9000000000",
          location: {
            address: "College Address",
            lat: 12.97,
            lng: 77.59,
          },
        }),
        getCourseByIdLoader: async () => ({
          title: "Communication Skills",
        }),
        getUserByIdLoader: async ({ userId }) => {
          assert.equal(userId, "USER-SPOC-1");
          return { _id: "USER-SPOC-1", name: "SPOC Admin" };
        },
        sendScheduleChangeEmailLoader: async (...args) => {
          emailPayload = args;
        },
        sendInAppNotificationLoader: async (_io, notificationPayload) => {
          inAppNotificationPayload = notificationPayload;
        },
        createTrainerAdminChannelsLoader: async (...args) => {
          chatPayload = args;
        },
        invalidateTrainerScheduleCachesLoader: async (trainerIds) => {
          invalidatedTrainerIds = trainerIds;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Schedule assigned successfully");
      assert.equal(payload.data._id, "SCH-ASSIGN-2");
      assert.equal(payload.data.trainerId, "TRN-NEW");
      assert.equal(payload.data.scheduledDate, "2026-04-10");
      assert.equal(payload.data.startTime, "09:00");
      assert.equal(payload.data.endTime, "11:00");
      assert.equal(payload.data.status, "scheduled");
      assert.equal(payload.data.driveFolderId, "DAY-3-FOLDER");

      assert.equal(emailPayload?.[0], "trainer.new@example.com");
      assert.equal(emailPayload?.[2]?.course, "Communication Skills");
      assert.equal(emailPayload?.[2]?.startTime, "09:00");
      assert.equal(emailPayload?.[2]?.endTime, "11:00");
      assert.deepEqual(chatPayload, [
        {
          _id: "USER-TRN-NEW",
          name: "Trainer New User",
          email: "trainer.new@example.com",
        },
        [{ _id: "USER-SPOC-1", name: "SPOC Admin" }],
      ]);
      assert.equal(inAppNotificationPayload?.title, "Training Assigned");
      assert.deepEqual(invalidatedTrainerIds, ["TRN-OLD", "TRN-NEW"]);
    },
  },
  {
    name: "assign schedule feed keeps schedule-not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          assignScheduleFeed({
            scheduleId: "SCH-MISSING",
            payload: {
              trainerId: "TRN-1",
              scheduledDate: "2026-04-10",
            },
            listScheduleById: async () => null,
          }),
        (error) => error?.statusCode === 404 && error?.message === "Schedule not found",
      );
    },
  },
  {
    name: "assign schedule feed keeps side-effect safety parity",
    run: async () => {
      let invalidatedTrainerIds = null;
      const payload = await assignScheduleFeed({
        scheduleId: "SCH-ASSIGN-3",
        payload: {
          trainerId: "TRN-NEW-2",
          scheduledDate: "2026-04-11",
        },
        listScheduleById: async () => ({
          _id: "SCH-ASSIGN-3",
          trainerId: "TRN-OLD-2",
          scheduledDate: "2026-04-01",
          startTime: "10:00",
          endTime: "12:00",
          status: "pending",
          dayNumber: 1,
          collegeId: "COLLEGE-1",
          courseId: "COURSE-1",
          toObject() {
            return {
              _id: "SCH-ASSIGN-3",
              trainerId: "TRN-OLD-2",
            };
          },
        }),
        resolveScheduleFolderFields: async () => ({}),
        saveScheduleLoader: async ({ schedule }) => schedule,
        getTrainerByIdLoader: async () => ({
          userId: {
            _id: "USER-TRN-2",
            email: "trainer.two@example.com",
            name: "Trainer Two",
          },
        }),
        getCollegeByIdLoader: async () => ({ name: "College 2" }),
        getCourseByIdLoader: async () => ({ title: "Course 2" }),
        getUserByIdLoader: async () => ({ _id: "USER-SPOC-2" }),
        sendScheduleChangeEmailLoader: async () => {
          throw new Error("smtp down");
        },
        invalidateTrainerScheduleCachesLoader: async (trainerIds) => {
          invalidatedTrainerIds = trainerIds;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Schedule assigned successfully");
      assert.deepEqual(invalidatedTrainerIds, ["TRN-OLD-2", "TRN-NEW-2"]);
    },
  },
  {
    name: "update schedule parsers keep permissive body behavior",
    run: () => {
      const params = parseUpdateScheduleParams({ id: " SCH-UPD-1 " });
      const payload = parseUpdateScheduleBody({
        scheduledDate: "2026-04-20",
        trainerId: "TRN-2002",
        customField: "keep-me",
      });

      assert.equal(params.scheduleId, "SCH-UPD-1");
      assert.deepEqual(payload, {
        scheduledDate: "2026-04-20",
        trainerId: "TRN-2002",
        customField: "keep-me",
      });
    },
  },
  {
    name: "update schedule feed keeps partial updates, folder recompute, and response-shape parity",
    run: async () => {
      let invalidatedTrainerIds = null;
      let emailArgs = null;

      const scheduleDoc = {
        _id: "SCH-UPD-2",
        trainerId: "TRN-OLD-UPD",
        scheduledDate: "2026-04-01",
        startTime: "09:00",
        endTime: "11:00",
        status: "scheduled",
        dayNumber: 2,
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
        subject: "Old Topic",
        toObject() {
          return {
            _id: this._id,
            trainerId: this.trainerId,
            scheduledDate: this.scheduledDate,
            startTime: this.startTime,
            endTime: this.endTime,
            status: this.status,
          };
        },
      };

      const payload = await updateScheduleFeed({
        scheduleId: "SCH-UPD-2",
        payload: {
          trainerId: "TRN-NEW-UPD",
          scheduledDate: "2026-04-10",
          startTime: "10:30",
          attendanceUploaded: "1",
          geoTagUploaded: 0,
          dayStatus: "pending",
          subject: "Updated Topic",
          rescheduleReason: "Trainer timing update",
        },
        io: { id: "io-test" },
        listScheduleById: async ({ scheduleId }) => {
          assert.equal(scheduleId, "SCH-UPD-2");
          return scheduleDoc;
        },
        resolveScheduleFolderFields: async ({ dayNumber, fallbackFields }) => {
          assert.equal(dayNumber, 2);
          assert.equal(fallbackFields._id, "SCH-UPD-2");
          return {
            driveFolderId: "DRIVE-DAY-2",
            dayFolderId: "DAY-2",
          };
        },
        saveScheduleLoader: async ({ schedule }) => ({ ...schedule }),
        getTrainerByIdLoader: async ({ trainerId }) => {
          assert.equal(trainerId, "TRN-NEW-UPD");
          return {
            _id: "TRN-NEW-UPD",
            name: "Updated Trainer",
            userId: {
              _id: "USER-TRN-UPD",
              name: "Updated Trainer User",
              email: "updated.trainer@example.com",
            },
          };
        },
        getCollegeByIdLoader: async () => ({
          name: "MBK College",
          principalName: "Principal SPOC",
          phone: "9999999999",
          location: { address: "College Addr", lat: 12.9, lng: 77.6 },
        }),
        getCourseByIdLoader: async () => ({ title: "Soft Skills" }),
        sendScheduleChangeEmailLoader: async (...args) => {
          emailArgs = args;
        },
        sendInAppNotificationLoader: async () => {},
        invalidateTrainerScheduleCachesLoader: async (trainerIds) => {
          invalidatedTrainerIds = trainerIds;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Schedule updated successfully");
      assert.equal(payload.data._id, "SCH-UPD-2");
      assert.equal(payload.data.trainerId, "TRN-NEW-UPD");
      assert.equal(payload.data.scheduledDate, "2026-04-10");
      assert.equal(payload.data.startTime, "10:30");
      assert.equal(payload.data.endTime, "11:00");
      assert.equal(payload.data.subject, "Updated Topic");
      assert.equal(payload.data.dayStatus, "pending");
      assert.equal(payload.data.attendanceUploaded, true);
      assert.equal(payload.data.geoTagUploaded, false);
      assert.equal(payload.data.driveFolderId, "DRIVE-DAY-2");
      assert.equal(payload.data.dayFolderId, "DAY-2");

      assert.equal(emailArgs?.[0], "updated.trainer@example.com");
      assert.equal(emailArgs?.[3], "reschedule");
      assert.equal(emailArgs?.[4], "Trainer timing update");
      // Legacy behavior computes oldDate after mutation, so oldDate stays null.
      assert.equal(emailArgs?.[2]?.oldDate, null);
      assert.deepEqual(invalidatedTrainerIds, ["TRN-OLD-UPD", "TRN-NEW-UPD"]);
    },
  },
  {
    name: "update schedule feed keeps schedule-not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          updateScheduleFeed({
            scheduleId: "SCH-UPD-MISSING",
            payload: { status: "scheduled" },
            listScheduleById: async () => null,
          }),
        (error) => error?.statusCode === 404 && error?.message === "Schedule not found",
      );
    },
  },
  {
    name: "update schedule feed keeps unchanged-field compatibility",
    run: async () => {
      let invalidatedTrainerIds = null;
      const scheduleDoc = {
        _id: "SCH-UPD-UNCHANGED",
        trainerId: null,
        scheduledDate: "2026-04-01",
        startTime: "09:00",
        endTime: "11:00",
        status: "scheduled",
        dayNumber: 1,
        toObject() {
          return {
            _id: this._id,
            scheduledDate: this.scheduledDate,
          };
        },
      };

      const payload = await updateScheduleFeed({
        scheduleId: "SCH-UPD-UNCHANGED",
        payload: {},
        listScheduleById: async () => scheduleDoc,
        resolveScheduleFolderFields: async () => ({}),
        saveScheduleLoader: async ({ schedule }) => ({ ...schedule }),
        invalidateTrainerScheduleCachesLoader: async (trainerIds) => {
          invalidatedTrainerIds = trainerIds;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Schedule updated successfully");
      assert.equal(payload.data._id, "SCH-UPD-UNCHANGED");
      assert.equal(payload.data.startTime, "09:00");
      assert.equal(payload.data.endTime, "11:00");
      assert.deepEqual(invalidatedTrainerIds, [null, null]);
    },
  },
  {
    name: "update schedule feed keeps side-effect safety parity",
    run: async () => {
      let invalidatedTrainerIds = null;
      const payload = await updateScheduleFeed({
        scheduleId: "SCH-UPD-ERR-SIDE",
        payload: {
          trainerId: "TRN-SIDE-1",
          scheduledDate: "2026-04-22",
        },
        listScheduleById: async () => ({
          _id: "SCH-UPD-ERR-SIDE",
          trainerId: "TRN-SIDE-OLD",
          scheduledDate: "2026-04-01",
          startTime: "08:00",
          endTime: "10:00",
          status: "scheduled",
          dayNumber: 1,
          collegeId: "COL-1",
          courseId: "COURSE-1",
          toObject() {
            return { _id: "SCH-UPD-ERR-SIDE" };
          },
        }),
        resolveScheduleFolderFields: async () => ({}),
        saveScheduleLoader: async ({ schedule }) => schedule,
        getTrainerByIdLoader: async () => ({
          userId: { _id: "USER-SIDE", email: "side@example.com", name: "Trainer Side" },
        }),
        getCollegeByIdLoader: async () => ({ name: "College Side" }),
        getCourseByIdLoader: async () => ({ title: "Course Side" }),
        sendScheduleChangeEmailLoader: async () => {
          throw new Error("smtp down");
        },
        invalidateTrainerScheduleCachesLoader: async (trainerIds) => {
          invalidatedTrainerIds = trainerIds;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Schedule updated successfully");
      assert.deepEqual(invalidatedTrainerIds, ["TRN-SIDE-OLD", "TRN-SIDE-1"]);
    },
  },
  {
    name: "delete schedule parsers keep reason/body/query compatibility",
    run: () => {
      const params = parseDeleteScheduleParams({ id: " SCH-DEL-1 " });
      const payloadFromBody = parseDeleteSchedulePayload({
        body: { reason: "Trainer unavailable" },
        query: { reason: "Ignored query reason" },
      });
      const payloadFromQuery = parseDeleteSchedulePayload({
        body: {},
        query: { reason: "Batch completed" },
      });

      assert.equal(params.scheduleId, "SCH-DEL-1");
      assert.deepEqual(payloadFromBody, { reason: "Trainer unavailable" });
      assert.deepEqual(payloadFromQuery, { reason: "Batch completed" });
    },
  },
  {
    name: "delete schedule feed keeps success/reason/cancellation/cache parity",
    run: async () => {
      let deletedScheduleId = null;
      let invalidatedTrainerIds = null;
      let emailArgs = null;
      let inAppPayload = null;

      const scheduleDoc = {
        _id: "SCH-DEL-2",
        trainerId: "TRN-DEL-OLD",
        scheduledDate: "2026-04-25",
        startTime: "09:00",
        endTime: "11:00",
        dayNumber: 5,
        collegeId: "COL-DEL-1",
        courseId: "COURSE-DEL-1",
      };

      const payload = await deleteScheduleFeed({
        scheduleId: "SCH-DEL-2",
        payload: { reason: "Batch completed" },
        io: { id: "io-delete" },
        listScheduleById: async ({ scheduleId }) => {
          assert.equal(scheduleId, "SCH-DEL-2");
          return scheduleDoc;
        },
        deleteScheduleLoader: async ({ schedule }) => {
          deletedScheduleId = schedule?._id;
        },
        getTrainerByIdLoader: async ({ trainerId }) => {
          assert.equal(trainerId, "TRN-DEL-OLD");
          return {
            _id: "TRN-DEL-OLD",
            name: "Trainer Delete",
            userId: {
              _id: "USER-TRN-DEL",
              name: "Trainer Delete User",
              email: "trainer.delete@example.com",
            },
          };
        },
        getCollegeByIdLoader: async () => ({
          name: "MBK College",
          principalName: "SPOC Delete",
          phone: "9876543210",
        }),
        getCourseByIdLoader: async () => ({
          title: "Delete Flow Course",
        }),
        sendScheduleChangeEmailLoader: async (...args) => {
          emailArgs = args;
        },
        sendInAppNotificationLoader: async (_io, notificationPayload) => {
          inAppPayload = notificationPayload;
        },
        updateAttendanceStatusLoader: async () => {},
        invalidateTrainerScheduleCachesLoader: async (trainerIds) => {
          invalidatedTrainerIds = trainerIds;
        },
      });

      assert.deepEqual(payload, {
        success: true,
        message: "Schedule deleted successfully",
      });
      assert.equal(deletedScheduleId, "SCH-DEL-2");
      assert.equal(emailArgs?.[0], "trainer.delete@example.com");
      assert.equal(emailArgs?.[3], "cancellation");
      assert.equal(emailArgs?.[4], "Batch completed");
      assert.equal(inAppPayload?.title, "Training Cancelled");
      assert.deepEqual(invalidatedTrainerIds, ["TRN-DEL-OLD"]);
    },
  },
  {
    name: "delete schedule feed keeps schedule-not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          deleteScheduleFeed({
            scheduleId: "SCH-DEL-MISSING",
            listScheduleById: async () => null,
          }),
        (error) => error?.statusCode === 404 && error?.message === "Schedule not found",
      );
    },
  },
  {
    name: "delete schedule feed keeps side-effect safety parity",
    run: async () => {
      let invalidatedTrainerIds = null;
      let deleteCalled = false;

      const payload = await deleteScheduleFeed({
        scheduleId: "SCH-DEL-3",
        payload: {},
        listScheduleById: async () => ({
          _id: "SCH-DEL-3",
          trainerId: "TRN-DEL-2",
          scheduledDate: "2026-04-26",
          startTime: "10:00",
          endTime: "12:00",
          dayNumber: 6,
          collegeId: "COL-DEL-2",
          courseId: "COURSE-DEL-2",
        }),
        deleteScheduleLoader: async () => {
          deleteCalled = true;
        },
        getTrainerByIdLoader: async () => ({
          userId: {
            _id: "USER-TRN-DEL-2",
            email: "trainer.del2@example.com",
            name: "Trainer Del 2",
          },
        }),
        getCollegeByIdLoader: async () => ({ name: "College Del 2" }),
        getCourseByIdLoader: async () => ({ title: "Course Del 2" }),
        sendScheduleChangeEmailLoader: async () => {
          throw new Error("smtp down");
        },
        updateAttendanceStatusLoader: async () => {},
        invalidateTrainerScheduleCachesLoader: async (trainerIds) => {
          invalidatedTrainerIds = trainerIds;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Schedule deleted successfully");
      assert.equal(deleteCalled, true);
      assert.deepEqual(invalidatedTrainerIds, ["TRN-DEL-2"]);
    },
  },
  {
    name: "schedule details feed preserves repository payload",
    run: async () => {
      const expected = {
        _id: "SCH-1001",
        status: "scheduled",
        verificationStatus: "pending",
        attendancePdfUrl: "attendance-day-1.pdf",
      };

      const schedule = await getScheduleDetailsFeed({
        scheduleId: "SCH-1001",
        scheduleLoader: async ({ scheduleId }) => ({
          ...expected,
          _id: scheduleId,
        }),
      });

      assert.deepEqual(schedule, expected);
    },
  },
  {
    name: "schedule details feed keeps invalid-id error parity",
    run: async () => {
      const castErrorMessage =
        'Cast to ObjectId failed for value "invalid-id" (type string) at path "_id" for model "Schedule"';

      await assert.rejects(
        () =>
          getScheduleDetailsFeed({
            scheduleId: "invalid-id",
            scheduleLoader: async () => {
              throw new Error(castErrorMessage);
            },
          }),
        (error) => error?.message === castErrorMessage,
      );
    },
  },
  {
    name: "schedule associations feed preserves shape and department sync parity",
    run: async () => {
      let didInsertDepartments = false;

      const payload = await listScheduleAssociationsFeed({
        listCompanies: async () => [
          { _id: "COMP-1", name: "Company One" },
        ],
        listCourses: async () => [
          { _id: "COURSE-1", title: "Course One", companyId: "COMP-1" },
        ],
        listColleges: async () => [
          {
            _id: "COL-1",
            name: "College One",
            companyId: "COMP-1",
            courseId: "COURSE-1",
            department: "CSE, IT",
          },
        ],
        listDepartments: async () => (
          didInsertDepartments
            ? [
              {
                _id: "DEP-1",
                name: "CSE",
                companyId: "COMP-1",
                courseId: "COURSE-1",
                collegeId: "COL-1",
              },
              {
                _id: "DEP-2",
                name: "IT",
                companyId: "COMP-1",
                courseId: "COURSE-1",
                collegeId: "COL-1",
              },
            ]
            : [
              {
                _id: "DEP-1",
                name: "CSE",
                companyId: "COMP-1",
                courseId: "COURSE-1",
                collegeId: "COL-1",
              },
            ]
        ),
        insertDepartments: async ({ departments }) => {
          didInsertDepartments = true;
          assert.equal(Array.isArray(departments), true);
          assert.equal(departments.length, 1);
          assert.equal(departments[0].name, "IT");
        },
      });

      assert.equal(payload.success, true);
      assert.deepEqual(payload.data.companies, [
        { id: "COMP-1", name: "Company One" },
      ]);
      assert.deepEqual(payload.data.courses, [
        { id: "COURSE-1", name: "Course One", companyId: "COMP-1" },
      ]);
      assert.deepEqual(payload.data.colleges, [
        { id: "COL-1", name: "College One", companyId: "COMP-1", courseId: "COURSE-1" },
      ]);
      assert.deepEqual(payload.data.departments, [
        { id: "DEP-1", name: "CSE", companyId: "COMP-1", courseId: "COURSE-1", collegeId: "COL-1" },
        { id: "DEP-2", name: "IT", companyId: "COMP-1", courseId: "COURSE-1", collegeId: "COL-1" },
      ]);
      assert.equal(didInsertDepartments, true);
    },
  },
  {
    name: "schedule associations feed keeps empty-state compatibility",
    run: async () => {
      const payload = await listScheduleAssociationsFeed({
        listCompanies: async () => [],
        listCourses: async () => [],
        listColleges: async () => [],
        listDepartments: async () => [],
        insertDepartments: async () => {
          throw new Error("insert should not be called for empty state");
        },
      });

      assert.equal(payload.success, true);
      assert.deepEqual(payload.data, {
        companies: [],
        courses: [],
        colleges: [],
        departments: [],
      });
    },
  },
  {
    name: "dashboard all schedules feed keeps legacy success/count/data shape",
    run: async () => {
      const schedules = [
        { _id: "SCH-A", startTime: "10:00", scheduledDate: "2026-04-03" },
        { _id: "SCH-B", startTime: "09:00", scheduledDate: "2026-04-02" },
      ];

      const payload = await listSchedulesFeed({
        query: {
          shouldPaginate: false,
          page: 1,
          limit: null,
        },
        user: null,
        listSchedulesLoader: async ({ filter, shouldPaginate }) => {
          assert.deepEqual(filter, {});
          assert.equal(shouldPaginate, false);
          return {
            schedules,
            total: schedules.length,
          };
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.count, 2);
      assert.deepEqual(payload.data, schedules);
    },
  },
  {
    name: "dashboard all schedules feed preserves repository ordering parity",
    run: async () => {
      const repositoryOrder = [
        { _id: "SCH-2", scheduledDate: "2026-04-04", startTime: "11:00" },
        { _id: "SCH-1", scheduledDate: "2026-04-04", startTime: "09:00" },
      ];

      const payload = await listSchedulesFeed({
        query: {
          shouldPaginate: false,
          page: 1,
          limit: null,
        },
        user: null,
        listSchedulesLoader: async () => ({
          schedules: repositoryOrder,
          total: repositoryOrder.length,
        }),
      });

      assert.deepEqual(payload.data, repositoryOrder);
      assert.equal(payload.count, repositoryOrder.length);
    },
  },
  {
    name: "dashboard live feed keeps legacy liveStatus mapping parity",
    run: async () => {
      const schedules = [
        { _id: "SCH-LIVE-1", startTime: "09:00" },
        { _id: "SCH-LIVE-2", startTime: "10:00" },
      ];

      const payload = await listLiveDashboardFeed({
        user: null,
        listLiveDashboardSchedulesLoader: async ({ filter }) => {
          assert.ok(filter.scheduledDate?.$gte instanceof Date);
          assert.ok(filter.scheduledDate?.$lte instanceof Date);
          assert.deepEqual(filter.status, { $ne: "cancelled" });
          return schedules;
        },
        listLatestAttendanceLoader: async ({ scheduleIds }) => {
          assert.deepEqual(scheduleIds, ["SCH-LIVE-1", "SCH-LIVE-2"]);
          return [
            {
              scheduleId: "SCH-LIVE-1",
              status: "Present",
              checkInTime: "09:03",
              checkOutTime: "16:45",
              location: { lat: 11.11, lng: 77.77 },
              geoVerificationStatus: "approved",
              verificationStatus: "approved",
              updatedAt: "2026-04-04T10:00:00.000Z",
            },
            {
              // Should be ignored because first hit per schedule wins.
              scheduleId: "SCH-LIVE-1",
              status: "Absent",
              checkInTime: "09:15",
              updatedAt: "2026-04-04T09:00:00.000Z",
            },
          ];
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.count, 2);
      assert.deepEqual(payload.data[0], {
        _id: "SCH-LIVE-1",
        startTime: "09:00",
        liveStatus: {
          status: "Present",
          checkInTime: "09:03",
          checkOutTime: "16:45",
          location: { lat: 11.11, lng: 77.77 },
          geoStatus: "approved",
          verificationStatus: "approved",
          lastUpdateAt: "2026-04-04T10:00:00.000Z",
        },
      });
      assert.equal(payload.data[1].liveStatus, null);
    },
  },
  {
    name: "dashboard live feed keeps empty-state compatibility",
    run: async () => {
      const payload = await listLiveDashboardFeed({
        user: null,
        listLiveDashboardSchedulesLoader: async () => [],
        listLatestAttendanceLoader: async ({ scheduleIds }) => {
          assert.deepEqual(scheduleIds, []);
          return [];
        },
      });

      assert.deepEqual(payload, {
        success: true,
        count: 0,
        data: [],
      });
    },
  },
  {
    name: "dashboard trainer schedules feed keeps shape/order/merge parity",
    run: async () => {
      let setCacheCall = null;

      const payload = await listTrainerSchedulesFeed({
        trainerId: "TRN-42",
        month: 4,
        year: 2026,
        status: "scheduled",
        resolveTrainerScheduleFilterContextLoader: async ({ trainerIdentifier }) => {
          assert.equal(trainerIdentifier, "TRN-42");
          return {
            cacheTrainerId: "TRN-42",
            filterTrainerIds: ["TRN-42"],
          };
        },
        getCachedTrainerScheduleResponseLoader: async (cacheParams) => {
          assert.deepEqual(cacheParams, {
            trainerId: "TRN-42",
            month: 4,
            year: 2026,
            status: "scheduled",
          });
          return null;
        },
        listTrainerSchedulesLoader: async ({ filter }) => {
          assert.equal(filter.trainerId, "TRN-42");
          assert.equal(filter.status, "scheduled");
          assert.ok(filter.scheduledDate?.$gte instanceof Date);
          assert.ok(filter.scheduledDate?.$lt instanceof Date);

          return [
            {
              _id: "SCH-TD-2",
              status: "ASSIGNED",
              dayNumber: 2,
              trainerId: "TRN-42",
              scheduledDate: "2026-04-02T00:00:00.000Z",
              startTime: "09:00",
            },
            {
              _id: "SCH-TD-1",
              status: "scheduled",
              dayNumber: 1,
              trainerId: "TRN-42",
              scheduledDate: "2026-04-01T00:00:00.000Z",
              startTime: "09:00",
            },
          ];
        },
        listTrainerAttendanceDocsLoader: async ({ scheduleIds }) => {
          assert.deepEqual(scheduleIds, ["SCH-TD-2", "SCH-TD-1"]);
          return [
            {
              scheduleId: "SCH-TD-1",
              verificationStatus: "approved",
              geoVerificationStatus: "approved",
              assignedDate: "2026-04-01",
              images: ["proof-1.jpg"],
              createdAt: "2026-04-01T10:00:00.000Z",
            },
          ];
        },
        setCachedTrainerScheduleResponseLoader: async (cacheParams, responsePayload) => {
          setCacheCall = { cacheParams, responsePayload };
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.count, 2);
      assert.ok(Array.isArray(payload.data));
      assert.deepEqual(payload.data.map((row) => row._id), ["SCH-TD-2", "SCH-TD-1"]);

      assert.equal(payload.data[0].status, "scheduled");
      assert.equal(payload.data[0].rawStatus, "ASSIGNED");
      assert.equal(payload.data[0].assignedDate, null);

      assert.equal(payload.data[1].status, "COMPLETED");
      assert.equal(payload.data[1].rawStatus, "scheduled");
      assert.equal(payload.data[1].assignedDate, "2026-04-01");
      assert.deepEqual(payload.data[1].images, ["proof-1.jpg"]);

      assert.deepEqual(setCacheCall?.cacheParams, {
        trainerId: "TRN-42",
        month: 4,
        year: 2026,
        status: "scheduled",
      });
      assert.equal(setCacheCall?.responsePayload?.success, true);
      assert.equal(setCacheCall?.responsePayload?.count, 2);
    },
  },
  {
    name: "dashboard trainer schedules feed keeps empty-state compatibility",
    run: async () => {
      let cacheTouched = false;
      const payload = await listTrainerSchedulesFeed({
        trainerId: "missing-trainer",
        resolveTrainerScheduleFilterContextLoader: async () => ({
          cacheTrainerId: "",
          filterTrainerIds: [],
        }),
        getCachedTrainerScheduleResponseLoader: async () => {
          cacheTouched = true;
          return null;
        },
      });

      assert.equal(cacheTouched, false);
      assert.deepEqual(payload, {
        success: true,
        count: 0,
        data: [],
      });
    },
  },
  {
    name: "dashboard trainer schedules feed keeps cache-hit parity",
    run: async () => {
      let schedulesLoaderCalled = false;
      let attendanceLoaderCalled = false;
      let setCacheCalled = false;
      const cachedPayload = {
        success: true,
        count: 1,
        data: [{ _id: "SCH-CACHED-1", status: "COMPLETED" }],
      };

      const payload = await listTrainerSchedulesFeed({
        trainerId: "TRN-CACHE",
        resolveTrainerScheduleFilterContextLoader: async () => ({
          cacheTrainerId: "TRN-CACHE",
          filterTrainerIds: ["TRN-CACHE"],
        }),
        getCachedTrainerScheduleResponseLoader: async () => cachedPayload,
        listTrainerSchedulesLoader: async () => {
          schedulesLoaderCalled = true;
          return [];
        },
        listTrainerAttendanceDocsLoader: async () => {
          attendanceLoaderCalled = true;
          return [];
        },
        setCachedTrainerScheduleResponseLoader: async () => {
          setCacheCalled = true;
        },
      });

      assert.deepEqual(payload, cachedPayload);
      assert.equal(schedulesLoaderCalled, false);
      assert.equal(attendanceLoaderCalled, false);
      assert.equal(setCacheCalled, false);
    },
  },
  {
    name: "dashboard trainer bundle keeps trainer schedule key compatibility",
    run: () => {
      const dashboardRoutesPath = path.resolve(
        process.cwd(),
        "routes",
        "dashboardDataRoutes.js",
      );
      const source = fs.readFileSync(dashboardRoutesPath, "utf8");

      assert.match(
        source,
        /const currentMonthKey = `\/schedules\/trainer\/\$\{trainerId\}\?month=\$\{/,
      );
      assert.match(
        source,
        /const previousMonthKey = `\/schedules\/trainer\/\$\{trainerId\}\?month=\$\{/,
      );
      assert.match(
        source,
        /const allSchedulesKey = `\/schedules\/trainer\/\$\{trainerId\}`;/,
      );
    },
  },
  {
    name: "trainer schedule payload merges latest attendance per schedule",
    run: () => {
      const payload = buildTrainerSchedulesPayload({
        schedules: [
          { _id: "SCH-T-1", status: "scheduled", dayNumber: 1, trainerId: "TR-1" },
        ],
        attendanceDocs: [
          {
            scheduleId: "SCH-T-1",
            createdAt: "2026-04-02T10:00:00.000Z",
            status: "Present",
            verificationStatus: "approved",
            geoVerificationStatus: "approved",
            assignedDate: "2026-04-02",
            images: ["newer-image.jpg"],
          },
          {
            scheduleId: "SCH-T-1",
            createdAt: "2026-04-01T10:00:00.000Z",
            verificationStatus: "pending",
            geoVerificationStatus: "pending",
            assignedDate: "2026-04-01",
            images: ["older-image.jpg"],
          },
        ],
      });

      assert.equal(payload.length, 1);
      assert.equal(payload[0].assignedDate, "2026-04-02");
      assert.deepEqual(payload[0].images, ["newer-image.jpg"]);
      assert.equal(payload[0].attendanceStatus, "approved");
      assert.equal(payload[0].attendancePresenceStatus, "Present");
      assert.equal(payload[0].geoVerificationStatus, "approved");
      assert.equal(payload[0].status, "COMPLETED");
      assert.equal(payload[0].isActionable, true);
    },
  },
  {
    name: "trainer schedule payload derives status parity rules",
    run: () => {
      const payload = buildTrainerSchedulesPayload({
        schedules: [
          { _id: "SCH-T-2", status: "scheduled", dayNumber: 1, trainerId: "TR-2" },
          { _id: "SCH-T-3", status: "completed", dayNumber: 2, trainerId: "TR-3" },
          { _id: "SCH-T-4", status: "ASSIGNED", dayNumber: 3, trainerId: "TR-4" },
        ],
        attendanceDocs: [
          {
            scheduleId: "SCH-T-2",
            verificationStatus: "approved",
            geoVerificationStatus: "pending",
          },
          {
            scheduleId: "SCH-T-3",
            verificationStatus: "pending",
            geoVerificationStatus: "approved",
          },
        ],
      });

      assert.equal(payload[0].status, "inprogress");
      assert.equal(payload[1].status, "scheduled");
      assert.equal(payload[2].status, "scheduled");
      assert.equal(payload[0].isActionable, true);
      assert.equal(payload[1].isActionable, false);
      assert.equal(payload[2].isActionable, true);
      assert.equal(payload[0].rawStatus, "scheduled");
      assert.equal(payload[1].rawStatus, "completed");
      assert.equal(payload[2].rawStatus, "ASSIGNED");
    },
  },
  {
    name: "trainer schedule payload keeps compatibility defaults without attendance",
    run: () => {
      const payload = buildTrainerSchedulesPayload({
        schedules: [
          { _id: "SCH-T-5", status: "scheduled", dayNumber: 1, trainerId: "TR-5" },
        ],
        attendanceDocs: [],
      });

      assert.equal(payload.length, 1);
      assert.equal(payload[0].assignedDate, null);
      assert.deepEqual(payload[0].images, []);
      assert.equal(payload[0].finalStatus, null);
      assert.equal(payload[0].attendanceStatus, null);
      assert.equal(payload[0].attendancePresenceStatus, null);
      assert.equal(payload[0].geoVerificationStatus, null);
      assert.equal(payload[0].verificationComment, null);
      assert.equal(payload[0].geoValidationComment, null);
      assert.equal(payload[0].checkOut, null);
      assert.equal(payload[0].isActionable, true);
      assert.equal(typeof payload[0].dayStatusLabel, "string");
    },
  },
  {
    name: "trainer schedule payload marks cancelled attendance sessions non-actionable",
    run: () => {
      const payload = buildTrainerSchedulesPayload({
        schedules: [
          { _id: "SCH-T-CAN-1", status: "inprogress", dayNumber: 6, trainerId: "TR-6" },
        ],
        attendanceDocs: [
          {
            scheduleId: "SCH-T-CAN-1",
            status: "cancelled",
            verificationStatus: "approved",
            geoVerificationStatus: "pending",
          },
        ],
      });

      assert.equal(payload.length, 1);
      assert.equal(payload[0].isActionable, false);
      assert.equal(payload[0].attendancePresenceStatus, "cancelled");
    },
  },
  {
    name: "documents my-documents feed preserves trainer-not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          listMyDocumentsFeed({
            userId: "USER-MISSING",
            findTrainerByUserIdLoader: async () => null,
          }),
        (error) =>
          error?.statusCode === 404
          && error?.message === "Trainer profile not found",
      );
    },
  },
  {
    name: "documents my-documents feed preserves response shape and sort-order parity",
    run: async () => {
      const payload = await listMyDocumentsFeed({
        userId: "USER-1001",
        findTrainerByUserIdLoader: async ({ userId }) => {
          assert.equal(userId, "USER-1001");
          return { _id: "TRN-1001" };
        },
        listTrainerDocumentsLoader: async ({ trainerId }) => {
          assert.equal(trainerId, "TRN-1001");
          return [
            {
              _id: "DOC-NEW",
              documentType: "NDAAgreement",
              createdAt: "2026-04-04T10:00:00.000Z",
            },
            {
              _id: "DOC-OLD",
              documentType: "resume",
              createdAt: "2026-04-03T10:00:00.000Z",
            },
          ];
        },
      });

      assert.equal(payload.success, true);
      assert.deepEqual(
        payload.data.map((document) => document._id),
        ["DOC-NEW", "DOC-OLD"],
      );
      assert.equal(payload.data[0].documentType, "ndaAgreement");
      assert.equal(payload.data[1].documentType, "resume");
    },
  },
  {
    name: "documents trainer/:trainerId feed preserves invalid-id parity",
    run: async () => {
      await assert.rejects(
        () =>
          listTrainerDocumentsFeed({
            trainerId: "invalid-id",
          }),
        (error) =>
          error?.statusCode === 400
          && error?.message === "Invalid trainer ID",
      );
    },
  },
  {
    name: "documents trainer/:trainerId feed preserves NDA backfill parity",
    run: async () => {
      let upsertPayload = null;
      const payload = await listTrainerDocumentsFeed({
        trainerId: "507f1f77bcf86cd799439011",
        findTrainerForNdaBackfillLoader: async () => ({
          documents: {},
          ndaAgreementPdf: "legacy/nda-form.pdf",
        }),
        upsertLegacyNdaDocumentLoader: async (context) => {
          upsertPayload = context;
        },
        listTrainerDocumentsLoader: async ({ trainerId }) => {
          assert.equal(trainerId, "507f1f77bcf86cd799439011");
          return [
            { _id: "DOC-NDA", documentType: "ntaAgreement" },
          ];
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.data.length, 1);
      assert.equal(payload.data[0].documentType, "ndaAgreement");
      assert.deepEqual(upsertPayload, {
        trainerId: "507f1f77bcf86cd799439011",
        documentTypeCandidates: ["ndaAgreement", "ntaAgreement", "NDAAgreement"],
        setOnInsert: {
          fileName: "nda-form.pdf",
          filePath: "/legacy/nda-form.pdf",
          mimeType: "application/pdf",
          verificationStatus: "PENDING",
          verificationComment: null,
          verifiedAt: null,
          verifiedBy: null,
        },
      });
    },
  },
  {
    name: "documents trainer/:trainerId feed preserves empty-state parity",
    run: async () => {
      let upsertCalled = false;
      const payload = await listTrainerDocumentsFeed({
        trainerId: "507f1f77bcf86cd799439012",
        findTrainerForNdaBackfillLoader: async () => null,
        upsertLegacyNdaDocumentLoader: async () => {
          upsertCalled = true;
        },
        listTrainerDocumentsLoader: async () => [],
      });

      assert.equal(payload.success, true);
      assert.deepEqual(payload.data, []);
      assert.equal(upsertCalled, false);
    },
  },
  {
    name: "documents verify feed preserves invalid-id parity",
    run: async () => {
      await assert.rejects(
        () =>
          verifyDocumentFeed({
            documentId: "invalid-id",
            payload: { verificationStatus: "APPROVED" },
            actorUserId: "USER-ADMIN-1",
          }),
        (error) =>
          error?.statusCode === 400
          && error?.message === "Invalid document ID",
      );
    },
  },
  {
    name: "documents verify feed preserves invalid-status parity",
    run: async () => {
      await assert.rejects(
        () =>
          verifyDocumentFeed({
            documentId: "507f1f77bcf86cd799439014",
            payload: { verificationStatus: "PENDING" },
            actorUserId: "USER-ADMIN-1",
          }),
        (error) =>
          error?.statusCode === 400
          && error?.message === "Invalid verification status",
      );
    },
  },
  {
    name: "documents verify feed preserves not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          verifyDocumentFeed({
            documentId: "507f1f77bcf86cd799439015",
            payload: { verificationStatus: "APPROVED" },
            actorUserId: "USER-ADMIN-2",
            getDocumentByIdLoader: async () => null,
          }),
        (error) =>
          error?.statusCode === 404
          && error?.message === "Document not found",
      );
    },
  },
  {
    name: "documents verify feed preserves approved transition and trainer-side effects parity",
    run: async () => {
      let documentSaved = false;
      let trainerSaved = false;
      let profilePictureUpdatePayload = null;
      let rejectionEmailSent = false;

      const document = {
        _id: "DOC-APPROVE-1",
        documentType: "passportPhoto",
        filePath: "/uploads/passport.jpg",
        trainerId: {
          _id: "TRN-APPROVE-1",
          userId: {
            _id: "USER-TRN-APPROVE-1",
            name: "Trainer Approved",
            email: "trainer.approved@example.com",
            role: "Trainer",
          },
        },
        toObject() {
          return {
            _id: this._id,
            documentType: this.documentType,
            filePath: this.filePath,
            trainerId: this.trainerId,
            verificationStatus: this.verificationStatus,
            verificationComment: this.verificationComment,
            verifiedBy: this.verifiedBy,
            verifiedAt: this.verifiedAt,
          };
        },
      };

      const trainer = {
        _id: "TRN-APPROVE-1",
        userId: "USER-TRN-APPROVE-1",
        documents: {},
        profilePicture: null,
      };

      const payload = await verifyDocumentFeed({
        documentId: "507f1f77bcf86cd799439016",
        payload: {
          verificationStatus: "APPROVED",
          verificationComment: "Looks good",
        },
        actorUserId: "USER-ADMIN-3",
        getDocumentByIdLoader: async () => document,
        getTrainerByIdLoader: async () => trainer,
        listTrainerDocumentsLoader: async () => [document],
        saveDocumentLoader: async () => {
          documentSaved = true;
          return document;
        },
        saveTrainerLoader: async () => {
          trainerSaved = true;
          return trainer;
        },
        updateUserProfilePictureLoader: async (context) => {
          profilePictureUpdatePayload = context;
        },
        syncTrainerDocumentWorkflowLoader: () => ({ documentStatus: "pending_review" }),
        sendDocumentRejectionEmailLoader: async () => {
          rejectionEmailSent = true;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Document verification updated");
      assert.equal(payload.data.removed, false);
      assert.equal(payload.data.cleanupWarning, null);
      assert.deepEqual(payload.data.workflow, { documentStatus: "pending_review" });
      assert.equal(payload.data.verificationStatus, "APPROVED");
      assert.equal(documentSaved, true);
      assert.equal(trainerSaved, true);
      assert.deepEqual(profilePictureUpdatePayload, {
        userId: "USER-TRN-APPROVE-1",
        profilePicture: "/uploads/passport.jpg",
      });
      assert.equal(rejectionEmailSent, false);
    },
  },
  {
    name: "documents verify feed preserves rejection comments and side-effect safety parity",
    run: async () => {
      let trainerSaved = false;
      let documentDeleted = false;
      let resetCalled = false;
      let profilePictureResetPayload = null;

      const document = {
        _id: "DOC-REJECT-1",
        documentType: "selfiePhoto",
        filePath: "/uploads/selfie.jpg",
        driveFileId: "DRV-REJECT-1",
        trainerId: {
          _id: "TRN-REJECT-1",
          userId: {
            _id: "USER-TRN-REJECT-1",
            name: "Trainer Reject",
            email: "trainer.reject@example.com",
            role: "Trainer",
          },
        },
        toObject() {
          return {
            _id: this._id,
            documentType: this.documentType,
            filePath: this.filePath,
            driveFileId: this.driveFileId,
            trainerId: this.trainerId,
          };
        },
      };

      const trainer = {
        _id: "TRN-REJECT-1",
        userId: "USER-TRN-REJECT-1",
        documents: {
          selfiePhoto: "/uploads/selfie.jpg",
          passportPhoto: "/uploads/passport.jpg",
          verification: new Map(),
        },
        profilePicture: "/uploads/selfie.jpg",
      };

      const payload = await verifyDocumentFeed({
        documentId: "507f1f77bcf86cd799439017",
        payload: {
          verificationStatus: "REJECTED",
          verificationComment: "Image is unclear",
        },
        actorUserId: "USER-ADMIN-4",
        getDocumentByIdLoader: async () => document,
        getTrainerByIdLoader: async () => trainer,
        listTrainerDocumentsExcludingLoader: async () => [],
        saveTrainerLoader: async () => {
          trainerSaved = true;
          return trainer;
        },
        deleteDocumentLoader: async () => {
          documentDeleted = true;
        },
        resetTrainerSubmissionProgressLoader: async () => {
          resetCalled = true;
          trainer.registrationStatus = "pending";
        },
        updateUserProfilePictureLoader: async (context) => {
          profilePictureResetPayload = context;
        },
        syncTrainerDocumentWorkflowLoader: () => ({ documentStatus: "needs_resubmission" }),
        deleteDriveFileLoader: async () => {
          throw new Error("drive cleanup failed");
        },
        sendDocumentRejectionEmailLoader: async () => {
          throw new Error("smtp down");
        },
      });

      assert.equal(payload.success, true);
      assert.equal(
        payload.message,
        "Document rejected. Trainer can re-upload, but the previous Drive file could not be deleted automatically.",
      );
      assert.equal(payload.data.removed, true);
      assert.equal(payload.data.cleanupWarning, "drive cleanup failed");
      assert.equal(payload.data.verificationComment, "Image is unclear");
      assert.deepEqual(payload.data.workflow, { documentStatus: "needs_resubmission" });
      assert.equal(trainerSaved, true);
      assert.equal(documentDeleted, true);
      assert.equal(resetCalled, true);
      assert.deepEqual(profilePictureResetPayload, {
        userId: "USER-TRN-REJECT-1",
        profilePicture: "/uploads/passport.jpg",
      });
    },
  },
  {
    name: "documents trainer status feed preserves invalid-trainer-id parity",
    run: async () => {
      await assert.rejects(
        () =>
          updateTrainerStatusFeed({
            trainerId: "invalid-id",
            payload: { status: "APPROVED" },
          }),
        (error) =>
          error?.statusCode === 400
          && error?.message === "Invalid trainer ID",
      );
    },
  },
  {
    name: "documents trainer status feed preserves invalid-status parity",
    run: async () => {
      await assert.rejects(
        () =>
          updateTrainerStatusFeed({
            trainerId: "507f1f77bcf86cd799439040",
            payload: { status: "INVALID" },
          }),
        (error) =>
          error?.statusCode === 400
          && error?.message === "Invalid status",
      );
    },
  },
  {
    name: "documents trainer status feed preserves review-gate parity",
    run: async () => {
      await assert.rejects(
        () =>
          updateTrainerStatusFeed({
            trainerId: "507f1f77bcf86cd799439041",
            payload: { status: "APPROVED" },
            getTrainerByIdWithUserLoader: async () => ({
              _id: "TRN-REVIEW-1",
              agreementAccepted: false,
              agreemeNDAccepted: false,
              signature: null,
              passwordHash: null,
              userId: { _id: "USER-REVIEW-1", role: "Trainer" },
            }),
          }),
        (error) =>
          error?.statusCode === 400
          && error?.message === "Trainer must complete Agreement before admin review"
          && error?.data?.nextStep === 4
          && error?.data?.nextStepLabel === "Agreement",
      );
    },
  },
  {
    name: "documents trainer status feed preserves rejected transition, profile rejection messaging, and notification safety parity",
    run: async () => {
      let trainerSaved = false;
      let resetCalled = false;
      let profileRejectionEmailCalls = 0;
      let inAppNotificationCalls = 0;

      const trainer = {
        _id: "TRN-STATUS-REJECT-1",
        status: "PENDING",
        verificationStatus: "PENDING",
        documentStatus: "under_review",
        registrationStatus: "under_review",
        documents: {
          aadharFront: "/uploads/aadhar-front.jpg",
          verification: new Map(),
        },
        userId: {
          _id: "USER-STATUS-REJECT-1",
          name: "Trainer Rejected",
          email: "trainer.rejected@example.com",
          role: "Trainer",
        },
      };

      const payload = await updateTrainerStatusFeed({
        trainerId: "507f1f77bcf86cd799439042",
        payload: {
          status: "REJECTED",
          reason: "Document mismatch",
        },
        getTrainerByIdWithUserLoader: async () => trainer,
        resetTrainerSubmissionProgressLoader: async () => {
          resetCalled = true;
        },
        saveTrainerLoader: async () => {
          trainerSaved = true;
          return trainer;
        },
        sendProfileRejectionEmailLoader: async () => {
          profileRejectionEmailCalls += 1;
          throw new Error("smtp down");
        },
        createInAppNotificationLoader: async () => {
          inAppNotificationCalls += 1;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Trainer profile REJECTED successfully");
      assert.deepEqual(payload.data, {
        verificationStatus: "REJECTED",
        documentStatus: "rejected",
      });
      assert.equal(trainerSaved, true);
      assert.equal(resetCalled, true);
      assert.equal(profileRejectionEmailCalls, 1);
      assert.equal(inAppNotificationCalls, 0);
      assert.equal(
        trainer.documents.verification.get("aadharFront")?.reason,
        "Document mismatch",
      );
    },
  },
  {
    name: "documents trainer status feed preserves approved transition and approval side-effects parity",
    run: async () => {
      let trainerSaved = false;
      let passwordUpdatePayload = null;
      let activationPayload = null;
      let approvalEmailPayload = null;
      let inAppNotificationPayload = null;

      const trainer = {
        _id: "TRN-STATUS-APPROVE-1",
        trainerId: "MBK301",
        status: "PENDING",
        verificationStatus: "PENDING",
        documentStatus: "under_review",
        agreementAccepted: true,
        signature: "signed",
        passwordHash: "existing-hash",
        documents: {},
        userId: {
          _id: "USER-STATUS-APPROVE-1",
          name: "Trainer Approved",
          email: "trainer.approved@example.com",
          role: "Trainer",
        },
      };

      const payload = await updateTrainerStatusFeed({
        trainerId: "507f1f77bcf86cd799439043",
        payload: { status: "APPROVED" },
        getTrainerByIdWithUserLoader: async () => trainer,
        getUserByIdWithPlainPasswordLoader: async () => ({ plainPassword: null }),
        hashPasswordLoader: async (plainPassword, rounds) => {
          assert.equal(rounds, 10);
          assert.equal(typeof plainPassword, "string");
          assert.equal(plainPassword.length, 10);
          return "hashed-password";
        },
        updateUserPasswordLoader: async (context) => {
          passwordUpdatePayload = context;
        },
        activateUserLoader: async (context) => {
          activationPayload = context;
        },
        sendTrainerApprovalEmailLoader: async (...args) => {
          approvalEmailPayload = args;
        },
        createInAppNotificationLoader: async (context) => {
          inAppNotificationPayload = context;
        },
        saveTrainerLoader: async () => {
          trainerSaved = true;
          return trainer;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Trainer profile APPROVED successfully");
      assert.deepEqual(payload.data, {
        verificationStatus: "VERIFIED",
        documentStatus: "approved",
      });
      assert.equal(trainerSaved, true);
      assert.equal(passwordUpdatePayload.userId, "USER-STATUS-APPROVE-1");
      assert.equal(passwordUpdatePayload.password, "hashed-password");
      assert.equal(passwordUpdatePayload.plainPassword.length, 10);
      assert.deepEqual(activationPayload, { userId: "USER-STATUS-APPROVE-1" });
      assert.equal(approvalEmailPayload[0], "trainer.approved@example.com");
      assert.equal(approvalEmailPayload[1], "Trainer Approved");
      assert.equal(
        String(approvalEmailPayload[2] || "").endsWith("/login/trainer"),
        true,
      );
      assert.equal(approvalEmailPayload[3], "MBK301");
      assert.equal(typeof approvalEmailPayload[4], "string");
      assert.equal(inAppNotificationPayload.userId, "USER-STATUS-APPROVE-1");
      assert.equal(inAppNotificationPayload.link, "/trainer/profile");
    },
  },
  {
    name: "documents trainer approach feed preserves access-control parity",
    run: async () => {
      await assert.rejects(
        () =>
          approachTrainerDocumentsFeed({
            trainerId: "507f1f77bcf86cd799439044",
            actorUserId: "USER-TRAINER-1",
            actorRole: "Trainer",
          }),
        (error) =>
          error?.statusCode === 403
          && error?.message === "Access denied",
      );
    },
  },
  {
    name: "documents trainer approach feed preserves invalid trainer-id parity",
    run: async () => {
      await assert.rejects(
        () =>
          approachTrainerDocumentsFeed({
            trainerId: "invalid-id",
            actorUserId: "USER-ADMIN-1",
            actorRole: "Admin",
          }),
        (error) =>
          error?.statusCode === 400
          && error?.message === "Invalid trainer ID",
      );
    },
  },
  {
    name: "documents trainer approach feed preserves no-outstanding-documents parity",
    run: async () => {
      const trainer = {
        _id: "TRN-APPROACH-1",
        userId: {
          _id: "USER-APPROACH-1",
          name: "Trainer One",
          email: "trainer.one@example.com",
        },
      };

      await assert.rejects(
        () =>
          approachTrainerDocumentsFeed({
            trainerId: "507f1f77bcf86cd799439045",
            actorUserId: "USER-ADMIN-2",
            actorRole: "SuperAdmin",
            findTrainerByIdWithUserLoader: async () => trainer,
            listTrainerDocumentsLoader: async () => [],
            syncTrainerDocumentWorkflowLoader: () => ({
              missingDocuments: [],
              rejectedDocuments: [],
              documentStatus: "under_review",
              uploadedCount: 8,
              approvedCount: 8,
              pendingReviewCount: 0,
              requiredCount: 8,
              documentProgress: {},
              checklist: [],
              hasAllRequiredDocuments: true,
              allRequiredDocumentsApproved: true,
              canProceedToAgreement: true,
            }),
            saveTrainerLoader: async () => trainer,
          }),
        (error) =>
          error?.statusCode === 400
          && error?.message === "This trainer has no missing or rejected documents.",
      );
    },
  },
  {
    name: "documents trainer approach feed preserves response shape and reminder side-effect parity",
    run: async () => {
      const trainer = {
        _id: "TRN-APPROACH-2",
        userId: {
          _id: "USER-APPROACH-2",
          name: "Trainer Two",
          email: "trainer.two@example.com",
        },
      };

      let saveCount = 0;
      let reminderPayload = null;

      const finalWorkflow = {
        documentStatus: "rejected",
        uploadedCount: 7,
        approvedCount: 5,
        pendingReviewCount: 0,
        requiredCount: 8,
        documentProgress: {
          aadharFront: { status: "rejected", rejectionReason: "blurred" },
        },
        checklist: [{ key: "aadharFront", label: "Aadhaar Front", isRejected: true }],
        missingDocuments: [],
        rejectedDocuments: [{ key: "aadharFront", label: "Aadhaar Front" }],
        hasAllRequiredDocuments: true,
        allRequiredDocumentsApproved: false,
        canProceedToAgreement: false,
      };

      const payload = await approachTrainerDocumentsFeed({
        trainerId: "507f1f77bcf86cd799439046",
        actorUserId: "USER-ADMIN-3",
        actorRole: "Admin",
        findTrainerByIdWithUserLoader: async () => trainer,
        listTrainerDocumentsLoader: async () => [{ _id: "DOC-1" }],
        syncTrainerDocumentWorkflowLoader: () => ({
          ...finalWorkflow,
          missingDocuments: [],
          rejectedDocuments: [{ key: "aadharFront", label: "Aadhaar Front" }],
        }),
        evaluateTrainerDocumentWorkflowLoader: () => finalWorkflow,
        saveTrainerLoader: async () => {
          saveCount += 1;
          return trainer;
        },
        sendTrainerDocumentReminderEmailLoader: async (context) => {
          reminderPayload = context;
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Reminder email sent to trainer successfully");
      assert.equal(payload.data.documentStatus, "rejected");
      assert.equal(payload.data.documentSummary.uploadedCount, 7);
      assert.equal(payload.data.documentSummary.requiredCount, 8);
      assert.equal(payload.data.documentChecklist.length, 1);
      assert.equal(payload.data.rejectedDocuments.length, 1);
      assert.ok(payload.data.lastApproachedAt);
      assert.equal(saveCount, 2);
      assert.deepEqual(reminderPayload, {
        trainerEmail: "trainer.two@example.com",
        trainerName: "Trainer Two",
        missingDocuments: ["Aadhaar Front"],
        loginUrl: `${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/profile`,
      });
    },
  },
  {
    name: "documents trainer approach feed preserves reminder-failure parity",
    run: async () => {
      const trainer = {
        _id: "TRN-APPROACH-3",
        userId: {
          _id: "USER-APPROACH-3",
          name: "Trainer Three",
          email: "trainer.three@example.com",
        },
      };

      await assert.rejects(
        () =>
          approachTrainerDocumentsFeed({
            trainerId: "507f1f77bcf86cd799439047",
            actorUserId: "USER-ADMIN-4",
            actorRole: "SuperAdmin",
            findTrainerByIdWithUserLoader: async () => trainer,
            listTrainerDocumentsLoader: async () => [],
            syncTrainerDocumentWorkflowLoader: () => ({
              missingDocuments: [{ key: "resumePdf", label: "Resume" }],
              rejectedDocuments: [],
              documentStatus: "pending",
              uploadedCount: 7,
              approvedCount: 7,
              pendingReviewCount: 0,
              requiredCount: 8,
              documentProgress: {},
              checklist: [],
              hasAllRequiredDocuments: false,
              allRequiredDocumentsApproved: false,
              canProceedToAgreement: false,
            }),
            evaluateTrainerDocumentWorkflowLoader: () => ({
              missingDocuments: [{ key: "resumePdf", label: "Resume" }],
              rejectedDocuments: [],
              documentStatus: "pending",
              uploadedCount: 7,
              approvedCount: 7,
              pendingReviewCount: 0,
              requiredCount: 8,
              documentProgress: {},
              checklist: [],
              hasAllRequiredDocuments: false,
              allRequiredDocumentsApproved: false,
              canProceedToAgreement: false,
            }),
            saveTrainerLoader: async () => trainer,
            sendTrainerDocumentReminderEmailLoader: async () => {
              throw new Error("smtp down");
            },
          }),
        (error) => error?.message === "smtp down",
      );
    },
  },
  {
    name: "documents move-to-review feed preserves access-control parity",
    run: async () => {
      await assert.rejects(
        () =>
          moveTrainerToReviewFeed({
            trainerId: "507f1f77bcf86cd799439048",
            actorRole: "Trainer",
          }),
        (error) => error?.statusCode === 403 && error?.message === "Access denied",
      );
    },
  },
  {
    name: "documents move-to-review feed preserves invalid-trainer-id parity",
    run: async () => {
      await assert.rejects(
        () =>
          moveTrainerToReviewFeed({
            trainerId: "invalid-id",
            actorRole: "Admin",
          }),
        (error) => error?.statusCode === 400 && error?.message === "Invalid trainer ID",
      );
    },
  },
  {
    name: "documents move-to-review feed preserves trainer-not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          moveTrainerToReviewFeed({
            trainerId: "507f1f77bcf86cd799439049",
            actorRole: "Admin",
            findTrainerByIdWithUserLoader: async () => null,
          }),
        (error) => error?.statusCode === 404 && error?.message === "Trainer not found",
      );
    },
  },
  {
    name: "documents move-to-review feed preserves missing-documents invalid-state parity",
    run: async () => {
      const trainer = { _id: "TRN-MOVE-1", userId: { _id: "USER-MOVE-1" } };

      await assert.rejects(
        () =>
          moveTrainerToReviewFeed({
            trainerId: "507f1f77bcf86cd799439050",
            actorRole: "SuperAdmin",
            findTrainerByIdWithUserLoader: async () => trainer,
            listTrainerDocumentsLoader: async () => [],
            evaluateTrainerDocumentWorkflowLoader: () => ({
              hasAllRequiredDocuments: false,
              hasRejectedDocuments: false,
              missingDocuments: [{ key: "pan", label: "PAN Card" }],
              rejectedDocuments: [],
            }),
          }),
        (error) =>
          error?.statusCode === 400 &&
          error?.message === "Trainer is still missing required documents" &&
          error?.data?.missingDocuments?.length === 1,
      );
    },
  },
  {
    name: "documents move-to-review feed preserves rejected-documents invalid-state parity",
    run: async () => {
      const trainer = { _id: "TRN-MOVE-2", userId: { _id: "USER-MOVE-2" } };

      await assert.rejects(
        () =>
          moveTrainerToReviewFeed({
            trainerId: "507f1f77bcf86cd799439051",
            actorRole: "Admin",
            findTrainerByIdWithUserLoader: async () => trainer,
            listTrainerDocumentsLoader: async () => [{ _id: "DOC-MOVE-1" }],
            evaluateTrainerDocumentWorkflowLoader: () => ({
              hasAllRequiredDocuments: true,
              hasRejectedDocuments: true,
              missingDocuments: [],
              rejectedDocuments: [{ key: "resumePdf", label: "Resume" }],
            }),
          }),
        (error) =>
          error?.statusCode === 400 &&
          error?.message === "Trainer has rejected documents and cannot move to review" &&
          error?.data?.rejectedDocuments?.length === 1,
      );
    },
  },
  {
    name: "documents move-to-review feed preserves transition and response-shape parity",
    run: async () => {
      const trainer = {
        _id: "TRN-MOVE-3",
        userId: { _id: "USER-MOVE-3" },
        status: "REJECTED",
        verificationStatus: "REJECTED",
        documentStatus: "rejected",
      };

      const workflowBefore = {
        hasAllRequiredDocuments: true,
        hasRejectedDocuments: false,
        missingDocuments: [],
        rejectedDocuments: [],
      };
      const workflowAfter = {
        documentStatus: "under_review",
        uploadedCount: 8,
        approvedCount: 8,
        pendingReviewCount: 0,
        requiredCount: 8,
        documentProgress: { pan: { status: "approved" } },
        checklist: [{ key: "pan", label: "PAN Card" }],
        missingDocuments: [],
        rejectedDocuments: [],
        hasAllRequiredDocuments: true,
        allRequiredDocumentsApproved: true,
        canProceedToAgreement: true,
      };

      let evaluateCallCount = 0;
      let saveCount = 0;

      const payload = await moveTrainerToReviewFeed({
        trainerId: "507f1f77bcf86cd799439052",
        actorRole: "SuperAdmin",
        findTrainerByIdWithUserLoader: async () => trainer,
        listTrainerDocumentsLoader: async () => [{ _id: "DOC-MOVE-2" }],
        evaluateTrainerDocumentWorkflowLoader: () => {
          evaluateCallCount += 1;
          return evaluateCallCount === 1 ? workflowBefore : workflowAfter;
        },
        getTrainerReviewGateLoader: () => ({
          ready: true,
          nextStep: 6,
          nextStepLabel: "Completed",
        }),
        saveTrainerLoader: async () => {
          saveCount += 1;
          return trainer;
        },
      });

      assert.equal(trainer.status, "PENDING");
      assert.equal(trainer.verificationStatus, "PENDING");
      assert.equal(trainer.documentStatus, "under_review");
      assert.equal(saveCount, 1);
      assert.equal(payload.success, true);
      assert.equal(payload.message, "Trainer moved to Review Docs successfully");
      assert.deepEqual(payload.data, {
        documentStatus: "under_review",
        documentSummary: {
          uploadedCount: 8,
          approvedCount: 8,
          pendingReviewCount: 0,
          requiredCount: 8,
        },
        documentProgress: { pan: { status: "approved" } },
        documentChecklist: [{ key: "pan", label: "PAN Card" }],
        missingDocuments: [],
        rejectedDocuments: [],
        hasAllRequiredDocuments: true,
        allRequiredDocumentsApproved: true,
        canProceedToAgreement: true,
      });
    },
  },
  {
    name: "documents submit-verification feed preserves trainer-not-found parity",
    run: async () => {
      await assert.rejects(
        () =>
          submitVerificationFeed({
            actorUserId: "USER-SUBMIT-404",
            actorRole: "Trainer",
            findTrainerByUserIdLoader: async () => null,
          }),
        (error) =>
          error?.statusCode === 404 &&
          error?.message === "Trainer profile not found",
      );
    },
  },
  {
    name: "documents submit-verification feed preserves missing-documents invalid-state parity",
    run: async () => {
      const trainer = {
        _id: "TRN-SUBMIT-1",
        documents: {
          selfiePhoto: "yes",
        },
      };

      await assert.rejects(
        () =>
          submitVerificationFeed({
            actorUserId: "USER-SUBMIT-1",
            actorRole: "Trainer",
            findTrainerByUserIdLoader: async () => trainer,
            requiredTrainerDocuments: [
              { key: "selfiePhoto" },
              { key: "pan" },
            ],
          }),
        (error) =>
          error?.statusCode === 400 &&
          error?.message ===
            "Please upload all required documents first. Missing: pan",
      );
    },
  },
  {
    name: "documents submit-verification feed preserves review-gate invalid-state parity",
    run: async () => {
      const trainer = {
        _id: "TRN-SUBMIT-2",
        documents: {
          selfiePhoto: "yes",
          pan: "yes",
        },
      };

      await assert.rejects(
        () =>
          submitVerificationFeed({
            actorUserId: "USER-SUBMIT-2",
            actorRole: "Trainer",
            findTrainerByUserIdLoader: async () => trainer,
            requiredTrainerDocuments: [{ key: "selfiePhoto" }, { key: "pan" }],
            getTrainerReviewGateLoader: () => ({
              ready: false,
              nextStep: 4,
              nextStepLabel: "Agreement",
            }),
          }),
        (error) =>
          error?.statusCode === 400 &&
          error?.message ===
            "Complete Agreement before submitting for admin review" &&
          error?.data?.nextStep === 4 &&
          error?.data?.nextStepLabel === "Agreement",
      );
    },
  },
  {
    name: "documents submit-verification feed preserves status transition and notification side-effects parity",
    run: async () => {
      const trainer = {
        _id: "TRN-SUBMIT-3",
        trainerId: "MBK-SUBMIT-001",
        documents: {
          selfiePhoto: "yes",
          pan: "yes",
        },
        status: "REJECTED",
        verificationStatus: "REJECTED",
        documentStatus: "rejected",
      };

      const superAdmins = [
        { _id: "ADM-1", email: "admin1@example.com" },
        { _id: "ADM-2", email: "admin2@example.com" },
      ];
      const actorUser = {
        _id: "USER-SUBMIT-3",
        name: "Trainer Submit",
        email: "trainer.submit@example.com",
      };

      const notifications = [];
      let saveCount = 0;
      let adminEmailPayload = null;

      const payload = await submitVerificationFeed({
        actorUserId: "USER-SUBMIT-3",
        actorRole: "Trainer",
        findTrainerByUserIdLoader: async () => trainer,
        requiredTrainerDocuments: [{ key: "selfiePhoto" }, { key: "pan" }],
        getTrainerReviewGateLoader: () => ({
          ready: true,
          nextStep: 6,
          nextStepLabel: "Completed",
        }),
        saveTrainerLoader: async () => {
          saveCount += 1;
          return trainer;
        },
        findUsersByRoleLoader: async () => superAdmins,
        findUserByIdLoader: async () => actorUser,
        sendAdminSubmissionNotificationEmailLoader: async (...args) => {
          adminEmailPayload = args;
        },
        createInAppNotificationLoader: async (context) => {
          notifications.push(context);
          return context;
        },
      });

      assert.equal(saveCount, 1);
      assert.equal(trainer.status, "PENDING");
      assert.equal(trainer.verificationStatus, "PENDING");
      assert.equal(trainer.documentStatus, "under_review");
      assert.deepEqual(adminEmailPayload, [
        ["admin1@example.com", "admin2@example.com"],
        "Trainer Submit",
        "trainer.submit@example.com",
        "MBK-SUBMIT-001",
      ]);
      assert.equal(notifications.length, 3);
      assert.equal(notifications[0].role, "SuperAdmin");
      assert.equal(notifications[1].role, "SuperAdmin");
      assert.deepEqual(notifications[2], {
        userId: "USER-SUBMIT-3",
        role: "Trainer",
        title: "Submission Received",
        message:
          "Your documents have been submitted securely. An admin will review them shortly.",
        type: "Approval",
        link: "/trainer-signup",
      });
      assert.deepEqual(payload, {
        success: true,
        message: "Profile submitted for verification successfully",
        data: {
          verificationStatus: "pending",
          documentStatus: "under_review",
        },
      });
    },
  },
  {
    name: "documents submit-verification feed preserves notification failure safety parity",
    run: async () => {
      const trainer = {
        _id: "TRN-SUBMIT-4",
        trainerId: "MBK-SUBMIT-002",
        documents: {
          selfiePhoto: "yes",
          pan: "yes",
        },
      };

      const originalConsoleError = console.error;
      console.error = () => {};

      try {
        const payload = await submitVerificationFeed({
          actorUserId: "USER-SUBMIT-4",
          actorRole: "Trainer",
          findTrainerByUserIdLoader: async () => trainer,
          requiredTrainerDocuments: [{ key: "selfiePhoto" }, { key: "pan" }],
          getTrainerReviewGateLoader: () => ({
            ready: true,
            nextStep: 6,
            nextStepLabel: "Completed",
          }),
          saveTrainerLoader: async () => trainer,
          findUsersByRoleLoader: async () => [{ _id: "ADM-4", email: "admin4@example.com" }],
          findUserByIdLoader: async () => ({
            _id: "USER-SUBMIT-4",
            name: "Trainer Four",
            email: "trainer.four@example.com",
          }),
          sendAdminSubmissionNotificationEmailLoader: async () => {
            throw new Error("smtp down");
          },
          createInAppNotificationLoader: async () => ({}),
        });

        assert.equal(payload.success, true);
        assert.equal(
          payload.message,
          "Profile submitted for verification successfully",
        );
      } finally {
        console.error = originalConsoleError;
      }
    },
  },
  {
    name: "documents upload feed preserves missing-file parity",
    run: async () => {
      await assert.rejects(
        () =>
          uploadTrainerDocumentFeed({
            payload: {
              documentType: "pan",
            },
            file: null,
          }),
        (error) => error?.statusCode === 400 && error?.message === "No file uploaded",
      );
    },
  },
  {
    name: "documents upload feed preserves invalid admin target trainer-id parity",
    run: async () => {
      await assert.rejects(
        () =>
          uploadTrainerDocumentFeed({
            payload: {
              documentType: "pan",
              targetTrainerId: "bad-id",
            },
            file: {
              mimetype: "application/pdf",
              originalname: "pan.pdf",
              buffer: Buffer.from("pdf"),
              size: 120,
            },
            actorUser: {
              id: "USER-UP-ADM-1",
              role: "Admin",
            },
          }),
        (error) => error?.statusCode === 400 && error?.message === "Invalid trainer ID",
      );
    },
  },
  {
    name: "documents upload feed preserves invalid-document-type parity",
    run: async () => {
      await assert.rejects(
        () =>
          uploadTrainerDocumentFeed({
            payload: {
              documentType: "unknownDoc",
              targetTrainerId: "507f1f77bcf86cd799439011",
            },
            file: {
              mimetype: "application/pdf",
              originalname: "doc.pdf",
              buffer: Buffer.from("pdf"),
              size: 120,
            },
            actorUser: {
              id: "USER-UP-ADM-2",
              role: "Admin",
            },
            findTrainerByIdLoader: async () => ({
              _id: "TRN-UP-1",
              trainerId: "MBK-UP-1",
            }),
          }),
        (error) => error?.statusCode === 400 && error?.message === "Invalid document type",
      );
    },
  },
  {
    name: "documents upload feed preserves success shape and file/drive side-effect parity",
    run: async () => {
      const queuedCleanup = [];
      let profilePictureSync = null;
      let avatarSync = null;
      let savedTrainerCount = 0;

      const trainer = {
        _id: "TRN-UP-2",
        trainerId: "MBK-UP-2",
        userId: "USER-UP-2",
        documents: {},
        profilePicture: null,
      };

      const existingDoc = {
        _id: "DOC-UP-EXIST-1",
        documentType: "selfiePhoto",
        filePath: "https://drive.google.com/old-file",
        driveFileId: "DRV-OLD-1",
        createdAt: new Date("2026-04-04T08:00:00.000Z"),
      };

      const payload = await uploadTrainerDocumentFeed({
        payload: {
          documentType: "selfiePhoto",
          targetTrainerId: "507f1f77bcf86cd799439012",
        },
        file: {
          mimetype: "image/jpeg",
          originalname: "selfie.jpg",
          buffer: Buffer.from("img"),
          size: 2048,
        },
        actorUser: {
          id: "USER-UP-ADMIN-3",
          role: "Admin",
        },
        findTrainerByIdLoader: async () => trainer,
        saveTrainerLoader: async ({ trainer: trainerDoc }) => {
          savedTrainerCount += 1;
          return trainerDoc;
        },
        findTrainerDocumentByTypeCandidatesLoader: async () => existingDoc,
        ensureTrainerDocumentHierarchyLoader: async () => ({
          trainerFolder: { id: "DRV-FOLDER-TRN-1", name: "TRN-1" },
          documentsFolder: { id: "DRV-FOLDER-DOC-1", name: "Documents" },
        }),
        uploadToDriveLoader: async () => ({
          fileId: "DRV-NEW-1",
          fileUrl: "https://drive.google.com/new-selfie",
          webViewLink: "https://drive.google.com/view/DRV-NEW-1",
          downloadLink: "https://drive.google.com/download/DRV-NEW-1",
        }),
        saveDocumentLoader: async ({ document }) => {
          document.createdAt = existingDoc.createdAt;
          return document;
        },
        listTrainerDocumentsLoader: async () => [{ _id: "DOC-UP-EXIST-1" }],
        syncTrainerDocumentWorkflowLoader: () => ({
          documentStatus: "uploaded",
          documentProgress: {
            selfiePhoto: { status: "pending" },
          },
          missingDocuments: [],
        }),
        updateUserProfilePictureLoader: async ({ profilePicture }) => {
          profilePictureSync = profilePicture;
        },
        updateUserAvatarLoader: async (_userId, avatarUrl) => {
          avatarSync = avatarUrl;
        },
        queueTrainerDocumentCleanupLoader: (cleanupPayload) => {
          queuedCleanup.push(cleanupPayload);
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Document uploaded successfully");
      assert.equal(payload.data.filePath, "https://drive.google.com/new-selfie");
      assert.equal(payload.data.driveFileId, "DRV-NEW-1");
      assert.equal(payload.data.normalizedStatus, "pending");
      assert.equal(payload.data.documentStatus, "uploaded");
      assert.equal(profilePictureSync, "https://drive.google.com/new-selfie");
      assert.equal(avatarSync, "https://drive.google.com/new-selfie");
      assert.equal(savedTrainerCount >= 1, true);
      assert.equal(queuedCleanup.length, 1);
      assert.equal(queuedCleanup[0].driveFileId, "DRV-OLD-1");
      assert.equal(queuedCleanup[0].contextLabel, "trainer-document-replaced");
      assert.match(queuedCleanup[0].correlationId, /^doc_upload_\d+_[a-z0-9]{8}$/i);
    },
  },
  {
    name: "documents upload feed preserves drive rollback cleanup semantics parity",
    run: async () => {
      let deletedDriveFileId = null;

      await assert.rejects(
        () =>
          uploadTrainerDocumentFeed({
            payload: {
              documentType: "pan",
              targetTrainerId: "507f1f77bcf86cd799439013",
            },
            file: {
              mimetype: "application/pdf",
              originalname: "pan.pdf",
              buffer: Buffer.from("pdf"),
              size: 333,
            },
            actorUser: {
              id: "USER-UP-ADMIN-4",
              role: "Admin",
            },
            findTrainerByIdLoader: async () => ({
              _id: "TRN-UP-3",
              trainerId: "MBK-UP-3",
              documents: {},
            }),
            saveTrainerLoader: async ({ trainer }) => trainer,
            findTrainerDocumentByTypeCandidatesLoader: async () => null,
            ensureTrainerDocumentHierarchyLoader: async () => ({
              trainerFolder: { id: "DRV-FOLDER-TRN-2", name: "TRN-2" },
              documentsFolder: { id: "DRV-FOLDER-DOC-2", name: "Documents" },
            }),
            uploadToDriveLoader: async () => ({
              fileId: "DRV-UP-ROLLBACK-1",
              fileUrl: "https://drive.google.com/pan",
              webViewLink: "https://drive.google.com/view/DRV-UP-ROLLBACK-1",
              downloadLink: "https://drive.google.com/download/DRV-UP-ROLLBACK-1",
            }),
            createDocumentLoader: async () => {
              throw new Error("db save failed");
            },
            deleteDriveFileLoader: async (driveFileId) => {
              deletedDriveFileId = driveFileId;
            },
          }),
        (error) => error?.message === "db save failed",
      );

      assert.equal(deletedDriveFileId, "DRV-UP-ROLLBACK-1");
    },
  },
  {
    name: "documents upload feed preserves cleanup-queue side-effect safety parity",
    run: async () => {
      const trainer = {
        _id: "TRN-UP-4",
        trainerId: "MBK-UP-4",
        userId: "USER-UP-4",
        documents: {},
      };
      const existingDoc = {
        _id: "DOC-UP-EXIST-2",
        documentType: "pan",
        filePath: "https://drive.google.com/old-pan",
        driveFileId: "DRV-OLD-PAN-2",
        createdAt: new Date("2026-04-05T08:00:00.000Z"),
      };

      const payload = await uploadTrainerDocumentFeed({
        payload: {
          documentType: "pan",
          targetTrainerId: "507f1f77bcf86cd799439014",
        },
        file: {
          mimetype: "application/pdf",
          originalname: "pan.pdf",
          buffer: Buffer.from("pdf"),
          size: 1024,
        },
        actorUser: {
          id: "USER-UP-ADMIN-5",
          role: "Admin",
        },
        findTrainerByIdLoader: async () => trainer,
        saveTrainerLoader: async ({ trainer: trainerDoc }) => trainerDoc,
        findTrainerDocumentByTypeCandidatesLoader: async () => existingDoc,
        ensureTrainerDocumentHierarchyLoader: async () => ({
          trainerFolder: { id: "DRV-FOLDER-TRN-3", name: "TRN-3" },
          documentsFolder: { id: "DRV-FOLDER-DOC-3", name: "Documents" },
        }),
        uploadToDriveLoader: async () => ({
          fileId: "DRV-NEW-PAN-3",
          fileUrl: "https://drive.google.com/new-pan",
          webViewLink: "https://drive.google.com/view/DRV-NEW-PAN-3",
          downloadLink: "https://drive.google.com/download/DRV-NEW-PAN-3",
        }),
        saveDocumentLoader: async ({ document }) => {
          document.createdAt = existingDoc.createdAt;
          return document;
        },
        listTrainerDocumentsLoader: async () => [{ _id: existingDoc._id }],
        syncTrainerDocumentWorkflowLoader: () => ({
          documentStatus: "uploaded",
          documentProgress: {
            pan: { status: "pending" },
          },
          missingDocuments: [],
        }),
        queueTrainerDocumentCleanupLoader: () => {
          throw new Error("queue unavailable");
        },
      });

      assert.equal(payload.success, true);
      assert.equal(payload.message, "Document uploaded successfully");
      assert.equal(payload.data.documentType, "pan");
    },
  },
  {
    name: "documents cleanup queue keeps fallback cleanup parity when enqueue fails",
    run: async () => {
      let fallbackDriveDeleteId = null;
      const originalConsoleWarn = console.warn;
      console.warn = () => {};

      try {
        const queued = queueTrainerDocumentCleanup({
          driveFileId: "DRV-FALLBACK-1",
          contextLabel: "unit-fallback",
          ensureRegistrationLoader: () => {},
          enqueueCleanupJobLoader: async () => {
            throw new Error("queue down");
          },
          deleteDriveFileLoader: async (driveFileId) => {
            fallbackDriveDeleteId = driveFileId;
          },
          deleteLegacyFileLoader: async () => {},
        });

        assert.equal(queued, true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(fallbackDriveDeleteId, "DRV-FALLBACK-1");
      } finally {
        console.warn = originalConsoleWarn;
      }
    },
  },
];

let failedCount = 0;

for (const testCase of tests) {
  try {
    await testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failedCount += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failedCount > 0) {
  console.error(`\n${failedCount} unit test(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} unit tests passed.`);
process.exit(0);
