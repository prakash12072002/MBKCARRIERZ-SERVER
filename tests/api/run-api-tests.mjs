import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env.DISABLE_REDIS = process.env.DISABLE_REDIS || "1";

const require = createRequire(import.meta.url);
const { v1ResponseEnvelope } = require("../../middleware/v1ResponseEnvelope.js");
const {
  createAssignScheduleController,
  createBulkCreateScheduleController,
  createBulkUploadScheduleController,
  createCreateScheduleController,
  createDeleteScheduleController,
  createScheduleAssociationsController,
  createScheduleDetailsController,
  createUpdateScheduleController,
} = require("../../modules/schedules/schedules.controller.js");
const {
  createMoveToReviewController,
  createSubmitVerificationController,
  createUploadDocumentController,
  createTrainerApproachController,
  createMyDocumentsController,
  createTrainerStatusController,
  createTrainerDocumentsController,
  createVerifyDocumentController,
} = require("../../modules/documents/documents.controller.js");
const {
  createAttendanceCollegeController,
  createAttendanceDocumentsController,
  createAttendanceLegacyDetailsController,
  createAttendanceScheduleController,
  createAttendanceTrainerController,
} = require("../../modules/attendance/attendance.controller.js");
const {
  createChatBootstrapController,
  createChatBroadcastController,
  createChatChannelAuditLogController,
  createChatChannelClearMessagesController,
  createChatChannelDeleteController,
  createChatChannelLeaveController,
  createChatGroupAddMembersController,
  createChatGroupCreateController,
  createChatGroupRemoveMemberController,
  createChatChannelRemoveUserController,
  createChatCreateController,
  createChatMessageSendController,
  createChatDeleteMessageController,
  createChatDeleteForEveryoneController,
  createChatDeleteForMeController,
  createChatDirectController,
  createChatFullBootstrapController,
  createChatInfoController,
  createChatListController,
  createChatMessageHistoryController,
  createChatMessageSearchController,
  createChatQuickBootstrapController,
  createChatSearchController,
  createChatValidationLogsController,
} = require("../../modules/chat/chat.controller.js");
const { 
  createVerifyAttendanceDocumentController,
  createRejectAttendanceDocumentController,
  createVerifyGeoTagController,
  createRejectGeoTagController,
} = require("../../modules/attendance/attendance.controller.js");
const {
  uploadTrainerDocumentMiddleware,
} = require("../../modules/documents/documents.upload.js");
const {
  createInternalMetricsRouter,
} = require("../../routes/internalMetricsRoutes.js");
const {
  createSyncDbHandler,
} = require("../../routes/driveHierarchyRoutes.js");
const {
  getFileWorkflowQueueMetricsSnapshot,
  recordFileWorkflowQueueMetric,
  resetFileWorkflowQueueMetrics,
} = require("../../jobs/queues/fileWorkflowQueueMetrics.js");
const {
  RealtimeMessageError,
} = require("../../services/realtimeMessageService");

const startServer = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });

const stopServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const waitForAsyncTicks = (ms = 25) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const loadAttendanceRouterWithDriveMocks = ({
  scenario = "attendance-doc",
  scheduleFolders = {},
} = {}) => {
  const attendanceRoutesPath = require.resolve("../../routes/attendanceRoutes.js");
  const routeRequire = createRequire(attendanceRoutesPath);

  const defaultScheduleFolders = {
    dayFolderId: "DAY-CANON-1",
    dayFolderName: "Day_1",
    dayFolderLink: "https://drive/day-canon-1",
    attendanceFolderId: "ATT-CANON-1",
    attendanceFolderName: "Attendance",
    attendanceFolderLink: "https://drive/att-canon-1",
    geoTagFolderId: "GEO-CANON-1",
    geoTagFolderName: "GeoTag",
    geoTagFolderLink: "https://drive/geo-canon-1",
    driveFolderId: "DAY-CANON-1",
    driveFolderName: "Day_1",
    driveFolderLink: "https://drive/day-canon-1",
    dayNumber: 1,
    departmentId: "DEPT-1",
    companyId: "COMP-1",
    courseId: "COURSE-1",
    collegeId: "COL-1",
  };
  const canonicalSchedule = {
    _id: "507f1f77bcf86cd799439010",
    trainerId: "TRN-OBJ-1",
    scheduledDate: "2026-04-09",
    ...defaultScheduleFolders,
    ...scheduleFolders,
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mbk-att-api-"));
  const attendanceFilePath = path.join(tmpDir, "attendance.pdf");
  const geoFilePath = path.join(tmpDir, "geo.jpg");
  fs.writeFileSync(attendanceFilePath, Buffer.from("attendance-file"));
  fs.writeFileSync(geoFilePath, Buffer.from("geo-file"));

  const uploadCalls = [];
  const handlersByType = new Map();
  const attendanceStore = new Map();
  let attendanceIdCounter = 1;

  class MockAttendance {
    constructor(data = {}) {
      this._id = data._id || `ATT-${attendanceIdCounter++}`;
      Object.assign(this, data);
    }

    markModified() {}

    async save() {
      attendanceStore.set(String(this._id), this);
      return this;
    }

    static findOne(filter = {}) {
      return {
        sort: async () => {
          if (scenario === "geo-slot-upload") {
            const scheduleId = String(filter?.scheduleId || "").trim();
            const matched = Array.from(attendanceStore.values()).find(
              (attendance) => String(attendance?.scheduleId || "").trim() === scheduleId,
            );
            return matched || null;
          }
          return null;
        },
      };
    }

    static async findById(id) {
      return attendanceStore.get(String(id)) || null;
    }

    static async updateOne() {
      return { acknowledged: true };
    }
  }

  const departmentDoc = {
    _id: "DEPT-1",
    name: "CSE",
    companyId: "COMP-1",
    courseId: "COURSE-1",
    collegeId: "COL-1",
    dayFolders: [
      {
        day: 1,
        folderId: canonicalSchedule.dayFolderId,
        folderName: canonicalSchedule.dayFolderName,
        folderLink: canonicalSchedule.dayFolderLink,
        attendanceFolderId: "ATT-FALLBACK-DUPLICATE",
        attendanceFolderName: "Attendance",
        attendanceFolderLink: "https://drive/att-fallback-duplicate",
        geoTagFolderId: "GEO-FALLBACK-DUPLICATE",
        geoTagFolderName: "GeoTag",
        geoTagFolderLink: "https://drive/geo-fallback-duplicate",
      },
    ],
    async save() {
      return this;
    },
  };

  const modelsMock = {
    Attendance: MockAttendance,
    Trainer: {
      findById: () => ({
        select: async () => ({ _id: "TRN-OBJ-1", trainerId: "TRN001" }),
      }),
      findOne: () => ({
        select: async () => ({ _id: "TRN-OBJ-1", trainerId: "TRN001" }),
      }),
    },
    College: {
      findById: () => ({
        select: async () => ({
          _id: "COL-1",
          name: "College One",
          latitude: 11.11,
          longitude: 78.11,
          location: { latitude: 11.11, longitude: 78.11 },
        }),
      }),
    },
    Company: {
      findById: () => ({
        select: async () => ({ _id: "COMP-1", name: "Company One" }),
      }),
    },
    Course: {
      findById: () => ({
        select: async () => ({ _id: "COURSE-1", title: "Course One" }),
      }),
    },
    Schedule: {
      findById: () => ({
        select: async () => ({ ...canonicalSchedule }),
      }),
      findByIdAndUpdate: async () => ({ acknowledged: true }),
    },
    User: {},
    Student: {},
    Notification: {},
    Department: {
      findById: () => ({
        select: async () => departmentDoc,
      }),
    },
    ScheduleDocument: {
      findOneAndUpdate: async () => ({ acknowledged: true }),
      updateMany: async () => ({ acknowledged: true }),
    },
  };

  const driveGatewayMock = {
    uploadToDriveWithRetry: async ({ folderId, fileName, originalName }) => {
      uploadCalls.push({
        folderId: folderId || null,
        fileName: fileName || null,
        originalName: originalName || null,
      });
      return {
        fileId: `FILE-${uploadCalls.length}`,
        fileName: fileName || originalName || `file-${uploadCalls.length}`,
        webViewLink: `https://drive/file-${uploadCalls.length}`,
      };
    },
    ensureDriveFolder: async ({ folderName, parentFolderId }) => ({
      id: `ENSURED-${folderName}-${parentFolderId || "ROOT"}`,
      name: folderName,
      webViewLink: `https://drive/${folderName}`,
    }),
    isTrainingDriveEnabled: () => true,
    ensureTrainingRootFolder: async () => ({
      id: "ROOT-TRAINING",
      name: "Training",
      webViewLink: "https://drive/root-training",
    }),
    ensureDepartmentHierarchy: async () => ({
      departmentFolder: {
        id: "DEPT-FOLDER-1",
        name: "CSE",
        link: "https://drive/dept-cse",
      },
      dayFoldersByDayNumber: {
        1: {
          folderId: canonicalSchedule.dayFolderId,
          folderName: canonicalSchedule.dayFolderName,
          folderLink: canonicalSchedule.dayFolderLink,
          attendanceFolderId: canonicalSchedule.attendanceFolderId,
          attendanceFolderName: canonicalSchedule.attendanceFolderName,
          attendanceFolderLink: canonicalSchedule.attendanceFolderLink,
          geoTagFolderId: canonicalSchedule.geoTagFolderId,
          geoTagFolderName: canonicalSchedule.geoTagFolderName,
          geoTagFolderLink: canonicalSchedule.geoTagFolderLink,
        },
      },
    }),
    toDepartmentDayFolders: (dayFoldersByDayNumber = {}) =>
      Object.entries(dayFoldersByDayNumber).map(([day, folder]) => ({
        day: Number(day),
        folderId: folder.folderId || null,
        folderName: folder.folderName || null,
        folderLink: folder.folderLink || null,
        attendanceFolderId: folder.attendanceFolderId || null,
        attendanceFolderName: folder.attendanceFolderName || null,
        attendanceFolderLink: folder.attendanceFolderLink || null,
        geoTagFolderId: folder.geoTagFolderId || null,
        geoTagFolderName: folder.geoTagFolderName || null,
        geoTagFolderLink: folder.geoTagFolderLink || null,
      })),
  };

  const uploadMock = {
    uploadAttendance: (req, _res, next) => {
      if (scenario === "attendance-doc") {
        req.files = {
          attendancePdf: [
            {
              path: attendanceFilePath,
              originalname: "attendance.pdf",
              mimetype: "application/pdf",
            },
          ],
        };
      } else if (scenario === "checkout-geo") {
        req.files = {
          checkOutGeoImage: [
            {
              path: geoFilePath,
              originalname: "geotag.jpg",
              mimetype: "image/jpeg",
            },
          ],
        };
      } else {
        req.files = {};
      }
      next();
    },
    uploadManual: (_req, _res, next) => next(),
    uploadGeoImage: (_req, _res, next) => next(),
    GEO_IMAGE_MAX_SIZE_MB: 3,
  };

  if (scenario === "geo-slot-upload") {
    const seededAttendance = new MockAttendance({
      _id: "ATT-GEO-1",
      scheduleId: canonicalSchedule._id,
      trainerId: "TRN-OBJ-1",
      verificationStatus: "approved",
      finalStatus: "PENDING",
      status: "Present",
      images: [],
      checkOut: {
        finalStatus: "PENDING",
        location: {},
        images: [],
        photos: [],
      },
      checkOutGeoImageUrl: null,
      checkOutGeoImageUrls: [],
      driveAssets: {
        syncedAt: null,
        filesByField: {},
        files: [],
        lastSyncError: null,
      },
      driveSyncStatus: "PENDING",
    });
    attendanceStore.set(String(seededAttendance._id), seededAttendance);

    uploadMock.uploadGeoImage = (req, _res, next) => {
      req.file = {
        path: geoFilePath,
        originalname: "geo-slot.jpg",
        mimetype: "image/jpeg",
      };
      next();
    };
  }

  const queueMock = {
    enqueueFileWorkflowJob: async ({ type, payload }) => {
      const handler = handlersByType.get(type);
      if (typeof handler === "function") {
        await handler(payload, { attempt: 0 });
      }
      return { id: `JOB-${type}` };
    },
    registerFileWorkflowJobHandler: (type, handler) => {
      handlersByType.set(type, handler);
    },
  };

  const attendanceControllerMock = {
    getAttendanceScheduleController: (_req, res) => res.status(501).json({ success: false }),
    getAttendanceLegacyDetailsController: (_req, res) => res.status(501).json({ success: false }),
    getAttendanceTrainerController: (_req, res) => res.status(501).json({ success: false }),
    getAttendanceCollegeController: (_req, res) => res.status(501).json({ success: false }),
    getAttendanceDocumentsController: (_req, res) => res.status(501).json({ success: false }),
    createVerifyAttendanceDocumentController: () => (_req, res) => res.status(501).json({ success: false }),
    createRejectAttendanceDocumentController: () => (_req, res) => res.status(501).json({ success: false }),
    createMarkManualAttendanceController: () => (_req, res) => res.status(501).json({ success: false }),
    verifyGeoTagController: (_req, res) => res.status(501).json({ success: false }),
    rejectGeoTagController: (_req, res) => res.status(501).json({ success: false }),
  };

  const sideEffectsMock = {
    syncScheduleDayState: async () => ({
      dayStatus: "completed",
      attendanceUploaded: true,
      geoTagUploaded: scenario === "checkout-geo",
    }),
    emitAttendanceRealtimeUpdate: () => {},
    syncScheduleLifecycleStatusFromAttendance: async () => {},
    normalizeVerificationStatus: (value, fallback = null) => {
      if (value == null || value === "") return fallback;
      return String(value).toLowerCase();
    },
  };

  const noOpLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const mockDefs = [
    { request: "../config/upload", exports: uploadMock },
    { request: "../models", exports: modelsMock },
    { request: "../modules/drive/driveGateway", exports: driveGatewayMock },
    { request: "../jobs/queues/fileWorkflowQueue", exports: queueMock },
    { request: "../modules/attendance/attendance.controller", exports: attendanceControllerMock },
    { request: "../modules/attendance/attendance.sideeffects", exports: sideEffectsMock },
    {
      request: "../shared/utils/structuredLogger",
      exports: {
        createCorrelationId: (prefix) => `${prefix || "corr"}-test`,
        createStructuredLogger: () => noOpLogger,
      },
    },
    {
      request: "../services/trainerScheduleCacheService",
      exports: {
        invalidateTrainerScheduleCaches: async () => {},
      },
    },
    {
      request: "../services/notificationService",
      exports: {
        sendNotification: async () => {},
      },
    },
    {
      request: "../utils/exif",
      exports: {
        getGeoTagData: () => ({
          latitude: 11.11,
          longitude: 78.11,
          capturedAt: new Date("2026-04-09T09:11:00.000Z"),
          hasGps: true,
        }),
      },
    },
    {
      request: "../utils/ocr",
      exports: {
        extractOcrStampData: async () => ({
          latitude: 11.11,
          longitude: 78.11,
          capturedAt: "2026-04-09T09:11:00.000Z",
        }),
      },
    },
    {
      request: "../utils/verify",
      exports: {
        verifyGeoTag: () => ({
          status: "PENDING",
          reason: "Manual review required",
          reasonCode: "MANUAL_REVIEW_REQUIRED",
          latitude: 11.11,
          longitude: 78.11,
          distance: 0,
          timestamp: Math.floor(Date.now() / 1000),
          validationSource: "mock",
          missingFields: [],
        }),
      },
    },
  ];

  const originalCacheEntries = [];
  const setMock = (request, exportsValue) => {
    const resolved = routeRequire.resolve(request);
    originalCacheEntries.push({
      resolved,
      cached: Object.prototype.hasOwnProperty.call(require.cache, resolved)
        ? require.cache[resolved]
        : undefined,
    });
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: exportsValue,
    };
  };

  for (const mockDef of mockDefs) {
    setMock(mockDef.request, mockDef.exports);
  }

  delete require.cache[attendanceRoutesPath];
  const router = require(attendanceRoutesPath);

  const cleanup = () => {
    delete require.cache[attendanceRoutesPath];
    for (const entry of originalCacheEntries) {
      if (entry.cached === undefined) {
        delete require.cache[entry.resolved];
      } else {
        require.cache[entry.resolved] = entry.cached;
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_error) {}
  };

  return {
    router,
    uploadCalls,
    canonicalSchedule,
    cleanup,
  };
};

const runSuccessEnvelopeCase = async () => {
  const app = express();
  const router = express.Router();

  router.get("/ok", (_req, res) => {
    res.json({ trainers: [{ id: "T-1001" }], total: 1 });
  });

  app.use("/api/v1/test", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/v1/test/ok`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.error, null);
    assert.deepEqual(payload.data, {
      trainers: [{ id: "T-1001" }],
      total: 1,
    });
  } finally {
    await stopServer(server);
  }
};

const runErrorEnvelopeCase = async () => {
  const app = express();
  const router = express.Router();

  router.post("/bad-request", (_req, res) => {
    res.status(400).json({
      message: "Missing required field: trainerId",
      code: "VALIDATION_ERROR",
    });
  });

  app.use("/api/v1/test", express.json(), v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/v1/test/bad-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.equal(payload.data, null);
    assert.equal(payload.error.statusCode, 400);
    assert.match(payload.error.message, /Missing required field/i);
    assert.deepEqual(payload.error.details, {
      code: "VALIDATION_ERROR",
    });
  } finally {
    await stopServer(server);
  }
};

const createDriveSyncDeps = ({ onReconcile } = {}) => {
  const mutationLog = [];
  const ensureCallLog = [];
  const reconcileLog = [];
  const dryRunAuditLog = [];
  const duplicateCleanupLog = [];

  const companyDoc = {
    _id: "COMP-1",
    name: "Company One",
    driveFolderId: null,
    driveFolderName: null,
    driveFolderLink: null,
    save: async () => {
      mutationLog.push("company:save");
    },
  };
  const courseDoc = {
    _id: "COURSE-1",
    title: "Course One",
    companyId: "COMP-1",
    driveFolderId: null,
    driveFolderName: null,
    driveFolderLink: null,
    save: async () => {
      mutationLog.push("course:save");
    },
  };
  const collegeDoc = {
    _id: "COLLEGE-1",
    name: "College One",
    companyId: "COMP-1",
    courseId: "COURSE-1",
    driveFolderId: null,
    driveFolderName: null,
    driveFolderLink: null,
    save: async () => {
      mutationLog.push("college:save");
    },
  };
  const departmentDoc = {
    _id: "DEPT-1",
    name: "CSE",
    companyId: "COMP-1",
    courseId: "COURSE-1",
    collegeId: "COLLEGE-1",
    driveFolderId: null,
    driveFolderName: null,
    driveFolderLink: null,
    dayFolders: [],
    save: async () => {
      mutationLog.push("department:save");
    },
  };
  const schedules = [
    {
      _id: "SCHEDULE-1",
      dayNumber: 1,
      trainerId: "TRN-1",
      attendanceUploaded: false,
      geoTagUploaded: false,
      dayFolderId: null,
      dayFolderName: null,
      dayFolderLink: null,
      attendanceFolderId: null,
      attendanceFolderName: null,
      attendanceFolderLink: null,
      geoTagFolderId: null,
      geoTagFolderName: null,
      geoTagFolderLink: null,
      driveFolderId: null,
      driveFolderName: null,
      driveFolderLink: null,
    },
  ];

  const asSelect = (payload) => ({
    select: async () => payload,
  });

  const deps = {
    isTrainingDriveEnabled: () => true,
    Company: {
      find: () => asSelect([companyDoc]),
    },
    Course: {
      findById: (id) =>
        asSelect(String(id) === "COURSE-1" ? courseDoc : null),
      find: () => asSelect([courseDoc]),
    },
    College: {
      findById: (id) =>
        asSelect(String(id) === "COLLEGE-1" ? collegeDoc : null),
      find: () => asSelect([collegeDoc]),
    },
    Department: {
      findById: (id) =>
        asSelect(String(id) === "DEPT-1" ? departmentDoc : null),
      find: () => asSelect([departmentDoc]),
    },
    Schedule: {
      find: () => asSelect(schedules),
      bulkWrite: async (operations = []) => {
        mutationLog.push("schedule:bulkWrite");
        operations.forEach((operation) => {
          const filterId = String(operation?.updateOne?.filter?._id || "");
          const updateSet = operation?.updateOne?.update?.$set || {};
          const target = schedules.find((schedule) => String(schedule?._id || "") === filterId);
          if (!target) return;
          Object.assign(target, updateSet);
        });
      },
    },
    ensureCompanyHierarchy: async () => {
      ensureCallLog.push("ensureCompanyHierarchy");
      return {
        companyFolder: { id: "DRV-COMP", name: "Company One", link: "link-comp" },
      };
    },
    ensureCourseHierarchy: async () => {
      ensureCallLog.push("ensureCourseHierarchy");
      return {
        companyFolder: { id: "DRV-COMP", name: "Company One", link: "link-comp" },
        courseFolder: { id: "DRV-COURSE", name: "Course One", link: "link-course" },
      };
    },
    ensureCollegeHierarchy: async () => {
      ensureCallLog.push("ensureCollegeHierarchy");
      return {
        companyFolder: { id: "DRV-COMP", name: "Company One", link: "link-comp" },
        courseFolder: { id: "DRV-COURSE", name: "Course One", link: "link-course" },
        collegeFolder: { id: "DRV-COLLEGE", name: "College One", link: "link-college" },
      };
    },
    ensureDepartmentHierarchy: async () => {
      ensureCallLog.push("ensureDepartmentHierarchy");
      return {
        companyFolder: { id: "DRV-COMP", name: "Company One", link: "link-comp" },
        courseFolder: { id: "DRV-COURSE", name: "Course One", link: "link-course" },
        collegeFolder: { id: "DRV-COLLEGE", name: "College One", link: "link-college" },
        departmentFolder: { id: "DRV-DEPT", name: "CSE", link: "link-dept" },
        dayFoldersByDayNumber: {
          1: {
            id: "DRV-DAY-1",
            name: "Day_1",
            link: "link-day-1",
            attendanceFolder: { id: "DRV-ATT-1", name: "Attendance", link: "link-att-1" },
            geoTagFolder: { id: "DRV-GEO-1", name: "GeoTag", link: "link-geo-1" },
          },
        },
      };
    },
    toDepartmentDayFolders: () => [
      {
        day: 1,
        folderId: "DRV-DAY-1",
        attendanceFolderId: "DRV-ATT-1",
        geoTagFolderId: "DRV-GEO-1",
      },
    ],
    createDriveSyncReconciliationSummary: () => ({
      totalScanned: 0,
      attendanceBackfilled: 0,
      geoTagBackfilled: 0,
      refreshedLinks: 0,
      duplicateDayFoldersCleared: 0,
      canonicalMappingsUpdated: 0,
      skippedAmbiguous: 0,
      unchanged: 0,
      schedulesReconciled: 0,
      errors: [],
    }),
    createDriveSyncDryRunSummary: () => ({
      totalScanned: 0,
      candidateMatches: 0,
      attendanceWouldBackfill: 0,
      geoWouldBackfill: 0,
      refreshedLinksWouldChange: 0,
      duplicateDayFoldersWouldClear: 0,
      canonicalMappingsWouldChange: 0,
      skippedAmbiguous: 0,
      unchanged: 0,
      schedulesReconciled: 0,
      normalization: {
        departmentsAnalyzed: 0,
        dayFoldersDetected: 0,
        duplicateDayFolders: 0,
        canonicalDayFolders: 0,
        ambiguousDayFolders: 0,
        filesMatchedSafely: 0,
        proposedActions: { keep: 0, link: 0, move: 0, skip: 0 },
        departments: [],
      },
      warnings: [],
      errors: [],
    }),
    buildDepartmentDayFolderNormalizationPreview: async () => ({
      preview: {
        departmentId: "DEPT-1",
        dayFoldersDetected: 2,
        duplicateDayFolders: 1,
        canonicalDayFolders: 1,
        ambiguousDayFolders: 0,
        filesMatchedSafely: 5,
        proposedActions: { keep: 1, link: 1, move: 1, skip: 0 },
        days: [
          {
            dayNumber: 1,
            canonical: {
              dayFolderId: "DRV-DAY-1",
              attendanceFolderId: "DRV-ATT-1",
              geoTagFolderId: "DRV-GEO-1",
            },
          },
        ],
      },
      canonicalByDay: {
        1: {
          dayFolderId: "DRV-DAY-1",
          dayFolderName: "Day_1",
          dayFolderLink: "link-day-1",
          attendanceFolderId: "DRV-ATT-1",
          attendanceFolderName: "Attendance",
          attendanceFolderLink: "link-att-1",
          geoTagFolderId: "DRV-GEO-1",
          geoTagFolderName: "GeoTag",
          geoTagFolderLink: "link-geo-1",
        },
      },
    }),
    appendNormalizationPreview: (summary, preview) => {
      if (!summary.normalization) {
        summary.normalization = {
          departmentsAnalyzed: 0,
          dayFoldersDetected: 0,
          duplicateDayFolders: 0,
          canonicalDayFolders: 0,
          ambiguousDayFolders: 0,
          filesMatchedSafely: 0,
          proposedActions: { keep: 0, link: 0, move: 0, skip: 0 },
          departments: [],
        };
      }
      summary.normalization.departmentsAnalyzed += 1;
      summary.normalization.dayFoldersDetected += Number(preview.dayFoldersDetected || 0);
      summary.normalization.duplicateDayFolders += Number(preview.duplicateDayFolders || 0);
      summary.normalization.canonicalDayFolders += Number(preview.canonicalDayFolders || 0);
      summary.normalization.ambiguousDayFolders += Number(preview.ambiguousDayFolders || 0);
      summary.normalization.filesMatchedSafely += Number(preview.filesMatchedSafely || 0);
      summary.normalization.proposedActions.keep += Number(preview.proposedActions?.keep || 0);
      summary.normalization.proposedActions.link += Number(preview.proposedActions?.link || 0);
      summary.normalization.proposedActions.move += Number(preview.proposedActions?.move || 0);
      summary.normalization.proposedActions.skip += Number(preview.proposedActions?.skip || 0);
      summary.normalization.departments.push(preview);
    },
    applyDepartmentDayFolderDuplicateCleanup: async ({
      summary,
      dryRun,
      preview,
    }) => {
      duplicateCleanupLog.push({
        dryRun,
        duplicateDayFolders: Number(preview?.duplicateDayFolders || 0),
      });
      if (dryRun) {
        summary.duplicateDayFoldersWouldClear += Number(preview?.duplicateDayFolders || 0);
        return;
      }
      summary.duplicateDayFoldersCleared += 0;
      if (Array.isArray(summary.warnings)) {
        summary.warnings.push(
          "Duplicate folder normalization ran in non-destructive mode. No Drive folders were moved or deleted.",
        );
      }
    },
    mergeDuplicateDriveFolders: async () => ({
      removedFolderIds: [],
      cleanupWarnings: [],
    }),
    listDriveFolderChildren: async () => [],
    reconcileDepartmentSchedulesDriveEvidence: async ({ summary, dryRun }) => {
      reconcileLog.push({ dryRun });
      if (typeof onReconcile === "function") {
        await onReconcile({ summary, dryRun, reconcileLog });
        return;
      }

      if (dryRun) {
        summary.totalScanned += 6;
        summary.candidateMatches += 4;
        summary.attendanceWouldBackfill += 1;
        summary.geoWouldBackfill += 1;
        summary.refreshedLinksWouldChange += 1;
        summary.skippedAmbiguous += 1;
        summary.schedulesReconciled += 1;
        summary.warnings.push("Ambiguous legacy file skipped");
        return;
      }

      summary.totalScanned += 6;
      summary.attendanceBackfilled += 1;
      summary.geoTagBackfilled += 1;
      summary.refreshedLinks += 1;
      summary.skippedAmbiguous += 1;
      summary.schedulesReconciled += 1;
    },
    logDryRunAuditEvent: (payload) => {
      dryRunAuditLog.push(payload);
    },
  };

  return {
    deps,
    mutationLog,
    ensureCallLog,
    reconcileLog,
    dryRunAuditLog,
    duplicateCleanupLog,
  };
};

const runDriveSyncDryRunNoMutationCase = async () => {
  const { deps, mutationLog, ensureCallLog, reconcileLog, dryRunAuditLog } =
    createDriveSyncDeps();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USR-1", role: "Admin" };
    req.correlationId = "corr-drive-dryrun-1";
    next();
  });
  app.post("/api/drive-hierarchy/sync-db", createSyncDbHandler(deps));
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/drive-hierarchy/sync-db?dryRun=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.dryRun, true);
    assert.equal(payload.data.reconciliation.totalScanned, 6);
    assert.equal(payload.data.reconciliation.candidateMatches, 4);
    assert.equal(payload.data.reconciliation.attendanceWouldBackfill, 1);
    assert.equal(payload.data.reconciliation.geoWouldBackfill, 1);
    assert.equal(payload.data.reconciliation.refreshedLinksWouldChange, 1);
    assert.equal(payload.data.reconciliation.canonicalMappingsWouldChange, 0);
    assert.equal(payload.data.reconciliation.skippedAmbiguous, 1);
    assert.equal(payload.data.reconciliation.normalization.departmentsAnalyzed, 1);
    assert.equal(payload.data.reconciliation.normalization.dayFoldersDetected, 2);
    assert.equal(payload.data.reconciliation.normalization.duplicateDayFolders, 1);
    assert.equal(payload.data.reconciliation.normalization.proposedActions.move, 1);
    assert.ok(Array.isArray(payload.data.reconciliation.warnings));
    assert.equal(reconcileLog[0]?.dryRun, true);
    assert.equal(mutationLog.length, 0);
    assert.equal(ensureCallLog.length, 0);
    assert.equal(dryRunAuditLog.length, 1);
    assert.equal(dryRunAuditLog[0]?.dryRun, true);
    assert.equal(dryRunAuditLog[0]?.correlationId, "corr-drive-dryrun-1");
    assert.equal(dryRunAuditLog[0]?.actor?.userId, "USR-1");
    assert.equal(dryRunAuditLog[0]?.actor?.role, "Admin");
    assert.equal(dryRunAuditLog[0]?.summary?.totalScanned, 6);
  } finally {
    await stopServer(server);
  }
};

const runDriveSyncNormalMutationParityCase = async () => {
  const { deps, mutationLog, ensureCallLog, reconcileLog, dryRunAuditLog } =
    createDriveSyncDeps();
  const app = express();
  app.use(express.json());
  app.post("/api/drive-hierarchy/sync-db", createSyncDbHandler(deps));
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/drive-hierarchy/sync-db`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.companiesSynced, 1);
    assert.equal(payload.data.coursesSynced, 1);
    assert.equal(payload.data.collegesSynced, 1);
    assert.equal(payload.data.departmentsSynced, 1);
    assert.equal(payload.data.reconciliation.totalScanned, 6);
    assert.equal(payload.data.reconciliation.attendanceBackfilled, 1);
    assert.equal(payload.data.reconciliation.geoTagBackfilled, 1);
    assert.equal(payload.data.reconciliation.refreshedLinks, 1);
    assert.equal(payload.data.reconciliation.canonicalMappingsUpdated, 0);
    assert.equal(reconcileLog[0]?.dryRun, false);
    assert.ok(mutationLog.length > 0);
    assert.ok(ensureCallLog.length > 0);
    assert.equal(dryRunAuditLog.length, 0);
  } finally {
    await stopServer(server);
  }
};

const runDriveSyncDryRunMixedCandidateSummaryCase = async () => {
  const { deps } = createDriveSyncDeps({
    onReconcile: async ({ summary, dryRun }) => {
      assert.equal(dryRun, true);
      summary.totalScanned += 12;
      summary.candidateMatches += 7;
      summary.attendanceWouldBackfill += 2;
      summary.geoWouldBackfill += 3;
      summary.refreshedLinksWouldChange += 2;
      summary.unchanged += 1;
      summary.schedulesReconciled += 2;
    },
  });
  const app = express();
  app.use(express.json());
  app.post("/api/drive-hierarchy/sync-db", createSyncDbHandler(deps));
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/drive-hierarchy/sync-db?dryRun=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.data.reconciliation.totalScanned, 12);
    assert.equal(payload.data.reconciliation.candidateMatches, 7);
    assert.equal(payload.data.reconciliation.attendanceWouldBackfill, 2);
    assert.equal(payload.data.reconciliation.geoWouldBackfill, 3);
    assert.equal(payload.data.reconciliation.refreshedLinksWouldChange, 2);
  } finally {
    await stopServer(server);
  }
};

const runDriveSyncDryRunAmbiguousSkipCase = async () => {
  const { deps } = createDriveSyncDeps({
    onReconcile: async ({ summary, dryRun }) => {
      assert.equal(dryRun, true);
      summary.totalScanned += 3;
      summary.skippedAmbiguous += 2;
      summary.candidateMatches += 1;
      summary.warnings.push("Skipped ambiguous legacy matches");
      summary.schedulesReconciled += 1;
    },
  });
  const app = express();
  app.use(express.json());
  app.post("/api/drive-hierarchy/sync-db", createSyncDbHandler(deps));
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/drive-hierarchy/sync-db?dryRun=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.data.reconciliation.skippedAmbiguous, 2);
    assert.ok(
      payload.data.reconciliation.warnings.some((item) =>
        String(item).toLowerCase().includes("ambiguous"),
      ),
    );
  } finally {
    await stopServer(server);
  }
};

const runDriveSyncNormalizeDuplicatesCase = async () => {
  const {
    deps,
    duplicateCleanupLog,
  } = createDriveSyncDeps();
  const app = express();
  app.use(express.json());
  app.post("/api/drive-hierarchy/sync-db", createSyncDbHandler(deps));
  const { server, baseUrl } = await startServer(app);

  try {
    const dryRunResponse = await fetch(
      `${baseUrl}/api/drive-hierarchy/sync-db?dryRun=true&normalizeDuplicates=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: "COMP-1",
          courseId: "COURSE-1",
          collegeId: "COLLEGE-1",
          departmentId: "DEPT-1",
        }),
      },
    );
    const dryRunPayload = await dryRunResponse.json();

    assert.equal(dryRunResponse.status, 200);
    assert.equal(dryRunPayload.success, true);
    assert.equal(dryRunPayload.data.dryRun, true);
    assert.equal(dryRunPayload.data.normalizeDuplicates, true);
    assert.equal(dryRunPayload.data.reconciliation.duplicateDayFoldersWouldClear, 1);
    assert.equal(dryRunPayload.data.reconciliation.canonicalMappingsWouldChange, 2);

    const normalResponse = await fetch(
      `${baseUrl}/api/drive-hierarchy/sync-db?normalizeDuplicates=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: "COMP-1",
          courseId: "COURSE-1",
          collegeId: "COLLEGE-1",
          departmentId: "DEPT-1",
        }),
      },
    );
    const normalPayload = await normalResponse.json();

    assert.equal(normalResponse.status, 200);
    assert.equal(normalPayload.success, true);
    assert.equal(normalPayload.data.normalizeDuplicates, true);
    assert.equal(normalPayload.data.reconciliation.duplicateDayFoldersCleared, 0);
    assert.equal(normalPayload.data.reconciliation.canonicalMappingsUpdated, 2);
    assert.equal(duplicateCleanupLog.length, 2);
    assert.equal(duplicateCleanupLog[0]?.dryRun, true);
    assert.equal(duplicateCleanupLog[1]?.dryRun, false);
  } finally {
    await stopServer(server);
  }
};

const runDriveSyncCanonicalMappingsOnlyModeCase = async () => {
  const { deps, ensureCallLog, reconcileLog, mutationLog } = createDriveSyncDeps();
  const app = express();
  app.use(express.json());
  app.post("/api/drive-hierarchy/sync-db", createSyncDbHandler(deps));
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/drive-hierarchy/sync-db?canonicalMappingsOnly=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: "COMP-1",
          courseId: "COURSE-1",
          collegeId: "COLLEGE-1",
          departmentId: "DEPT-1",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.canonicalMappingsOnly, true);
    assert.equal(payload.data.reconciliation.totalScanned, 0);
    assert.equal(payload.data.reconciliation.attendanceBackfilled, 0);
    assert.equal(payload.data.reconciliation.geoTagBackfilled, 0);
    assert.equal(payload.data.reconciliation.refreshedLinks, 0);
    assert.equal(payload.data.reconciliation.canonicalMappingsUpdated, 2);
    assert.equal(payload.data.reconciliation.duplicateDayFoldersCleared, 0);
    assert.equal(payload.data.canonicalMapping.canonicalMappingsUpdated, 2);
    assert.equal(payload.data.canonicalMapping.canonicalMappingsWouldChange, 0);
    assert.ok(payload.data.canonicalMapping.unchanged >= 0);
    assert.equal(reconcileLog.length, 0);
    assert.equal(ensureCallLog.length, 0);
    assert.ok(mutationLog.includes("department:save"));
    assert.ok(mutationLog.includes("schedule:bulkWrite"));
  } finally {
    await stopServer(server);
  }
};

const runDriveSyncNormalizeDuplicatesIdempotentCase = async () => {
  const { deps } = createDriveSyncDeps();
  const app = express();
  app.use(express.json());
  app.post("/api/drive-hierarchy/sync-db", createSyncDbHandler(deps));
  const { server, baseUrl } = await startServer(app);

  try {
    const firstResponse = await fetch(
      `${baseUrl}/api/drive-hierarchy/sync-db?normalizeDuplicates=true&canonicalMappingsOnly=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: "COMP-1",
          courseId: "COURSE-1",
          collegeId: "COLLEGE-1",
          departmentId: "DEPT-1",
        }),
      },
    );
    const firstPayload = await firstResponse.json();

    const secondResponse = await fetch(
      `${baseUrl}/api/drive-hierarchy/sync-db?normalizeDuplicates=true&canonicalMappingsOnly=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: "COMP-1",
          courseId: "COURSE-1",
          collegeId: "COLLEGE-1",
          departmentId: "DEPT-1",
        }),
      },
    );
    const secondPayload = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(firstPayload.success, true);
    assert.equal(firstPayload.data.reconciliation.canonicalMappingsUpdated, 2);
    assert.equal(firstPayload.data.reconciliation.duplicateDayFoldersCleared, 0);

    assert.equal(secondResponse.status, 200);
    assert.equal(secondPayload.success, true);
    assert.equal(secondPayload.data.reconciliation.canonicalMappingsUpdated, 0);
    assert.equal(secondPayload.data.canonicalMapping.canonicalMappingsUpdated, 0);
    assert.ok(secondPayload.data.canonicalMapping.unchanged > 0);
    assert.equal(secondPayload.data.reconciliation.duplicateDayFoldersCleared, 0);
  } finally {
    await stopServer(server);
  }
};

const runDriveSyncCanonicalOnlyDryRunIdempotentCase = async () => {
  const { deps, mutationLog } = createDriveSyncDeps();
  const app = express();
  app.use(express.json());
  app.post("/api/drive-hierarchy/sync-db", createSyncDbHandler(deps));
  const { server, baseUrl } = await startServer(app);

  try {
    const endpoint =
      `${baseUrl}/api/drive-hierarchy/sync-db?canonicalMappingsOnly=true&dryRun=true`;

    const firstResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
      }),
    });
    const firstPayload = await firstResponse.json();

    const secondResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
      }),
    });
    const secondPayload = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstPayload.success, true);
    assert.equal(secondPayload.success, true);
    assert.equal(firstPayload.data.dryRun, true);
    assert.equal(secondPayload.data.dryRun, true);
    assert.equal(firstPayload.data.canonicalMappingsOnly, true);
    assert.equal(secondPayload.data.canonicalMappingsOnly, true);
    assert.equal(firstPayload.data.canonicalMapping.canonicalMappingsUpdated, 0);
    assert.equal(secondPayload.data.canonicalMapping.canonicalMappingsUpdated, 0);
    assert.deepEqual(firstPayload.data.canonicalMapping, secondPayload.data.canonicalMapping);
    assert.equal(mutationLog.length, 0);
  } finally {
    await stopServer(server);
  }
};

const runAttendanceAdminUploadCanonicalAttendanceFolderPrecedenceCase = async () => {
  const { router, uploadCalls, canonicalSchedule, cleanup } =
    loadAttendanceRouterWithDriveMocks({
      scenario: "attendance-doc",
      scheduleFolders: {
        attendanceFolderId: "ATT-CANON-PRIORITY",
        geoTagFolderId: "GEO-CANON-PRIORITY",
      },
    });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USR-ADMIN-1", role: "SuperAdmin" };
    next();
  });
  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/admin-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduleId: canonicalSchedule._id,
        trainerId: "TRN-1",
        collegeId: "COL-1",
      }),
    });
    const payload = await response.json();
    await waitForAsyncTicks();

    if (response.status !== 200) {
      throw new Error(
        `unexpected upload-image status ${response.status}: ${JSON.stringify(payload)}`,
      );
    }

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.ok(uploadCalls.length >= 1);
    assert.equal(
      uploadCalls[0].folderId,
      "ATT-CANON-PRIORITY",
      "attendance upload must target canonical attendanceFolderId",
    );
    assert.notEqual(uploadCalls[0].folderId, "ATT-FALLBACK-DUPLICATE");
  } finally {
    await stopServer(server);
    cleanup();
  }
};

const runAttendanceAdminUploadCanonicalGeoFolderPrecedenceCase = async () => {
  const { router, uploadCalls, canonicalSchedule, cleanup } =
    loadAttendanceRouterWithDriveMocks({
      scenario: "checkout-geo",
      scheduleFolders: {
        attendanceFolderId: "ATT-CANON-PRIORITY",
        geoTagFolderId: "GEO-CANON-PRIORITY",
      },
    });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USR-ADMIN-1", role: "SuperAdmin" };
    next();
  });
  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/admin-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduleId: canonicalSchedule._id,
        trainerId: "TRN-1",
        collegeId: "COL-1",
      }),
    });
    const payload = await response.json();
    await waitForAsyncTicks();

    if (response.status !== 200) {
      throw new Error(
        `unexpected upload-image status ${response.status}: ${JSON.stringify(payload)}`,
      );
    }

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.ok(uploadCalls.length >= 1);
    assert.equal(
      uploadCalls[0].folderId,
      "GEO-CANON-PRIORITY",
      "checkout geo upload must target canonical geoTagFolderId",
    );
    assert.notEqual(uploadCalls[0].folderId, "GEO-FALLBACK-DUPLICATE");
  } finally {
    await stopServer(server);
    cleanup();
  }
};

const runAttendanceTrainerGeoSlotUploadCanonicalGeoFolderPrecedenceCase = async () => {
  const { router, uploadCalls, canonicalSchedule, cleanup } =
    loadAttendanceRouterWithDriveMocks({
      scenario: "geo-slot-upload",
      scheduleFolders: {
        attendanceFolderId: "ATT-CANON-PRIORITY",
        geoTagFolderId: "GEO-CANON-PRIORITY",
        collegeLocation: { latitude: 11.11, longitude: 78.11 },
      },
    });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USR-TRAINER-1", role: "Trainer" };
    next();
  });
  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/upload-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trainerId: "TRN001",
        scheduleId: canonicalSchedule._id,
        assignedDate: "2026-04-09",
        index: 0,
      }),
    });
    const payload = await response.json();
    await waitForAsyncTicks();

    if (response.status !== 200) {
      throw new Error(
        `unexpected upload-image status ${response.status}: ${JSON.stringify(payload)}`,
      );
    }

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.ok(uploadCalls.length >= 1);
    assert.equal(
      uploadCalls[0].folderId,
      "GEO-CANON-PRIORITY",
      "trainer geo-slot upload must target canonical geoTagFolderId",
    );
    assert.equal(
      uploadCalls.some((call) => call.folderId === "GEO-FALLBACK-DUPLICATE"),
      false,
      "fallback duplicate GeoTag folders must not be selected when canonical geoTagFolderId exists",
    );
  } finally {
    await stopServer(server);
    cleanup();
  }
};

const runAttendanceScheduleLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/schedule/:scheduleId",
    createAttendanceScheduleController({
      getAttendanceSchedulePayload: async ({ scheduleId }) => {
        assert.equal(scheduleId, "SCH-ATT-1001");
        return {
          success: true,
          data: [
            { _id: "ATT-1", scheduleId: "SCH-ATT-1001" },
            { _id: "ATT-2", scheduleId: "SCH-ATT-1001" },
          ],
        };
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/schedule/SCH-ATT-1001`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: [
        { _id: "ATT-1", scheduleId: "SCH-ATT-1001" },
        { _id: "ATT-2", scheduleId: "SCH-ATT-1001" },
      ],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceScheduleNoAuthAccessParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/schedule/:scheduleId",
    createAttendanceScheduleController({
      getAttendanceSchedulePayload: async () => ({
        success: true,
        data: [],
      }),
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/schedule/SCH-ATT-NOAUTH`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceScheduleNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/schedule/:scheduleId",
    createAttendanceScheduleController({
      getAttendanceSchedulePayload: async () => ({
        success: true,
        data: [],
      }),
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/schedule/SCH-ATT-EMPTY`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceScheduleInvalidIdErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const castErrorMessage =
    'Cast to ObjectId failed for value "bad-id" (type string) at path "scheduleId" for model "Attendance"';
  const originalConsoleError = console.error;

  router.get(
    "/schedule/:scheduleId",
    createAttendanceScheduleController({
      getAttendanceSchedulePayload: async () => {
        throw new Error(castErrorMessage);
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/schedule/bad-id`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance",
      error: castErrorMessage,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAttendanceScheduleErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.get(
    "/schedule/:scheduleId",
    createAttendanceScheduleController({
      getAttendanceSchedulePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/schedule/SCH-ATT-500`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAttendanceDetailsLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/:id/details",
    createAttendanceLegacyDetailsController({
      getAttendanceLegacyDetailsPayload: async ({ attendanceId }) => {
        assert.equal(attendanceId, "ATT-DETAIL-1001");
        return {
          success: true,
          data: {
            _id: "ATT-DETAIL-1001",
            status: "approved",
            verificationStatus: "approved",
          },
        };
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/ATT-DETAIL-1001/details`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: {
        _id: "ATT-DETAIL-1001",
        status: "approved",
        verificationStatus: "approved",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceDetailsNoAuthAccessParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/:id/details",
    createAttendanceLegacyDetailsController({
      getAttendanceLegacyDetailsPayload: async () => ({
        success: true,
        data: { _id: "ATT-DETAIL-NOAUTH" },
      }),
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/ATT-DETAIL-NOAUTH/details`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: { _id: "ATT-DETAIL-NOAUTH" },
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceDetailsNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/:id/details",
    createAttendanceLegacyDetailsController({
      getAttendanceLegacyDetailsPayload: async () => {
        const error = new Error("Attendance not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/ATT-DETAIL-404/details`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Attendance not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceDetailsInvalidIdErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const castErrorMessage =
    'Cast to ObjectId failed for value "bad-id" (type string) at path "_id" for model "Attendance"';
  const originalConsoleError = console.error;

  router.get(
    "/:id/details",
    createAttendanceLegacyDetailsController({
      getAttendanceLegacyDetailsPayload: async () => {
        throw new Error(castErrorMessage);
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/bad-id/details`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance details",
      error: castErrorMessage,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAttendanceDetailsErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.get(
    "/:id/details",
    createAttendanceLegacyDetailsController({
      getAttendanceLegacyDetailsPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/ATT-DETAIL-500/details`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance details",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAttendanceTrainerLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/trainer/:trainerId",
    createAttendanceTrainerController({
      getAttendanceTrainerPayload: async ({ trainerId, month, year }) => {
        assert.equal(trainerId, "TRN-ATT-1001");
        assert.equal(month, "4");
        assert.equal(year, "2026");
        return {
          success: true,
          count: 1,
          data: [{ _id: "ATT-T-1", trainerId: "TRN-ATT-1001" }],
        };
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/attendance/trainer/TRN-ATT-1001?month=4&year=2026`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      count: 1,
      data: [{ _id: "ATT-T-1", trainerId: "TRN-ATT-1001" }],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceTrainerNoAuthAccessParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/trainer/:trainerId",
    createAttendanceTrainerController({
      getAttendanceTrainerPayload: async () => ({
        success: true,
        count: 0,
        data: [],
      }),
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/trainer/TRN-ATT-NOAUTH`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      count: 0,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceTrainerNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/trainer/:trainerId",
    createAttendanceTrainerController({
      getAttendanceTrainerPayload: async () => ({
        success: true,
        count: 0,
        data: [],
      }),
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/trainer/TRN-ATT-EMPTY`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      count: 0,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceTrainerInvalidIdErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const castErrorMessage =
    'Cast to ObjectId failed for value "bad-id" (type string) at path "trainerId" for model "Attendance"';
  const originalConsoleError = console.error;

  router.get(
    "/trainer/:trainerId",
    createAttendanceTrainerController({
      getAttendanceTrainerPayload: async () => {
        throw new Error(castErrorMessage);
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/trainer/bad-id`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance",
      error: castErrorMessage,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAttendanceTrainerErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.get(
    "/trainer/:trainerId",
    createAttendanceTrainerController({
      getAttendanceTrainerPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/trainer/TRN-ATT-500`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAttendanceCollegeLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/college/:collegeId",
    createAttendanceCollegeController({
      getAttendanceCollegePayload: async ({ collegeId }) => {
        assert.equal(collegeId, "COL-ATT-1001");
        return {
          success: true,
          data: [{ _id: "ATT-C-1", collegeId: "COL-ATT-1001" }],
        };
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/college/COL-ATT-1001`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: [{ _id: "ATT-C-1", collegeId: "COL-ATT-1001" }],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceCollegeNoAuthAccessParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/college/:collegeId",
    createAttendanceCollegeController({
      getAttendanceCollegePayload: async () => ({
        success: true,
        data: [],
      }),
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/college/COL-ATT-NOAUTH`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceCollegeNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/college/:collegeId",
    createAttendanceCollegeController({
      getAttendanceCollegePayload: async () => ({
        success: true,
        data: [],
      }),
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/college/COL-ATT-EMPTY`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceCollegeInvalidIdErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const castErrorMessage =
    'Cast to ObjectId failed for value "bad-id" (type string) at path "collegeId" for model "Attendance"';
  const originalConsoleError = console.error;

  router.get(
    "/college/:collegeId",
    createAttendanceCollegeController({
      getAttendanceCollegePayload: async () => {
        throw new Error(castErrorMessage);
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/college/bad-id`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance",
      error: castErrorMessage,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAttendanceCollegeErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.get(
    "/college/:collegeId",
    createAttendanceCollegeController({
      getAttendanceCollegePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/college/COL-ATT-500`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAttendanceDocumentsLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/documents",
    createAttendanceDocumentsController({
      getAttendanceDocumentsPayload: async ({ filters }) => {
        assert.deepEqual(filters, {
          scheduleId: "507f1f77bcf86cd799439011",
          attendanceId: "507f1f77bcf86cd799439012",
          trainerId: "507f1f77bcf86cd799439013",
          status: "pending",
          fileType: "attendance",
        });

        return {
          success: true,
          count: 1,
          data: [{ _id: "DOC-ATT-1", status: "pending", fileType: "attendance" }],
        };
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/attendance/documents?scheduleId=507f1f77bcf86cd799439011&attendanceId=507f1f77bcf86cd799439012&trainerId=507f1f77bcf86cd799439013&status=PENDING&fileType=ATTENDANCE`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      count: 1,
      data: [{ _id: "DOC-ATT-1", status: "pending", fileType: "attendance" }],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceDocumentsNoAuthAccessParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/documents",
    createAttendanceDocumentsController({
      getAttendanceDocumentsPayload: async () => ({
        success: true,
        count: 0,
        data: [],
      }),
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/documents`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      count: 0,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceDocumentsInvalidObjectIdParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get("/documents", createAttendanceDocumentsController());

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/documents?scheduleId=bad-id`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid scheduleId",
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceDocumentsInvalidStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get("/documents", createAttendanceDocumentsController());

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/documents?status=unknown`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid status filter. Use pending, verified, or rejected.",
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceDocumentsInvalidFileTypeParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get("/documents", createAttendanceDocumentsController());

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/documents?fileType=xyz`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid fileType filter. Use attendance, geotag, or other.",
    });
  } finally {
    await stopServer(server);
  }
};

const runAttendanceDocumentsErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.get(
    "/documents",
    createAttendanceDocumentsController({
      getAttendanceDocumentsPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/attendance", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/documents`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch attendance documents",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runScheduleDetailsSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/:id",
    createScheduleDetailsController({
      getScheduleDetailFeed: async ({ scheduleId }) => ({
        _id: scheduleId,
        status: "scheduled",
        verificationStatus: "pending",
        attendancePdfUrl: "attendance-day-1.pdf",
        collegeId: { _id: "COL-101", name: "MBK College" },
      }),
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-1001`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, {
      _id: "SCH-1001",
      status: "scheduled",
      verificationStatus: "pending",
      attendancePdfUrl: "attendance-day-1.pdf",
      collegeId: { _id: "COL-101", name: "MBK College" },
    });
  } finally {
    await stopServer(server);
  }
};

const runScheduleDetailsNotFoundCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/:id",
    createScheduleDetailsController({
      getScheduleDetailFeed: async () => null,
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-404`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Schedule not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runScheduleDetailsInvalidIdParityCase = async () => {
  const app = express();
  const router = express.Router();
  const castErrorMessage =
    'Cast to ObjectId failed for value "invalid-id" (type string) at path "_id" for model "Schedule"';
  const originalConsoleError = console.error;

  router.get(
    "/:id",
    createScheduleDetailsController({
      getScheduleDetailFeed: async () => {
        throw new Error(castErrorMessage);
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/schedules/invalid-id`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.equal(payload.success, false);
    assert.equal(payload.message, "Failed to fetch schedule");
    assert.equal(payload.error, castErrorMessage);
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runScheduleAssociationsSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/associations/all",
    createScheduleAssociationsController({
      getScheduleAssociationsFeed: async () => ({
        success: true,
        data: {
          companies: [{ id: "COMP-1", name: "Company One" }],
          courses: [{ id: "COURSE-1", name: "Course One", companyId: "COMP-1" }],
          colleges: [{ id: "COL-1", name: "College One", companyId: "COMP-1", courseId: "COURSE-1" }],
          departments: [{ id: "DEP-1", name: "CSE", companyId: "COMP-1", courseId: "COURSE-1", collegeId: "COL-1" }],
        },
      }),
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/associations/all`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, {
      companies: [{ id: "COMP-1", name: "Company One" }],
      courses: [{ id: "COURSE-1", name: "Course One", companyId: "COMP-1" }],
      colleges: [{ id: "COL-1", name: "College One", companyId: "COMP-1", courseId: "COURSE-1" }],
      departments: [{ id: "DEP-1", name: "CSE", companyId: "COMP-1", courseId: "COURSE-1", collegeId: "COL-1" }],
    });
  } finally {
    await stopServer(server);
  }
};

const runScheduleAssociationsEmptyStateCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/associations/all",
    createScheduleAssociationsController({
      getScheduleAssociationsFeed: async () => ({
        success: true,
        data: {
          companies: [],
          courses: [],
          colleges: [],
          departments: [],
        },
      }),
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/associations/all`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, {
      companies: [],
      courses: [],
      colleges: [],
      departments: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runScheduleAssociationsErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const message = "Associations dependency failed";

  router.get(
    "/associations/all",
    createScheduleAssociationsController({
      getScheduleAssociationsFeed: async () => {
        throw new Error(message);
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);
  const originalConsoleError = console.error;

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/schedules/associations/all`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch associations",
      error: message,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAssignScheduleSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-SPOC-1" };
    req.app.set("io", { id: "SOCKET-SERVER" });
    next();
  });

  router.put(
    "/:id/assign",
    createAssignScheduleController({
      getAssignScheduleFeed: async ({ scheduleId, payload, actorUserId, io }) => {
        assert.equal(scheduleId, "SCH-9001");
        assert.equal(actorUserId, "USER-SPOC-1");
        assert.equal(io?.id, "SOCKET-SERVER");
        assert.deepEqual(payload, {
          trainerId: "TRN-5001",
          scheduledDate: "2026-04-15",
          startTime: "09:30",
          endTime: "11:30",
        });

        return {
          success: true,
          message: "Schedule assigned successfully",
          data: {
            _id: "SCH-9001",
            trainerId: "TRN-5001",
            scheduledDate: "2026-04-15",
            startTime: "09:30",
            endTime: "11:30",
            status: "scheduled",
          },
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-9001/assign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trainerId: "TRN-5001",
        scheduledDate: "2026-04-15",
        startTime: "09:30",
        endTime: "11:30",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      message: "Schedule assigned successfully",
      data: {
        _id: "SCH-9001",
        trainerId: "TRN-5001",
        scheduledDate: "2026-04-15",
        startTime: "09:30",
        endTime: "11:30",
        status: "scheduled",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runCreateScheduleSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-SPOC-1" };
    req.app.set("io", { id: "SOCKET-SERVER" });
    next();
  });

  router.post(
    "/create",
    createCreateScheduleController({
      getCreateScheduleFeed: async ({ payload, actorUserId, io }) => {
        assert.equal(actorUserId, "USER-SPOC-1");
        assert.equal(io?.id, "SOCKET-SERVER");
        assert.deepEqual(payload, {
          trainerId: "TRN-1001",
          companyId: "COMP-1",
          courseId: "COURSE-1",
          collegeId: "COLLEGE-1",
          departmentId: "DEPT-1",
          dayNumber: 3,
          scheduledDate: "2026-05-01",
          startTime: "09:00",
          endTime: "11:00",
          subject: "Aptitude",
          createdBy: undefined,
        });

        return {
          responsePayload: {
            success: true,
            message: "Schedule created successfully",
            data: {
              _id: "SCH-CREATE-1",
              status: "scheduled",
            },
          },
          sideEffectTask: Promise.resolve(),
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trainerId: "TRN-1001",
        companyId: "COMP-1",
        courseId: "COURSE-1",
        collegeId: "COLLEGE-1",
        departmentId: "DEPT-1",
        dayNumber: 3,
        scheduledDate: "2026-05-01",
        startTime: "09:00",
        endTime: "11:00",
        subject: "Aptitude",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(payload, {
      success: true,
      message: "Schedule created successfully",
      data: {
        _id: "SCH-CREATE-1",
        status: "scheduled",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runCreateSchedulePermissivePayloadCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  router.post(
    "/create",
    createCreateScheduleController({
      getCreateScheduleFeed: async ({ payload, actorUserId }) => {
        assert.equal(actorUserId, null);
        assert.deepEqual(payload, {
          trainerId: undefined,
          companyId: undefined,
          courseId: undefined,
          collegeId: undefined,
          departmentId: undefined,
          dayNumber: undefined,
          scheduledDate: undefined,
          startTime: undefined,
          endTime: undefined,
          subject: undefined,
          createdBy: "USER-BODY-1",
        });

        return {
          responsePayload: {
            success: true,
            message: "Schedule created successfully",
            data: { _id: "SCH-CREATE-2" },
          },
          sideEffectTask: Promise.resolve(),
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdBy: "USER-BODY-1" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(payload, {
      success: true,
      message: "Schedule created successfully",
      data: { _id: "SCH-CREATE-2" },
    });
  } finally {
    await stopServer(server);
  }
};

const runCreateScheduleErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const message = "create dependency failed";
  const originalConsoleError = console.error;

  app.use(express.json());

  router.post(
    "/create",
    createCreateScheduleController({
      getCreateScheduleFeed: async () => {
        throw new Error(message);
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/schedules/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to create schedule",
      error: message,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runBulkCreateScheduleSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-SPOC-BULK" };
    req.app.set("io", { id: "SOCKET-SERVER" });
    next();
  });

  router.post(
    "/bulk-create",
    createBulkCreateScheduleController({
      getBulkCreateSchedulesFeed: async ({ payload, actorUserId, io }) => {
        assert.equal(actorUserId, "USER-SPOC-BULK");
        assert.equal(io?.id, "SOCKET-SERVER");
        assert.equal(Array.isArray(payload?.schedules), true);
        assert.equal(payload?.createdBy, "USER-CREATED-BY");

        return {
          statusCode: 200,
          responsePayload: {
            success: true,
            message: "1 schedules created, 1 schedules updated",
            inserted: 1,
            updated: 1,
            skipped: 0,
            skippedDetails: [],
            data: [{ _id: "SCH-BULK-1" }, { _id: "SCH-BULK-2" }],
          },
          sideEffectTask: Promise.resolve(),
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/bulk-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        createdBy: "USER-CREATED-BY",
        schedules: [
          {
            trainerId: "TRN-1",
            collegeId: "COL-1",
            dayNumber: 1,
            scheduledDate: "2026-05-01",
            startTime: "09:00",
            endTime: "11:00",
          },
        ],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.inserted, 1);
    assert.equal(payload.updated, 1);
    assert.equal(Array.isArray(payload.data), true);
  } finally {
    await stopServer(server);
  }
};

const runBulkCreateScheduleValidationParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  router.post(
    "/bulk-create",
    createBulkCreateScheduleController({
      getBulkCreateSchedulesFeed: async () => {
        const error = new Error("Schedules array is required");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/bulk-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedules: [] }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Schedules array is required",
    });
  } finally {
    await stopServer(server);
  }
};

const runBulkCreateScheduleErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const message = "bulk create dependency failed";
  const originalConsoleError = console.error;

  app.use(express.json());

  router.post(
    "/bulk-create",
    createBulkCreateScheduleController({
      getBulkCreateSchedulesFeed: async () => {
        throw new Error(message);
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/schedules/bulk-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedules: [{}] }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to create schedules",
      error: message,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runBulkUploadScheduleSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-SPOC-UPLOAD", name: "SPOC Upload" };
    next();
  });

  router.post(
    "/bulk-upload",
    createBulkUploadScheduleController({
      uploadSingleLoader: (req, _res, callback) => {
        req.file = { path: "/tmp/bulk-upload.xlsx", originalname: "bulk-upload.xlsx" };
        callback();
      },
      getBulkUploadSchedulesFeed: async ({ payload, actorUserId, actorUserName }) => {
        assert.equal(payload?.file?.path, "/tmp/bulk-upload.xlsx");
        assert.equal(payload?.user?.id, "USER-SPOC-UPLOAD");
        assert.equal(actorUserId, "USER-SPOC-UPLOAD");
        assert.equal(actorUserName, "SPOC Upload");

        return {
          statusCode: 200,
          responsePayload: {
            success: true,
            inserted: 1,
            skipped: 0,
            skippedDetails: [],
            data: {
              success: 1,
              failed: 0,
              errors: [],
            },
          },
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/bulk-upload`, {
      method: "POST",
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      inserted: 1,
      skipped: 0,
      skippedDetails: [],
      data: {
        success: 1,
        failed: 0,
        errors: [],
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runBulkUploadScheduleUploadErrorParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  router.post(
    "/bulk-upload",
    createBulkUploadScheduleController({
      uploadSingleLoader: (_req, _res, callback) => {
        callback(new Error("invalid mimetype"));
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/bulk-upload`, {
      method: "POST",
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Upload failed",
      error: "invalid mimetype",
    });
  } finally {
    await stopServer(server);
  }
};

const runBulkUploadScheduleValidationParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  router.post(
    "/bulk-upload",
    createBulkUploadScheduleController({
      uploadSingleLoader: (_req, _res, callback) => {
        callback();
      },
      getBulkUploadSchedulesFeed: async () => {
        const error = new Error("No file uploaded");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/bulk-upload`, {
      method: "POST",
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "No file uploaded",
    });
  } finally {
    await stopServer(server);
  }
};

const runBulkUploadScheduleErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const message = "bulk upload dependency failed";
  const originalConsoleError = console.error;

  app.use(express.json());

  router.post(
    "/bulk-upload",
    createBulkUploadScheduleController({
      uploadSingleLoader: (req, _res, callback) => {
        req.file = { path: "/tmp/bulk-upload-fail.xlsx", originalname: "bulk-upload-fail.xlsx" };
        callback();
      },
      getBulkUploadSchedulesFeed: async () => {
        throw new Error(message);
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/schedules/bulk-upload`, {
      method: "POST",
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Server error",
      error: message,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runAssignSchedulePermissiveBodyCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-SPOC-2" };
    next();
  });

  router.put(
    "/:id/assign",
    createAssignScheduleController({
      getAssignScheduleFeed: async ({ payload }) => {
        assert.deepEqual(payload, {
          trainerId: undefined,
          scheduledDate: undefined,
          startTime: undefined,
          endTime: undefined,
        });

        return {
          success: true,
          message: "Schedule assigned successfully",
          data: {
            _id: "SCH-9002",
          },
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-9002/assign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      message: "Schedule assigned successfully",
      data: {
        _id: "SCH-9002",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runAssignScheduleNotFoundCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  router.put(
    "/:id/assign",
    createAssignScheduleController({
      getAssignScheduleFeed: async () => {
        const error = new Error("Schedule not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-404/assign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trainerId: "TRN-404",
        scheduledDate: "2026-04-20",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Schedule not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runAssignScheduleErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const message = "assign dependency failed";
  const originalConsoleError = console.error;

  app.use(express.json());

  router.put(
    "/:id/assign",
    createAssignScheduleController({
      getAssignScheduleFeed: async () => {
        throw new Error(message);
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/schedules/SCH-500/assign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trainerId: "TRN-500",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Error assigning schedule",
      error: message,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runUpdateScheduleSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.app.set("io", { id: "SOCKET-SERVER" });
    next();
  });

  router.put(
    "/:id",
    createUpdateScheduleController({
      getUpdateScheduleFeed: async ({ scheduleId, payload, io }) => {
        assert.equal(scheduleId, "SCH-UPDATE-1");
        assert.equal(io?.id, "SOCKET-SERVER");
        assert.deepEqual(payload, {
          trainerId: "TRN-UPDATE-1",
          scheduledDate: "2026-04-30",
          startTime: "09:00",
          endTime: "11:00",
          status: "scheduled",
          subject: "Communication",
        });

        return {
          success: true,
          message: "Schedule updated successfully",
          data: {
            _id: "SCH-UPDATE-1",
            trainerId: "TRN-UPDATE-1",
            scheduledDate: "2026-04-30",
            startTime: "09:00",
            endTime: "11:00",
            status: "scheduled",
            subject: "Communication",
          },
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-UPDATE-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trainerId: "TRN-UPDATE-1",
        scheduledDate: "2026-04-30",
        startTime: "09:00",
        endTime: "11:00",
        status: "scheduled",
        subject: "Communication",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      message: "Schedule updated successfully",
      data: {
        _id: "SCH-UPDATE-1",
        trainerId: "TRN-UPDATE-1",
        scheduledDate: "2026-04-30",
        startTime: "09:00",
        endTime: "11:00",
        status: "scheduled",
        subject: "Communication",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runUpdateSchedulePermissiveBodyCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  router.put(
    "/:id",
    createUpdateScheduleController({
      getUpdateScheduleFeed: async ({ payload }) => {
        assert.deepEqual(payload, {});
        return {
          success: true,
          message: "Schedule updated successfully",
          data: { _id: "SCH-UPDATE-2" },
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-UPDATE-2`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      message: "Schedule updated successfully",
      data: { _id: "SCH-UPDATE-2" },
    });
  } finally {
    await stopServer(server);
  }
};

const runUpdateScheduleNotFoundCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  router.put(
    "/:id",
    createUpdateScheduleController({
      getUpdateScheduleFeed: async () => {
        const error = new Error("Schedule not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-UPDATE-404`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trainerId: "TRN-X" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Schedule not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runUpdateScheduleErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const message = "update dependency failed";
  const originalConsoleError = console.error;

  app.use(express.json());

  router.put(
    "/:id",
    createUpdateScheduleController({
      getUpdateScheduleFeed: async () => {
        throw new Error(message);
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/schedules/SCH-UPDATE-500`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trainerId: "TRN-X" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to update schedule",
      error: message,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDeleteScheduleSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.app.set("io", { id: "SOCKET-SERVER" });
    next();
  });

  router.delete(
    "/:id",
    createDeleteScheduleController({
      getDeleteScheduleFeed: async ({ scheduleId, payload, io }) => {
        assert.equal(scheduleId, "SCH-DELETE-1");
        assert.equal(io?.id, "SOCKET-SERVER");
        assert.deepEqual(payload, {
          reason: "Trainer unavailable",
        });

        return {
          success: true,
          message: "Schedule deleted successfully",
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-DELETE-1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Trainer unavailable" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      message: "Schedule deleted successfully",
    });
  } finally {
    await stopServer(server);
  }
};

const runDeleteScheduleReasonPrecedenceCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());

  router.delete(
    "/:id",
    createDeleteScheduleController({
      getDeleteScheduleFeed: async ({ payload }) => {
        assert.deepEqual(payload, {
          reason: "Body reason takes precedence",
        });

        return {
          success: true,
          message: "Schedule deleted successfully",
        };
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/schedules/SCH-DELETE-2?reason=Query%20Reason`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Body reason takes precedence" }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      message: "Schedule deleted successfully",
    });
  } finally {
    await stopServer(server);
  }
};

const runDeleteScheduleNotFoundCase = async () => {
  const app = express();
  const router = express.Router();

  router.delete(
    "/:id",
    createDeleteScheduleController({
      getDeleteScheduleFeed: async () => {
        const error = new Error("Schedule not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/schedules/SCH-DELETE-404`, {
      method: "DELETE",
    });
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Schedule not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runDeleteScheduleErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const message = "delete dependency failed";
  const originalConsoleError = console.error;

  router.delete(
    "/:id",
    createDeleteScheduleController({
      getDeleteScheduleFeed: async () => {
        throw new Error(message);
      },
    }),
  );

  app.use("/api/schedules", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/schedules/SCH-DELETE-500`, {
      method: "DELETE",
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to delete schedule",
      error: message,
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatValidationLogsLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LOG-1" };
    next();
  });

  router.get(
    "/validation-logs",
    createChatValidationLogsController({
      getChatValidationLogsFeed: async ({ requesterId, query }) => {
        assert.equal(requesterId, "USER-CHAT-LOG-1");
        assert.deepEqual(query, {
          page: "2",
          limit: "15",
          action: "message_send",
          lane: undefined,
          status: undefined,
          source: undefined,
          chatId: undefined,
          roomId: undefined,
          channelId: "CHANNEL-LOG-1",
          senderId: undefined,
          role: undefined,
          from: undefined,
          to: undefined,
          userId: "USER-FILTER-LOG-1",
        });

        return {
          success: true,
          total: 1,
          page: 2,
          limit: 15,
          data: [
            {
              event: "message_send_succeeded",
              channelId: "CHANNEL-LOG-1",
            },
          ],
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/validation-logs?page=2&limit=15&action=message_send&channelId=CHANNEL-LOG-1&userId=USER-FILTER-LOG-1`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      total: 1,
      page: 2,
      limit: 15,
      data: [
        {
          event: "message_send_succeeded",
          channelId: "CHANNEL-LOG-1",
        },
      ],
    });
  } finally {
    await stopServer(server);
  }
};

const runChatValidationLogsAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/validation-logs",
    createChatValidationLogsController({
      getChatValidationLogsFeed: async () => {
        handlerInvoked = true;
        return {
          success: true,
          total: 0,
          page: 1,
          limit: 100,
          data: [],
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/validation-logs`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatValidationLogsNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { _id: "USER-CHAT-NOT-FOUND-1" };
    next();
  });

  router.get(
    "/validation-logs",
    createChatValidationLogsController({
      getChatValidationLogsFeed: async () => {
        const error = new Error("User not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/validation-logs`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "User not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatValidationLogsErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LOG-500" };
    next();
  });

  router.get(
    "/validation-logs",
    createChatValidationLogsController({
      getChatValidationLogsFeed: async () => {
        throw new Error("chat validation logs dependency failed");
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/validation-logs`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "chat validation logs dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatBootstrapLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-BOOTSTRAP-1" };
    next();
  });

  router.get(
    "/bootstrap",
    createChatBootstrapController({
      getChatBootstrapPayload: async ({ currentUserId }) => {
        assert.equal(currentUserId, "USER-CHAT-BOOTSTRAP-1");

        return {
          success: true,
          enabled: true,
          token: "token-bootstrap-1",
          apiKey: "stream-api-key",
          currentUser: {
            id: "USER-CHAT-BOOTSTRAP-1",
            name: "Bootstrap User",
            role: "Trainer",
          },
          users: {
            "USER-CHAT-BOOTSTRAP-1": {
              id: "USER-CHAT-BOOTSTRAP-1",
              name: "Bootstrap User",
              role: "Trainer",
            },
          },
          permissions: {
            canStartDirectChat: true,
          },
          directContacts: [],
          groupCandidates: [],
          channelIds: ["channel-bootstrap-1"],
          announcementChannel: { id: "announcement" },
          announcementChannelId: "announcement",
          bootstrap: {
            enabled: true,
            token: "token-bootstrap-1",
            apiKey: "stream-api-key",
            currentUser: {
              id: "USER-CHAT-BOOTSTRAP-1",
              name: "Bootstrap User",
              role: "Trainer",
            },
          },
          user: {
            id: "USER-CHAT-BOOTSTRAP-1",
            name: "Bootstrap User",
            role: "Trainer",
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      enabled: true,
      token: "token-bootstrap-1",
      apiKey: "stream-api-key",
      currentUser: {
        id: "USER-CHAT-BOOTSTRAP-1",
        name: "Bootstrap User",
        role: "Trainer",
      },
      users: {
        "USER-CHAT-BOOTSTRAP-1": {
          id: "USER-CHAT-BOOTSTRAP-1",
          name: "Bootstrap User",
          role: "Trainer",
        },
      },
      permissions: {
        canStartDirectChat: true,
      },
      directContacts: [],
      groupCandidates: [],
      channelIds: ["channel-bootstrap-1"],
      announcementChannel: { id: "announcement" },
      announcementChannelId: "announcement",
      bootstrap: {
        enabled: true,
        token: "token-bootstrap-1",
        apiKey: "stream-api-key",
        currentUser: {
          id: "USER-CHAT-BOOTSTRAP-1",
          name: "Bootstrap User",
          role: "Trainer",
        },
      },
      user: {
        id: "USER-CHAT-BOOTSTRAP-1",
        name: "Bootstrap User",
        role: "Trainer",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatBootstrapAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/bootstrap",
    createChatBootstrapController({
      getChatBootstrapPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatBootstrapUserNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-BOOTSTRAP-NOTFOUND" };
    next();
  });

  router.get(
    "/bootstrap",
    createChatBootstrapController({
      getChatBootstrapPayload: async () => {
        const error = new Error("User not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "User not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatBootstrapErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-BOOTSTRAP-500" };
    next();
  });

  router.get(
    "/bootstrap",
    createChatBootstrapController({
      getChatBootstrapPayload: async () => {
        throw new Error("bootstrap dependency failed");
      },
    }),
  );

  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      message: "bootstrap dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatQuickBootstrapLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-QUICK-BOOTSTRAP-1" };
    next();
  });

  router.get(
    "/quick-bootstrap",
    createChatQuickBootstrapController({
      getChatQuickBootstrapPayload: async ({ currentUserId }) => {
        assert.equal(currentUserId, "USER-CHAT-QUICK-BOOTSTRAP-1");

        return {
          success: true,
          enabled: true,
          token: "token-quick-bootstrap-1",
          apiKey: "stream-api-key",
          currentUser: {
            id: "USER-CHAT-QUICK-BOOTSTRAP-1",
            name: "Quick Bootstrap User",
            role: "Trainer",
          },
          users: {
            "USER-CHAT-QUICK-BOOTSTRAP-1": {
              id: "USER-CHAT-QUICK-BOOTSTRAP-1",
              name: "Quick Bootstrap User",
              role: "Trainer",
            },
          },
          permissions: {
            canStartDirectChat: true,
          },
          directContacts: [],
          groupCandidates: [],
          channelIds: ["channel-quick-bootstrap-1"],
          announcementChannel: { id: "announcement" },
          announcementChannelId: "announcement",
          bootstrap: {
            enabled: true,
            token: "token-quick-bootstrap-1",
            apiKey: "stream-api-key",
            currentUser: {
              id: "USER-CHAT-QUICK-BOOTSTRAP-1",
              name: "Quick Bootstrap User",
              role: "Trainer",
            },
          },
          user: {
            id: "USER-CHAT-QUICK-BOOTSTRAP-1",
            name: "Quick Bootstrap User",
            role: "Trainer",
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/quick-bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      enabled: true,
      token: "token-quick-bootstrap-1",
      apiKey: "stream-api-key",
      currentUser: {
        id: "USER-CHAT-QUICK-BOOTSTRAP-1",
        name: "Quick Bootstrap User",
        role: "Trainer",
      },
      users: {
        "USER-CHAT-QUICK-BOOTSTRAP-1": {
          id: "USER-CHAT-QUICK-BOOTSTRAP-1",
          name: "Quick Bootstrap User",
          role: "Trainer",
        },
      },
      permissions: {
        canStartDirectChat: true,
      },
      directContacts: [],
      groupCandidates: [],
      channelIds: ["channel-quick-bootstrap-1"],
      announcementChannel: { id: "announcement" },
      announcementChannelId: "announcement",
      bootstrap: {
        enabled: true,
        token: "token-quick-bootstrap-1",
        apiKey: "stream-api-key",
        currentUser: {
          id: "USER-CHAT-QUICK-BOOTSTRAP-1",
          name: "Quick Bootstrap User",
          role: "Trainer",
        },
      },
      user: {
        id: "USER-CHAT-QUICK-BOOTSTRAP-1",
        name: "Quick Bootstrap User",
        role: "Trainer",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatQuickBootstrapAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/quick-bootstrap",
    createChatQuickBootstrapController({
      getChatQuickBootstrapPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/quick-bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatQuickBootstrapUserNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-QUICK-BOOTSTRAP-NOTFOUND" };
    next();
  });

  router.get(
    "/quick-bootstrap",
    createChatQuickBootstrapController({
      getChatQuickBootstrapPayload: async () => {
        const error = new Error("User not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/quick-bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "User not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatQuickBootstrapErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-QUICK-BOOTSTRAP-500" };
    next();
  });

  router.get(
    "/quick-bootstrap",
    createChatQuickBootstrapController({
      getChatQuickBootstrapPayload: async () => {
        throw new Error("quick bootstrap dependency failed");
      },
    }),
  );

  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/quick-bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      message: "quick bootstrap dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatFullBootstrapLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-FULL-BOOTSTRAP-1" };
    next();
  });

  router.get(
    "/full-bootstrap",
    createChatFullBootstrapController({
      getChatFullBootstrapPayload: async ({ currentUserId }) => {
        assert.equal(currentUserId, "USER-CHAT-FULL-BOOTSTRAP-1");

        return {
          success: true,
          directContacts: [
            {
              portalUserId: "USER-TRAINER-2",
              name: "Trainer Two",
              roleLabel: "Trainer",
              image: null,
            },
          ],
          groupCandidates: [],
          users: {
            "USER-TRAINER-2": {
              id: "USER-TRAINER-2",
              name: "Trainer Two",
              role: "Trainer",
              image: null,
            },
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/full-bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      directContacts: [
        {
          portalUserId: "USER-TRAINER-2",
          name: "Trainer Two",
          roleLabel: "Trainer",
          image: null,
        },
      ],
      groupCandidates: [],
      users: {
        "USER-TRAINER-2": {
          id: "USER-TRAINER-2",
          name: "Trainer Two",
          role: "Trainer",
          image: null,
        },
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatFullBootstrapAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/full-bootstrap",
    createChatFullBootstrapController({
      getChatFullBootstrapPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/full-bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatFullBootstrapUserNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-FULL-BOOTSTRAP-NOTFOUND" };
    next();
  });

  router.get(
    "/full-bootstrap",
    createChatFullBootstrapController({
      getChatFullBootstrapPayload: async () => {
        const error = new Error("User not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/full-bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "User not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatFullBootstrapErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-FULL-BOOTSTRAP-500" };
    next();
  });

  router.get(
    "/full-bootstrap",
    createChatFullBootstrapController({
      getChatFullBootstrapPayload: async () => {
        throw new Error("full bootstrap dependency failed");
      },
    }),
  );

  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/full-bootstrap`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      message: "full bootstrap dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatCreateLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CREATE-1" };
    next();
  });

  router.post(
    "/create",
    createChatCreateController({
      getChatCreatePayload: async ({ currentUserId, payload }) => {
        assert.equal(currentUserId, "USER-CHAT-CREATE-1");
        assert.deepEqual(payload, {
          mode: "private",
          targetUserId: "USER-CHAT-TARGET-1",
          chatKey: "direct:USER-CHAT-CREATE-1:USER-CHAT-TARGET-1",
        });

        return {
          success: true,
          message: "Chat created",
          data: {
            _id: "CHAT-CREATE-1",
            isGroup: false,
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "private",
        targetUserId: "USER-CHAT-TARGET-1",
        chatKey: "direct:USER-CHAT-CREATE-1:USER-CHAT-TARGET-1",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(payload, {
      success: true,
      message: "Chat created",
      data: {
        _id: "CHAT-CREATE-1",
        isGroup: false,
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatCreateAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/create",
    createChatCreateController({
      getChatCreatePayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
          message: "Chat created",
          data: { _id: "CHAT-CREATE-AUTH" },
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatCreateValidationParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CREATE-400" };
    next();
  });

  router.post(
    "/create",
    createChatCreateController({
      getChatCreatePayload: async () => {
        throw new RealtimeMessageError("targetUserId is required for private chat", 400);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "private" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "targetUserId is required for private chat",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatCreateNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CREATE-404" };
    next();
  });

  router.post(
    "/create",
    createChatCreateController({
      getChatCreatePayload: async () => {
        const error = new Error("User not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "private", targetUserId: "USER-404" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "User not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatCreateErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CREATE-500" };
    next();
  });

  router.post(
    "/create",
    createChatCreateController({
      getChatCreatePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "private", targetUserId: "USER-500" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to create chat",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatDirectLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DIRECT-1" };
    next();
  });

  router.post(
    "/direct",
    createChatDirectController({
      getChatDirectPayload: async ({ currentUserId, payload }) => {
        assert.equal(currentUserId, "USER-CHAT-DIRECT-1");
        assert.deepEqual(payload, {
          memberId: "USER-CHAT-DIRECT-TARGET-1",
        });

        return {
          success: true,
          channelId: "CHAT-DIRECT-1",
          type: "messaging",
          created: true,
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memberId: "USER-CHAT-DIRECT-TARGET-1",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      channelId: "CHAT-DIRECT-1",
      type: "messaging",
      created: true,
    });
  } finally {
    await stopServer(server);
  }
};

const runChatDirectAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/direct",
    createChatDirectController({
      getChatDirectPayload: async () => {
        handlerInvoked = true;
        return { success: true, channelId: "CHAT-DIRECT-AUTH" };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "USER-X" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatDirectRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DIRECT-ROLE-1", role: "Viewer" };
    next();
  });

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );

  router.post(
    "/direct",
    createChatDirectController({
      getChatDirectPayload: async () => {
        handlerInvoked = true;
        return { success: true, channelId: "CHAT-DIRECT-ROLE" };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "USER-X" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatDirectValidationParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DIRECT-400" };
    next();
  });

  router.post(
    "/direct",
    createChatDirectController({
      getChatDirectPayload: async () => {
        const error = new Error("Member ID is required for direct channel");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      message: "Member ID is required for direct channel",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatDirectErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DIRECT-500" };
    next();
  });

  router.post(
    "/direct",
    createChatDirectController({
      getChatDirectPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "USER-500" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatMessageSendLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-SEND-1" };
    req.io = { to: () => ({ emit: () => {} }) };
    next();
  });

  router.post(
    "/message/send",
    createChatMessageSendController({
      getChatMessageSendPayload: async ({ io, currentUserId, payload }) => {
        assert.equal(typeof io?.to, "function");
        assert.equal(currentUserId, "USER-CHAT-SEND-1");
        assert.deepEqual(payload, {
          type: "text",
          content: "Hello from api parity test",
        });
        return {
          success: true,
          message: "Message sent",
          allowedTypes: ["text", "image", "video", "pdf", "audio", "voice"],
          data: {
            id: "MSG-SEND-API-1",
            type: "text",
            content: "Hello from api parity test",
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "text",
        content: "Hello from api parity test",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(payload, {
      success: true,
      message: "Message sent",
      allowedTypes: ["text", "image", "video", "pdf", "audio", "voice"],
      data: {
        id: "MSG-SEND-API-1",
        type: "text",
        content: "Hello from api parity test",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatMessageSendAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/message/send",
    createChatMessageSendController({
      getChatMessageSendPayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
          message: "Message sent",
          allowedTypes: ["text"],
          data: { id: "MSG-SEND-AUTH" },
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", content: "blocked" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatMessageSendValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-SEND-400" };
    next();
  });

  router.post(
    "/message/send",
    createChatMessageSendController({
      getChatMessageSendPayload: async () => {
        throw new RealtimeMessageError("content/text is required for text messages", 400);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", content: "" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "content/text is required for text messages",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatMessageSendErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-SEND-500" };
    next();
  });

  router.post(
    "/message/send",
    createChatMessageSendController({
      getChatMessageSendPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", content: "hello" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to send message",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatChannelLeaveLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LEAVE-1" };
    next();
  });

  router.delete(
    "/channel/:channelId/leave",
    createChatChannelLeaveController({
      getChatChannelLeavePayload: async ({ currentUserId, channelId, type }) => {
        assert.equal(currentUserId, "USER-CHAT-LEAVE-1");
        assert.equal(channelId, "CHANNEL-LEAVE-1");
        assert.equal(type, "messaging");
        return {
          success: true,
          left: true,
          channelId: "CHANNEL-LEAVE-1",
          memberId: "USER-CHAT-LEAVE-1",
          type: "messaging",
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-LEAVE-1/leave?type=messaging`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      left: true,
      channelId: "CHANNEL-LEAVE-1",
      memberId: "USER-CHAT-LEAVE-1",
      type: "messaging",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelLeaveAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/channel/:channelId/leave",
    createChatChannelLeaveController({
      getChatChannelLeavePayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
          left: true,
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-LEAVE-AUTH/leave`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatChannelLeaveValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LEAVE-404" };
    next();
  });

  router.delete(
    "/channel/:channelId/leave",
    createChatChannelLeaveController({
      getChatChannelLeavePayload: async () => {
        const error = new Error("Channel not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-LEAVE-404/leave`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "Channel not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelLeaveErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LEAVE-500" };
    next();
  });

  router.delete(
    "/channel/:channelId/leave",
    createChatChannelLeaveController({
      getChatChannelLeavePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-LEAVE-500/leave`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatChannelClearMessagesLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CLEAR-1" };
    next();
  });

  router.delete(
    "/channel/:channelId/messages",
    createChatChannelClearMessagesController({
      getChatChannelClearMessagesPayload: async ({ currentUserId, channelId, type }) => {
        assert.equal(currentUserId, "USER-CHAT-CLEAR-1");
        assert.equal(channelId, "CHANNEL-CLEAR-1");
        assert.equal(type, "messaging");
        return {
          success: true,
          cleared: true,
          channelId: "CHANNEL-CLEAR-1",
          type: "messaging",
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-CLEAR-1/messages?type=messaging`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      cleared: true,
      channelId: "CHANNEL-CLEAR-1",
      type: "messaging",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelClearMessagesAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/channel/:channelId/messages",
    createChatChannelClearMessagesController({
      getChatChannelClearMessagesPayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-CLEAR-AUTH/messages`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatChannelClearMessagesRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/channel/:channelId/messages",
    createChatChannelClearMessagesController({
      getChatChannelClearMessagesPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-CLEAR-ROLE/messages`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatChannelClearMessagesValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CLEAR-404" };
    next();
  });

  router.delete(
    "/channel/:channelId/messages",
    createChatChannelClearMessagesController({
      getChatChannelClearMessagesPayload: async () => {
        const error = new Error("Channel not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-CLEAR-404/messages`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "Channel not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelClearMessagesErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CLEAR-500" };
    next();
  });

  router.delete(
    "/channel/:channelId/messages",
    createChatChannelClearMessagesController({
      getChatChannelClearMessagesPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-CLEAR-500/messages`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatChannelDeleteLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CHANNEL-DELETE-1" };
    next();
  });

  router.delete(
    "/channel/:channelId",
    createChatChannelDeleteController({
      getChatChannelDeletePayload: async ({ currentUserId, channelId, type }) => {
        assert.equal(currentUserId, "USER-CHAT-CHANNEL-DELETE-1");
        assert.equal(channelId, "CHANNEL-DELETE-1");
        assert.equal(type, "messaging");
        return {
          success: true,
          deleted: true,
          channelId: "CHANNEL-DELETE-1",
          type: "messaging",
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-DELETE-1`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      deleted: true,
      channelId: "CHANNEL-DELETE-1",
      type: "messaging",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelDeleteAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/channel/:channelId",
    createChatChannelDeleteController({
      getChatChannelDeletePayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
          deleted: true,
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-DELETE-AUTH`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatChannelDeleteRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/channel/:channelId",
    createChatChannelDeleteController({
      getChatChannelDeletePayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-DELETE-ROLE`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatChannelDeleteValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CHANNEL-DELETE-404" };
    next();
  });

  router.delete(
    "/channel/:channelId",
    createChatChannelDeleteController({
      getChatChannelDeletePayload: async () => {
        const error = new Error("Channel not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-DELETE-404`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "Channel not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelDeleteErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-CHANNEL-DELETE-500" };
    next();
  });

  router.delete(
    "/channel/:channelId",
    createChatChannelDeleteController({
      getChatChannelDeletePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-DELETE-500`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatChannelRemoveUserLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-REMOVE-1" };
    next();
  });

  router.delete(
    "/channel/:channelId/remove-user/:memberId",
    createChatChannelRemoveUserController({
      getChatChannelRemoveUserPayload: async ({ currentUserId, channelId, memberId, type }) => {
        assert.equal(currentUserId, "USER-CHAT-REMOVE-1");
        assert.equal(channelId, "CHANNEL-REMOVE-1");
        assert.equal(memberId, "MEMBER-REMOVE-1");
        assert.equal(type, "messaging");
        return {
          success: true,
          removed: true,
          channelId: "CHANNEL-REMOVE-1",
          memberId: "MEMBER-REMOVE-1",
          type: "messaging",
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-REMOVE-1/remove-user/MEMBER-REMOVE-1?type=messaging`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      removed: true,
      channelId: "CHANNEL-REMOVE-1",
      memberId: "MEMBER-REMOVE-1",
      type: "messaging",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelRemoveUserAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/channel/:channelId/remove-user/:memberId",
    createChatChannelRemoveUserController({
      getChatChannelRemoveUserPayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-REMOVE-AUTH/remove-user/MEMBER-REMOVE-AUTH`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatChannelRemoveUserRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/channel/:channelId/remove-user/:memberId",
    createChatChannelRemoveUserController({
      getChatChannelRemoveUserPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-REMOVE-ROLE/remove-user/MEMBER-REMOVE-ROLE`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatChannelRemoveUserValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-REMOVE-404" };
    next();
  });

  router.delete(
    "/channel/:channelId/remove-user/:memberId",
    createChatChannelRemoveUserController({
      getChatChannelRemoveUserPayload: async () => {
        const error = new Error("Channel not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-REMOVE-404/remove-user/MEMBER-REMOVE-404`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "Channel not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelRemoveUserErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-REMOVE-500" };
    next();
  });

  router.delete(
    "/channel/:channelId/remove-user/:memberId",
    createChatChannelRemoveUserController({
      getChatChannelRemoveUserPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-REMOVE-500/remove-user/MEMBER-REMOVE-500`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatGroupRemoveMemberLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-REMOVE-1" };
    next();
  });

  router.delete(
    "/group/:id/remove-member/:userId",
    createChatGroupRemoveMemberController({
      getChatGroupRemoveMemberPayload: async ({ currentUserId, groupId, userIdToRemove }) => {
        assert.equal(currentUserId, "USER-CHAT-GROUP-REMOVE-1");
        assert.equal(groupId, "GROUP-REMOVE-1");
        assert.equal(userIdToRemove, "MEMBER-REMOVE-1");
        return {
          success: true,
          removed: true,
          groupId: "GROUP-REMOVE-1",
          userId: "MEMBER-REMOVE-1",
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-REMOVE-1/remove-member/MEMBER-REMOVE-1`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      removed: true,
      groupId: "GROUP-REMOVE-1",
      userId: "MEMBER-REMOVE-1",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatGroupRemoveMemberAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/group/:id/remove-member/:userId",
    createChatGroupRemoveMemberController({
      getChatGroupRemoveMemberPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-REMOVE-AUTH/remove-member/MEMBER-REMOVE-AUTH`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatGroupRemoveMemberRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/group/:id/remove-member/:userId",
    createChatGroupRemoveMemberController({
      getChatGroupRemoveMemberPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-REMOVE-ROLE/remove-member/MEMBER-REMOVE-ROLE`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatGroupRemoveMemberValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-REMOVE-404" };
    next();
  });

  router.delete(
    "/group/:id/remove-member/:userId",
    createChatGroupRemoveMemberController({
      getChatGroupRemoveMemberPayload: async () => {
        const error = new Error("Group not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-REMOVE-404/remove-member/MEMBER-REMOVE-404`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "Group not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatGroupRemoveMemberErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-REMOVE-500" };
    next();
  });

  router.delete(
    "/group/:id/remove-member/:userId",
    createChatGroupRemoveMemberController({
      getChatGroupRemoveMemberPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-REMOVE-500/remove-member/MEMBER-REMOVE-500`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatGroupAddMembersLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-ADD-1" };
    next();
  });

  router.post(
    "/group/:id/add-members",
    express.json(),
    createChatGroupAddMembersController({
      getChatGroupAddMembersPayload: async ({ currentUserId, groupId, memberIds }) => {
        assert.equal(currentUserId, "USER-CHAT-GROUP-ADD-1");
        assert.equal(groupId, "GROUP-ADD-1");
        assert.deepEqual(memberIds, ["MEMBER-ADD-1", "MEMBER-ADD-2"]);
        return {
          success: true,
          addedMemberIds: ["MEMBER-ADD-1", "MEMBER-ADD-2"],
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-ADD-1/add-members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: ["MEMBER-ADD-1", "MEMBER-ADD-2"] }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      addedMemberIds: ["MEMBER-ADD-1", "MEMBER-ADD-2"],
    });
  } finally {
    await stopServer(server);
  }
};

const runChatGroupAddMembersAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/group/:id/add-members",
    express.json(),
    createChatGroupAddMembersController({
      getChatGroupAddMembersPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-ADD-AUTH/add-members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: ["MEMBER-ADD-AUTH"] }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatGroupAddMembersRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/group/:id/add-members",
    express.json(),
    createChatGroupAddMembersController({
      getChatGroupAddMembersPayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-ADD-ROLE/add-members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: ["MEMBER-ADD-ROLE"] }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatGroupAddMembersValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-ADD-400" };
    next();
  });

  router.post(
    "/group/:id/add-members",
    express.json(),
    createChatGroupAddMembersController({
      getChatGroupAddMembersPayload: async () => {
        const error = new Error("memberIds are required");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-ADD-400/add-members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      message: "memberIds are required",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatGroupAddMembersErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-ADD-500" };
    next();
  });

  router.post(
    "/group/:id/add-members",
    express.json(),
    createChatGroupAddMembersController({
      getChatGroupAddMembersPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/group/GROUP-ADD-500/add-members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: ["MEMBER-ADD-500"] }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatGroupCreateLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-CREATE-1" };
    next();
  });

  router.post(
    "/group/create",
    express.json(),
    createChatGroupCreateController({
      getChatGroupCreatePayload: async ({ currentUserId, payload }) => {
        assert.equal(currentUserId, "USER-CHAT-GROUP-CREATE-1");
        assert.deepEqual(payload, {
          name: "Group Create One",
          memberIds: ["MEMBER-CREATE-1", "MEMBER-CREATE-2"],
        });
        return {
          success: true,
          channelId: "GROUP-CREATE-1",
          created: true,
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/group/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Group Create One",
        memberIds: ["MEMBER-CREATE-1", "MEMBER-CREATE-2"],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      channelId: "GROUP-CREATE-1",
      created: true,
    });
  } finally {
    await stopServer(server);
  }
};

const runChatGroupCreateAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/group/create",
    express.json(),
    createChatGroupCreateController({
      getChatGroupCreatePayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/group/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Auth Denied Group" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatGroupCreateRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/group/create",
    express.json(),
    createChatGroupCreateController({
      getChatGroupCreatePayload: async () => {
        handlerInvoked = true;
        return { success: true };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/group/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Role Denied Group" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatGroupCreateValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-CREATE-400" };
    next();
  });

  router.post(
    "/group/create",
    express.json(),
    createChatGroupCreateController({
      getChatGroupCreatePayload: async () => {
        const error = new Error("Group name is required");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/group/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      message: "Group name is required",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatGroupCreateErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-GROUP-CREATE-500" };
    next();
  });

  router.post(
    "/group/create",
    express.json(),
    createChatGroupCreateController({
      getChatGroupCreatePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/group/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Group Error" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatBroadcastAnnouncementLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-BROADCAST-1" };
    req.io = { emit: () => {} };
    next();
  });

  router.post(
    "/broadcast",
    express.json(),
    createChatBroadcastController({
      getChatBroadcastPayload: async ({ currentUserId, payload }) => {
        assert.equal(currentUserId, "USER-CHAT-BROADCAST-1");
        assert.deepEqual(payload, {
          text: "Important update",
        });
        return {
          statusCode: 200,
          responsePayload: {
            success: true,
            mode: "announcement",
            recipientsResolved: 2,
            streamMessageId: null,
            socketEvent: "receive_message",
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Important update" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      mode: "announcement",
      recipientsResolved: 2,
      streamMessageId: null,
      socketEvent: "receive_message",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatBroadcastChannelLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-BROADCAST-2" };
    req.io = { emit: () => {} };
    next();
  });

  router.post(
    "/broadcast",
    express.json(),
    createChatBroadcastController({
      getChatBroadcastPayload: async ({ currentUserId, payload }) => {
        assert.equal(currentUserId, "USER-CHAT-BROADCAST-2");
        assert.deepEqual(payload, {
          name: "Ops Channel",
          description: "Ops broadcast",
        });
        return {
          statusCode: 200,
          responsePayload: {
            success: true,
            mode: "channel",
            channelId: "broadcast-chan-1",
            name: "Ops Channel",
            members: ["MEM-1", "MEM-2"],
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ops Channel", description: "Ops broadcast" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      mode: "channel",
      channelId: "broadcast-chan-1",
      name: "Ops Channel",
      members: ["MEM-1", "MEM-2"],
    });
  } finally {
    await stopServer(server);
  }
};

const runChatBroadcastAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/broadcast",
    express.json(),
    createChatBroadcastController({
      getChatBroadcastPayload: async () => {
        handlerInvoked = true;
        return {
          statusCode: 200,
          responsePayload: { success: true },
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Denied" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatBroadcastRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.post(
    "/broadcast",
    express.json(),
    createChatBroadcastController({
      getChatBroadcastPayload: async () => {
        handlerInvoked = true;
        return {
          statusCode: 200,
          responsePayload: { success: true },
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Forbidden" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatBroadcastValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-BROADCAST-400" };
    req.io = { emit: () => {} };
    next();
  });

  router.post(
    "/broadcast",
    express.json(),
    createChatBroadcastController({
      getChatBroadcastPayload: async () => ({
        statusCode: 400,
        responsePayload: {
          message: "Announcement text or broadcast name is required",
        },
      }),
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      message: "Announcement text or broadcast name is required",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatBroadcastErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-BROADCAST-500" };
    req.io = { emit: () => {} };
    next();
  });

  router.post(
    "/broadcast",
    express.json(),
    createChatBroadcastController({
      getChatBroadcastPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "will fail" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatDeleteForMeLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-ME-1" };
    req.io = { to: () => ({ emit: () => {} }) };
    next();
  });

  router.put(
    "/message/:messageId/delete-for-me",
    createChatDeleteForMeController({
      getChatDeleteForMePayload: async ({ io, actorId, messageId }) => {
        assert.equal(typeof io?.to, "function");
        assert.equal(actorId, "USER-CHAT-DEL-ME-1");
        assert.equal(messageId, "MSG-DEL-ME-1");
        return {
          success: true,
          message: "Message deleted for you",
          data: {
            success: true,
            scope: "me",
            messageId: "MSG-DEL-ME-1",
            userId: "USER-CHAT-DEL-ME-1",
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-ME-1/delete-for-me`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      message: "Message deleted for you",
      data: {
        success: true,
        scope: "me",
        messageId: "MSG-DEL-ME-1",
        userId: "USER-CHAT-DEL-ME-1",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteForMeAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.put(
    "/message/:messageId/delete-for-me",
    createChatDeleteForMeController({
      getChatDeleteForMePayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
          message: "Message deleted for you",
          data: { messageId: "MSG-DEL-ME-AUTH" },
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-ME-AUTH/delete-for-me`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteForMeValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-ME-400" };
    next();
  });

  router.put(
    "/message/:messageId/delete-for-me",
    createChatDeleteForMeController({
      getChatDeleteForMePayload: async () => {
        throw new RealtimeMessageError("messageId is required", 400);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/ /delete-for-me`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "messageId is required",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteForMeErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-ME-500" };
    next();
  });

  router.put(
    "/message/:messageId/delete-for-me",
    createChatDeleteForMeController({
      getChatDeleteForMePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-ME-500/delete-for-me`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to delete message for you",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatDeleteForEveryoneLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-EVERY-1" };
    req.io = { to: () => ({ emit: () => {} }) };
    next();
  });

  router.put(
    "/message/:messageId/delete-for-everyone",
    createChatDeleteForEveryoneController({
      getChatDeleteForEveryonePayload: async ({ io, actorId, messageId }) => {
        assert.equal(typeof io?.to, "function");
        assert.equal(actorId, "USER-CHAT-DEL-EVERY-1");
        assert.equal(messageId, "MSG-DEL-EVERY-1");
        return {
          success: true,
          message: "Message deleted for everyone",
          data: {
            success: true,
            scope: "everyone",
            messageId: "MSG-DEL-EVERY-1",
            deletedBy: "USER-CHAT-DEL-EVERY-1",
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-EVERY-1/delete-for-everyone`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      message: "Message deleted for everyone",
      data: {
        success: true,
        scope: "everyone",
        messageId: "MSG-DEL-EVERY-1",
        deletedBy: "USER-CHAT-DEL-EVERY-1",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteForEveryoneAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.put(
    "/message/:messageId/delete-for-everyone",
    createChatDeleteForEveryoneController({
      getChatDeleteForEveryonePayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
          message: "Message deleted for everyone",
          data: { messageId: "MSG-DEL-EVERY-AUTH" },
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-EVERY-AUTH/delete-for-everyone`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteForEveryoneValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-EVERY-400" };
    next();
  });

  router.put(
    "/message/:messageId/delete-for-everyone",
    createChatDeleteForEveryoneController({
      getChatDeleteForEveryonePayload: async () => {
        throw new RealtimeMessageError("Only sender can delete for everyone", 403);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-EVERY-403/delete-for-everyone`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      success: false,
      message: "Only sender can delete for everyone",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteForEveryoneErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-EVERY-500" };
    next();
  });

  router.put(
    "/message/:messageId/delete-for-everyone",
    createChatDeleteForEveryoneController({
      getChatDeleteForEveryonePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-EVERY-500/delete-for-everyone`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to delete message for everyone",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatDeleteMessageLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-1" };
    next();
  });

  router.delete(
    "/message/:messageId",
    createChatDeleteMessageController({
      getChatDeleteMessagePayload: async ({ currentUserId, messageId }) => {
        assert.equal(currentUserId, "USER-CHAT-DEL-1");
        assert.equal(messageId, "MSG-DEL-1");
        return {
          success: true,
          deleted: true,
          messageId: "MSG-DEL-1",
          deletedBy: "USER-CHAT-DEL-1",
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-1`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      deleted: true,
      messageId: "MSG-DEL-1",
      deletedBy: "USER-CHAT-DEL-1",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteMessageAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/message/:messageId",
    createChatDeleteMessageController({
      getChatDeleteMessagePayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      message: "No token",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-AUTH`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteMessageRoleDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.delete(
    "/message/:messageId",
    createChatDeleteMessageController({
      getChatDeleteMessagePayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(403).json({
      message: "Forbidden",
    }),
  );
  app.use("/api/chat", router);

  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-ROLE`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      message: "Forbidden",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteMessageValidationStatusParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-404" };
    next();
  });

  router.delete(
    "/message/:messageId",
    createChatDeleteMessageController({
      getChatDeleteMessagePayload: async () => {
        const error = new Error("Message not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-404`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      message: "Message not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatDeleteMessageErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-DEL-500" };
    next();
  });

  router.delete(
    "/message/:messageId",
    createChatDeleteMessageController({
      getChatDeleteMessagePayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/message/MSG-DEL-500`,
      { method: "DELETE" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {});
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatListLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LIST-1" };
    next();
  });

  router.get(
    "/",
    createChatListController({
      getChatListFeed: async ({ currentUserId, query }) => {
        assert.equal(currentUserId, "USER-CHAT-LIST-1");
        assert.deepEqual(query, {
          search: "primary-search",
          page: "2",
          limit: "15",
        });

        return {
          success: true,
          total: 2,
          page: 2,
          limit: 15,
          data: [{ id: "CHAT-L-2" }, { id: "CHAT-L-1" }],
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat?search=primary-search&q=ignored-search&page=2&limit=15`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      total: 2,
      page: 2,
      limit: 15,
      data: [{ id: "CHAT-L-2" }, { id: "CHAT-L-1" }],
    });
  } finally {
    await stopServer(server);
  }
};

const runChatListDefaultQueryParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LIST-2" };
    next();
  });

  router.get(
    "/",
    createChatListController({
      getChatListFeed: async ({ currentUserId, query }) => {
        assert.equal(currentUserId, "USER-CHAT-LIST-2");
        assert.deepEqual(query, {
          search: "",
          page: 1,
          limit: 30,
        });

        return {
          success: true,
          total: 0,
          page: 1,
          limit: 30,
          data: [],
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      total: 0,
      page: 1,
      limit: 30,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runChatListAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/",
    createChatListController({
      getChatListFeed: async () => {
        handlerInvoked = true;
        return {
          success: true,
          total: 0,
          page: 1,
          limit: 30,
          data: [],
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatListInvalidStateParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LIST-400" };
    next();
  });

  router.get(
    "/",
    createChatListController({
      getChatListFeed: async () => {
        throw new RealtimeMessageError("currentUserId is required", 400);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "currentUserId is required",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatListErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-LIST-500" };
    next();
  });

  router.get(
    "/",
    createChatListController({
      getChatListFeed: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch chats",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatSearchLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { _id: "USER-CHAT-SEARCH-1" };
    next();
  });

  router.get(
    "/search",
    createChatSearchController({
      getChatSearchFeed: async ({ currentUserId, query }) => {
        assert.equal(currentUserId, "USER-CHAT-SEARCH-1");
        assert.deepEqual(query, {
          search: "hello-team",
          page: "3",
          limit: "12",
        });

        return {
          success: true,
          total: 1,
          page: 3,
          limit: 12,
          data: [{ id: "MSG-SEARCH-1", content: "hello team" }],
          users: {
            "USER-CHAT-SEARCH-1": {
              id: "USER-CHAT-SEARCH-1",
              name: "Requester",
            },
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/search?q=hello-team&search=ignored&page=3&limit=12`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      total: 1,
      page: 3,
      limit: 12,
      data: [{ id: "MSG-SEARCH-1", content: "hello team" }],
      users: {
        "USER-CHAT-SEARCH-1": {
          id: "USER-CHAT-SEARCH-1",
          name: "Requester",
        },
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatSearchQueryValidationParityCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-SEARCH-2" };
    next();
  });

  router.get(
    "/search",
    createChatSearchController({
      getChatSearchFeed: async () => {
        handlerInvoked = true;
        return {
          success: true,
          total: 0,
          page: 1,
          limit: 20,
          data: [],
          users: {},
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/search`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Search query is required",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatSearchAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/search",
    createChatSearchController({
      getChatSearchFeed: async () => {
        handlerInvoked = true;
        return {
          success: true,
          total: 0,
          page: 1,
          limit: 20,
          data: [],
          users: {},
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/search?q=hello`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatSearchRealtimeErrorParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-SEARCH-3" };
    next();
  });

  router.get(
    "/search",
    createChatSearchController({
      getChatSearchFeed: async () => {
        throw new RealtimeMessageError("Forbidden chat search", 403);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/search?q=hello`);
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      success: false,
      message: "Forbidden chat search",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatSearchErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-SEARCH-500" };
    next();
  });

  router.get(
    "/search",
    createChatSearchController({
      getChatSearchFeed: async () => {
        throw new Error("chat search dependency failed");
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/search?q=hello`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "chat search dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatMessageSearchLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-MSG-SEARCH-1" };
    next();
  });

  router.get(
    "/message/search",
    createChatMessageSearchController({
      getChatMessageSearchFeed: async ({ currentUserId, query }) => {
        assert.equal(currentUserId, "USER-CHAT-MSG-SEARCH-1");
        assert.deepEqual(query, {
          search: "from-search-param",
          page: "2",
          limit: "10",
        });

        return {
          success: true,
          total: 1,
          page: 2,
          limit: 10,
          data: [{ id: "MSG-M-1", content: "from search param" }],
          users: {},
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/search?search=from-search-param&q=ignored&page=2&limit=10`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      total: 1,
      page: 2,
      limit: 10,
      data: [{ id: "MSG-M-1", content: "from search param" }],
      users: {},
    });
  } finally {
    await stopServer(server);
  }
};

const runChatMessageSearchQueryValidationParityCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-MSG-SEARCH-2" };
    next();
  });

  router.get(
    "/message/search",
    createChatMessageSearchController({
      getChatMessageSearchFeed: async () => {
        handlerInvoked = true;
        return {
          success: true,
          total: 0,
          page: 1,
          limit: 20,
          data: [],
          users: {},
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/message/search`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Search text is required",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatMessageSearchAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/message/search",
    createChatMessageSearchController({
      getChatMessageSearchFeed: async () => {
        handlerInvoked = true;
        return {
          success: true,
          total: 0,
          page: 1,
          limit: 20,
          data: [],
          users: {},
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/message/search?search=hello`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatMessageSearchRealtimeErrorParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-MSG-SEARCH-3" };
    next();
  });

  router.get(
    "/message/search",
    createChatMessageSearchController({
      getChatMessageSearchFeed: async () => {
        throw new RealtimeMessageError("Forbidden message search", 403);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/message/search?search=hello`);
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      success: false,
      message: "Forbidden message search",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatMessageSearchErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-MSG-SEARCH-500" };
    next();
  });

  router.get(
    "/message/search",
    createChatMessageSearchController({
      getChatMessageSearchFeed: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/message/search?search=hello`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to search messages",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatInfoLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-INFO-1" };
    next();
  });

  router.get(
    "/info/:chatId",
    createChatInfoController({
      getChatInfoPayload: async ({ currentUserId, chatId, query }) => {
        assert.equal(currentUserId, "USER-CHAT-INFO-1");
        assert.equal(chatId, "CHAT-INFO-1");
        assert.deepEqual(query, {
          mediaLimit: 250,
          fileLimit: 120,
          linkLimit: 90,
        });

        return {
          success: true,
          data: {
            chat: { _id: "CHAT-INFO-1", title: "Chat Info" },
            media: [],
            documents: [],
            links: [],
          },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/info/CHAT-INFO-1?mediaLimit=250&fileLimit=120&linkLimit=90`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: {
        chat: { _id: "CHAT-INFO-1", title: "Chat Info" },
        media: [],
        documents: [],
        links: [],
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatInfoDefaultQueryParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-INFO-2" };
    next();
  });

  router.get(
    "/info/:chatId",
    createChatInfoController({
      getChatInfoPayload: async ({ currentUserId, chatId, query }) => {
        assert.equal(currentUserId, "USER-CHAT-INFO-2");
        assert.equal(chatId, "CHAT-INFO-2");
        assert.deepEqual(query, {
          mediaLimit: 100,
          fileLimit: 100,
          linkLimit: 100,
        });
        return {
          success: true,
          data: { chat: { _id: "CHAT-INFO-2" }, media: [], documents: [], links: [] },
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/info/CHAT-INFO-2`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      data: { chat: { _id: "CHAT-INFO-2" }, media: [], documents: [], links: [] },
    });
  } finally {
    await stopServer(server);
  }
};

const runChatInfoAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/info/:chatId",
    createChatInfoController({
      getChatInfoPayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
          data: { chat: { _id: "CHAT-INFO-AUTH" }, media: [], documents: [], links: [] },
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/info/CHAT-INFO-AUTH`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatInfoInvalidIdParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-INFO-400" };
    next();
  });

  router.get(
    "/info/:chatId",
    createChatInfoController({
      getChatInfoPayload: async () => {
        throw new RealtimeMessageError("Invalid chatId", 400);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/info/not-an-object-id`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid chatId",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatInfoNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-INFO-404" };
    next();
  });

  router.get(
    "/info/:chatId",
    createChatInfoController({
      getChatInfoPayload: async () => {
        throw new RealtimeMessageError("Chat not found", 404);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/chat/info/CHAT-INFO-404`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Chat not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatInfoErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-INFO-500" };
    next();
  });

  router.get(
    "/info/:chatId",
    createChatInfoController({
      getChatInfoPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/chat/info/CHAT-INFO-500`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to load chat info",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatMessageHistoryLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-HISTORY-1" };
    next();
  });

  router.get(
    "/message/history/:otherUserId",
    createChatMessageHistoryController({
      getChatMessageHistoryPayload: async ({
        currentUserId,
        otherUserId,
        query,
      }) => {
        assert.equal(currentUserId, "USER-CHAT-HISTORY-1");
        assert.equal(otherUserId, "USER-CHAT-HISTORY-OTHER-1");
        assert.deepEqual(query, {
          page: "2",
          limit: "25",
        });
        return {
          success: true,
          total: 2,
          page: 2,
          limit: 25,
          data: [{ id: "MSG-H-2" }, { id: "MSG-H-1" }],
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/history/USER-CHAT-HISTORY-OTHER-1?page=2&limit=25`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      total: 2,
      page: 2,
      limit: 25,
      data: [{ id: "MSG-H-2" }, { id: "MSG-H-1" }],
    });
  } finally {
    await stopServer(server);
  }
};

const runChatMessageHistoryDefaultQueryParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-HISTORY-2" };
    next();
  });

  router.get(
    "/message/history/:otherUserId",
    createChatMessageHistoryController({
      getChatMessageHistoryPayload: async ({
        currentUserId,
        otherUserId,
        query,
      }) => {
        assert.equal(currentUserId, "USER-CHAT-HISTORY-2");
        assert.equal(otherUserId, "USER-CHAT-HISTORY-OTHER-2");
        assert.deepEqual(query, {
          page: 1,
          limit: 50,
        });
        return {
          success: true,
          total: 0,
          page: 1,
          limit: 50,
          data: [],
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/history/USER-CHAT-HISTORY-OTHER-2`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      total: 0,
      page: 1,
      limit: 50,
      data: [],
    });
  } finally {
    await stopServer(server);
  }
};

const runChatMessageHistoryAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/message/history/:otherUserId",
    createChatMessageHistoryController({
      getChatMessageHistoryPayload: async () => {
        handlerInvoked = true;
        return {
          success: true,
          total: 0,
          page: 1,
          limit: 50,
          data: [],
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/history/USER-CHAT-HISTORY-AUTH`,
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatMessageHistoryInvalidIdParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-HISTORY-400" };
    next();
  });

  router.get(
    "/message/history/:otherUserId",
    createChatMessageHistoryController({
      getChatMessageHistoryPayload: async () => {
        throw new RealtimeMessageError(
          "currentUserId and otherUserId are required",
          400,
        );
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/history/USER-CHAT-HISTORY-400`,
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "currentUserId and otherUserId are required",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatMessageHistoryNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-HISTORY-404" };
    next();
  });

  router.get(
    "/message/history/:otherUserId",
    createChatMessageHistoryController({
      getChatMessageHistoryPayload: async () => {
        throw new RealtimeMessageError("Receiver not found", 404);
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/message/history/USER-CHAT-HISTORY-404`,
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Receiver not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runChatMessageHistoryErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-HISTORY-500" };
    next();
  });

  router.get(
    "/message/history/:otherUserId",
    createChatMessageHistoryController({
      getChatMessageHistoryPayload: async () => {
        throw {};
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/message/history/USER-CHAT-HISTORY-500`,
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch message history",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatChannelAuditLogLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-AUDIT-1" };
    next();
  });

  router.get(
    "/channel/:channelId/audit-log",
    createChatChannelAuditLogController({
      getChatChannelAuditLogFeed: async ({ channelId, query }) => {
        assert.equal(channelId, "CHANNEL-AUDIT-1");
        assert.deepEqual(query, {
          limit: "25",
          page: "2",
        });

        return {
          success: true,
          logs: [{ event: "message_sent", channelId: "CHANNEL-AUDIT-1" }],
          total: 1,
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-AUDIT-1/audit-log?limit=25&page=2`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      logs: [{ event: "message_sent", channelId: "CHANNEL-AUDIT-1" }],
      total: 1,
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelAuditLogDefaultQueryParityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { _id: "USER-CHAT-AUDIT-2" };
    next();
  });

  router.get(
    "/channel/:channelId/audit-log",
    createChatChannelAuditLogController({
      getChatChannelAuditLogFeed: async ({ channelId, query }) => {
        assert.equal(channelId, "CHANNEL-AUDIT-2");
        assert.deepEqual(query, {
          limit: 100,
          page: 1,
        });

        return {
          success: true,
          logs: [],
          total: 0,
        };
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-AUDIT-2/audit-log`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      success: true,
      logs: [],
      total: 0,
    });
  } finally {
    await stopServer(server);
  }
};

const runChatChannelAuditLogAuthDeniedCase = async () => {
  const app = express();
  const router = express.Router();
  let handlerInvoked = false;

  router.get(
    "/channel/:channelId/audit-log",
    createChatChannelAuditLogController({
      getChatChannelAuditLogFeed: async () => {
        handlerInvoked = true;
        return {
          success: true,
          logs: [],
          total: 0,
        };
      },
    }),
  );

  app.use("/api/chat", (_req, res) =>
    res.status(401).json({
      success: false,
      message: "No token",
    }),
  );
  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-AUDIT-AUTH/audit-log`,
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(payload, {
      success: false,
      message: "No token",
    });
    assert.equal(handlerInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runChatChannelAuditLogNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-AUDIT-404" };
    next();
  });

  router.get(
    "/channel/:channelId/audit-log",
    createChatChannelAuditLogController({
      getChatChannelAuditLogFeed: async () => {
        const error = new Error("Channel not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-AUDIT-404/audit-log`,
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      message: "Channel not found",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runChatChannelAuditLogErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  app.use((req, _res, next) => {
    req.user = { id: "USER-CHAT-AUDIT-500" };
    next();
  });

  router.get(
    "/channel/:channelId/audit-log",
    createChatChannelAuditLogController({
      getChatChannelAuditLogFeed: async () => {
        throw new Error("audit log dependency failed");
      },
    }),
  );

  app.use("/api/chat", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/chat/channel/CHANNEL-AUDIT-500/audit-log`,
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      message: "audit log dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDocumentsMyDocumentsRouteFamilyCompatibilityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-DOC-1" };
    next();
  });

  router.get(
    "/my-documents",
    createMyDocumentsController({
      getMyDocumentsFeed: async ({ userId }) => {
        assert.equal(userId, "USER-DOC-1");
        return {
          success: true,
          data: [
            { _id: "DOC-2", documentType: "resume" },
            { _id: "DOC-1", documentType: "ndaAgreement" },
          ],
        };
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  app.use("/api/v1/documents", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const legacyResponse = await fetch(`${baseUrl}/api/trainer-documents/my-documents`);
    const legacyPayload = await legacyResponse.json();
    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(legacyPayload, {
      success: true,
      data: [
        { _id: "DOC-2", documentType: "resume" },
        { _id: "DOC-1", documentType: "ndaAgreement" },
      ],
    });

    const v1Response = await fetch(`${baseUrl}/api/v1/documents/my-documents`);
    const v1Payload = await v1Response.json();
    assert.equal(v1Response.status, 200);
    assert.equal(v1Payload.success, true);
    assert.equal(v1Payload.error, null);
    assert.deepEqual(v1Payload.data, legacyPayload.data);
  } finally {
    await stopServer(server);
  }
};

const runDocumentsMyDocumentsNotFoundCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-MISSING" };
    next();
  });

  router.get(
    "/my-documents",
    createMyDocumentsController({
      getMyDocumentsFeed: async () => {
        const error = new Error("Trainer profile not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/trainer-documents/my-documents`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer profile not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerRouteFamilyCompatibilityCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/trainer/:trainerId",
    createTrainerDocumentsController({
      getTrainerDocumentsFeed: async ({ trainerId }) => ({
        success: true,
        data: [
          { _id: "DOC-NEW", trainerId, documentType: "ndaAgreement" },
          { _id: "DOC-OLD", trainerId, documentType: "resume" },
        ],
      }),
    }),
  );

  app.use("/api/trainer-documents", router);
  app.use("/api/v1/documents", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const legacyResponse = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439011`,
    );
    const legacyPayload = await legacyResponse.json();

    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(legacyPayload, {
      success: true,
      data: [
        {
          _id: "DOC-NEW",
          trainerId: "507f1f77bcf86cd799439011",
          documentType: "ndaAgreement",
        },
        {
          _id: "DOC-OLD",
          trainerId: "507f1f77bcf86cd799439011",
          documentType: "resume",
        },
      ],
    });

    const v1Response = await fetch(
      `${baseUrl}/api/v1/documents/trainer/507f1f77bcf86cd799439011`,
    );
    const v1Payload = await v1Response.json();
    assert.equal(v1Response.status, 200);
    assert.equal(v1Payload.success, true);
    assert.equal(v1Payload.error, null);
    assert.deepEqual(v1Payload.data, legacyPayload.data);
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerInvalidIdCase = async () => {
  const app = express();
  const router = express.Router();

  router.get(
    "/trainer/:trainerId",
    createTrainerDocumentsController({
      getTrainerDocumentsFeed: async () => {
        const error = new Error("Invalid trainer ID");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/trainer-documents/trainer/invalid-id`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid trainer ID",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.get(
    "/trainer/:trainerId",
    createTrainerDocumentsController({
      getTrainerDocumentsFeed: async () => {
        throw new Error("documents dependency failed");
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439011`,
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to fetch documents",
      error: "documents dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDocumentsVerifyRouteFamilyCompatibilityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-ADMIN-VERIFY-1" };
    next();
  });

  router.put(
    "/:id/verify",
    createVerifyDocumentController({
      getVerifyDocumentFeed: async ({ documentId, payload, actorUserId }) => {
        assert.equal(documentId, "507f1f77bcf86cd799439018");
        assert.equal(actorUserId, "USER-ADMIN-VERIFY-1");
        assert.deepEqual(payload, {
          verificationStatus: "APPROVED",
          verificationComment: "Looks good",
        });
        return {
          success: true,
          message: "Document verification updated",
          data: {
            _id: "DOC-VERIFY-1",
            verificationStatus: "APPROVED",
            verificationComment: "Looks good",
            removed: false,
            cleanupWarning: null,
          },
        };
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  app.use("/api/v1/documents", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const legacyResponse = await fetch(
      `${baseUrl}/api/trainer-documents/507f1f77bcf86cd799439018/verify`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verificationStatus: "APPROVED",
          verificationComment: "Looks good",
        }),
      },
    );
    const legacyPayload = await legacyResponse.json();

    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(legacyPayload, {
      success: true,
      message: "Document verification updated",
      data: {
        _id: "DOC-VERIFY-1",
        verificationStatus: "APPROVED",
        verificationComment: "Looks good",
        removed: false,
        cleanupWarning: null,
      },
    });

    const v1Response = await fetch(
      `${baseUrl}/api/v1/documents/507f1f77bcf86cd799439018/verify`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verificationStatus: "APPROVED",
          verificationComment: "Looks good",
        }),
      },
    );
    const v1Payload = await v1Response.json();

    assert.equal(v1Response.status, 200);
    assert.equal(v1Payload.success, true);
    assert.equal(v1Payload.error, null);
    assert.deepEqual(v1Payload.data, legacyPayload.data);
  } finally {
    await stopServer(server);
  }
};

const runDocumentsVerifyInvalidIdParityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  router.put(
    "/:id/verify",
    createVerifyDocumentController({
      getVerifyDocumentFeed: async () => {
        const error = new Error("Invalid document ID");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/trainer-documents/invalid-id/verify`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verificationStatus: "APPROVED",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid document ID",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsVerifyNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  router.put(
    "/:id/verify",
    createVerifyDocumentController({
      getVerifyDocumentFeed: async () => {
        const error = new Error("Document not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/507f1f77bcf86cd799439019/verify`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verificationStatus: "APPROVED",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Document not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsVerifyInvalidStatusParityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  router.put(
    "/:id/verify",
    createVerifyDocumentController({
      getVerifyDocumentFeed: async () => {
        const error = new Error("Invalid verification status");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/507f1f77bcf86cd799439020/verify`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verificationStatus: "PENDING",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid verification status",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsVerifyErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;
  app.use(express.json());

  router.put(
    "/:id/verify",
    createVerifyDocumentController({
      getVerifyDocumentFeed: async () => {
        throw new Error("verify dependency failed");
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/507f1f77bcf86cd799439021/verify`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verificationStatus: "APPROVED",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to verify document",
      error: "verify dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDocumentsTrainerStatusRouteFamilyCompatibilityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "USER-ADMIN-STATUS-1" };
    next();
  });

  router.put(
    "/trainer/:trainerId/status",
    createTrainerStatusController({
      getTrainerStatusFeed: async ({ trainerId, payload, actorUserId }) => {
        assert.equal(trainerId, "507f1f77bcf86cd799439022");
        assert.equal(actorUserId, "USER-ADMIN-STATUS-1");
        assert.deepEqual(payload, {
          status: "REJECTED",
          reason: "Document mismatch",
        });

        return {
          success: true,
          message: "Trainer profile REJECTED successfully",
          data: {
            verificationStatus: "REJECTED",
            documentStatus: "rejected",
          },
        };
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  app.use("/api/v1/documents", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const legacyResponse = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439022/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "REJECTED",
          reason: "Document mismatch",
        }),
      },
    );
    const legacyPayload = await legacyResponse.json();

    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(legacyPayload, {
      success: true,
      message: "Trainer profile REJECTED successfully",
      data: {
        verificationStatus: "REJECTED",
        documentStatus: "rejected",
      },
    });

    const v1Response = await fetch(
      `${baseUrl}/api/v1/documents/trainer/507f1f77bcf86cd799439022/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "REJECTED",
          reason: "Document mismatch",
        }),
      },
    );
    const v1Payload = await v1Response.json();

    assert.equal(v1Response.status, 200);
    assert.equal(v1Payload.success, true);
    assert.equal(v1Payload.error, null);
    assert.deepEqual(v1Payload.data, legacyPayload.data);
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerStatusInvalidTrainerIdCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  router.put(
    "/trainer/:trainerId/status",
    createTrainerStatusController({
      getTrainerStatusFeed: async () => {
        const error = new Error("Invalid trainer ID");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/invalid-id/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid trainer ID",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerStatusInvalidStatusCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  router.put(
    "/trainer/:trainerId/status",
    createTrainerStatusController({
      getTrainerStatusFeed: async () => {
        const error = new Error("Invalid status");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439023/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "INVALID",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid status",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerStatusReviewGateParityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  router.put(
    "/trainer/:trainerId/status",
    createTrainerStatusController({
      getTrainerStatusFeed: async () => {
        const error = new Error(
          "Trainer must complete Agreement before admin review",
        );
        error.statusCode = 400;
        error.data = {
          nextStep: 4,
          nextStepLabel: "Agreement",
        };
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439024/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer must complete Agreement before admin review",
      data: {
        nextStep: 4,
        nextStepLabel: "Agreement",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerStatusNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  router.put(
    "/trainer/:trainerId/status",
    createTrainerStatusController({
      getTrainerStatusFeed: async () => {
        const error = new Error("Trainer not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439025/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerStatusErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;
  app.use(express.json());

  router.put(
    "/trainer/:trainerId/status",
    createTrainerStatusController({
      getTrainerStatusFeed: async () => {
        throw new Error("status dependency failed");
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439026/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "REJECTED",
        }),
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to update trainer status",
      error: "status dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDocumentsMoveToReviewRouteFamilyCompatibilityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-ADMIN-MOVE-1", role: "Admin" };
    next();
  });

  router.put(
    "/trainer/:trainerId/move-to-review",
    createMoveToReviewController({
      getMoveToReviewFeed: async ({ trainerId, actorRole }) => {
        assert.equal(trainerId, "507f1f77bcf86cd799439032");
        assert.equal(actorRole, "Admin");
        return {
          success: true,
          message: "Trainer moved to Review Docs successfully",
          data: {
            documentStatus: "under_review",
            missingDocuments: [],
            rejectedDocuments: [],
            canProceedToAgreement: true,
          },
        };
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  app.use("/api/v1/documents", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const legacyResponse = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439032/move-to-review`,
      { method: "PUT" },
    );
    const legacyPayload = await legacyResponse.json();

    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(legacyPayload, {
      success: true,
      message: "Trainer moved to Review Docs successfully",
      data: {
        documentStatus: "under_review",
        missingDocuments: [],
        rejectedDocuments: [],
        canProceedToAgreement: true,
      },
    });

    const v1Response = await fetch(
      `${baseUrl}/api/v1/documents/trainer/507f1f77bcf86cd799439032/move-to-review`,
      { method: "PUT" },
    );
    const v1Payload = await v1Response.json();

    assert.equal(v1Response.status, 200);
    assert.equal(v1Payload.success, true);
    assert.equal(v1Payload.error, null);
    assert.deepEqual(v1Payload.data, legacyPayload.data);
  } finally {
    await stopServer(server);
  }
};

const runDocumentsMoveToReviewInvalidTrainerIdCase = async () => {
  const app = express();
  const router = express.Router();

  router.put(
    "/trainer/:trainerId/move-to-review",
    createMoveToReviewController({
      getMoveToReviewFeed: async () => {
        const error = new Error("Invalid trainer ID");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/invalid-id/move-to-review`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid trainer ID",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsMoveToReviewNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.put(
    "/trainer/:trainerId/move-to-review",
    createMoveToReviewController({
      getMoveToReviewFeed: async () => {
        const error = new Error("Trainer not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439033/move-to-review`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsMoveToReviewMissingDocsInvalidStateCase = async () => {
  const app = express();
  const router = express.Router();

  router.put(
    "/trainer/:trainerId/move-to-review",
    createMoveToReviewController({
      getMoveToReviewFeed: async () => {
        const error = new Error("Trainer is still missing required documents");
        error.statusCode = 400;
        error.data = {
          missingDocuments: [{ key: "pan", label: "PAN Card" }],
        };
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439034/move-to-review`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer is still missing required documents",
      data: {
        missingDocuments: [{ key: "pan", label: "PAN Card" }],
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsMoveToReviewRejectedDocsInvalidStateCase = async () => {
  const app = express();
  const router = express.Router();

  router.put(
    "/trainer/:trainerId/move-to-review",
    createMoveToReviewController({
      getMoveToReviewFeed: async () => {
        const error = new Error(
          "Trainer has rejected documents and cannot move to review",
        );
        error.statusCode = 400;
        error.data = {
          rejectedDocuments: [{ key: "resumePdf", label: "Resume" }],
        };
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439035/move-to-review`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer has rejected documents and cannot move to review",
      data: {
        rejectedDocuments: [{ key: "resumePdf", label: "Resume" }],
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsMoveToReviewReviewGateParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.put(
    "/trainer/:trainerId/move-to-review",
    createMoveToReviewController({
      getMoveToReviewFeed: async () => {
        const error = new Error(
          "Trainer must complete Agreement before moving to admin review",
        );
        error.statusCode = 400;
        error.data = {
          nextStep: 4,
          nextStepLabel: "Agreement",
        };
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439036/move-to-review`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer must complete Agreement before moving to admin review",
      data: {
        nextStep: 4,
        nextStepLabel: "Agreement",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsMoveToReviewErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.put(
    "/trainer/:trainerId/move-to-review",
    createMoveToReviewController({
      getMoveToReviewFeed: async () => {
        throw new Error("move-to-review dependency failed");
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439037/move-to-review`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to move trainer to review",
      error: "move-to-review dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDocumentsSubmitVerificationRouteFamilyCompatibilityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-SUBMIT-API-1", role: "Trainer" };
    next();
  });

  router.put(
    "/submit-verification",
    createSubmitVerificationController({
      getSubmitVerificationFeed: async ({ actorUserId, actorRole }) => {
        assert.equal(actorUserId, "USER-SUBMIT-API-1");
        assert.equal(actorRole, "Trainer");
        return {
          success: true,
          message: "Profile submitted for verification successfully",
          data: {
            verificationStatus: "pending",
            documentStatus: "under_review",
          },
        };
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  app.use("/api/v1/documents", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const legacyResponse = await fetch(
      `${baseUrl}/api/trainer-documents/submit-verification`,
      { method: "PUT" },
    );
    const legacyPayload = await legacyResponse.json();

    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(legacyPayload, {
      success: true,
      message: "Profile submitted for verification successfully",
      data: {
        verificationStatus: "pending",
        documentStatus: "under_review",
      },
    });

    const v1Response = await fetch(
      `${baseUrl}/api/v1/documents/submit-verification`,
      { method: "PUT" },
    );
    const v1Payload = await v1Response.json();

    assert.equal(v1Response.status, 200);
    assert.equal(v1Payload.success, true);
    assert.equal(v1Payload.error, null);
    assert.deepEqual(v1Payload.data, legacyPayload.data);
  } finally {
    await stopServer(server);
  }
};

const runDocumentsSubmitVerificationNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.put(
    "/submit-verification",
    createSubmitVerificationController({
      getSubmitVerificationFeed: async () => {
        const error = new Error("Trainer profile not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/submit-verification`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer profile not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsSubmitVerificationMissingDocsParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.put(
    "/submit-verification",
    createSubmitVerificationController({
      getSubmitVerificationFeed: async () => {
        const error = new Error(
          "Please upload all required documents first. Missing: pan",
        );
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/submit-verification`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Please upload all required documents first. Missing: pan",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsSubmitVerificationReviewGateParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.put(
    "/submit-verification",
    createSubmitVerificationController({
      getSubmitVerificationFeed: async () => {
        const error = new Error(
          "Complete Agreement before submitting for admin review",
        );
        error.statusCode = 400;
        error.data = {
          nextStep: 4,
          nextStepLabel: "Agreement",
        };
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/submit-verification`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Complete Agreement before submitting for admin review",
      data: {
        nextStep: 4,
        nextStepLabel: "Agreement",
      },
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsSubmitVerificationErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.put(
    "/submit-verification",
    createSubmitVerificationController({
      getSubmitVerificationFeed: async () => {
        throw new Error("submit-verification dependency failed");
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/submit-verification`,
      { method: "PUT" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to submit for verification",
      error: "submit-verification dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDocumentsUploadRouteFamilyCompatibilityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  app.use((req, _res, next) => {
    req.user = { id: "USER-UPLOAD-API-1", role: "Admin" };
    req.file = {
      originalname: "pan.pdf",
      mimetype: "application/pdf",
      size: 5120,
      buffer: Buffer.from("pdf"),
    };
    next();
  });

  router.post(
    "/upload",
    createUploadDocumentController({
      getUploadDocumentFeed: async ({ payload, file, actorUser }) => {
        assert.equal(payload.documentType, "pan");
        assert.equal(payload.targetTrainerId, "507f1f77bcf86cd799439091");
        assert.equal(file.originalname, "pan.pdf");
        assert.equal(actorUser.id, "USER-UPLOAD-API-1");
        return {
          success: true,
          message: "Document uploaded successfully",
          data: {
            id: "DOC-UPLOAD-API-1",
            documentType: "pan",
            filePath: "https://drive.google.com/pan",
            verificationStatus: "PENDING",
            normalizedStatus: "pending",
          },
        };
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  app.use("/api/v1/documents", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const body = {
      documentType: "pan",
      targetTrainerId: "507f1f77bcf86cd799439091",
    };

    const legacyResponse = await fetch(`${baseUrl}/api/trainer-documents/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const legacyPayload = await legacyResponse.json();

    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(legacyPayload, {
      success: true,
      message: "Document uploaded successfully",
      data: {
        id: "DOC-UPLOAD-API-1",
        documentType: "pan",
        filePath: "https://drive.google.com/pan",
        verificationStatus: "PENDING",
        normalizedStatus: "pending",
      },
    });

    const v1Response = await fetch(`${baseUrl}/api/v1/documents/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const v1Payload = await v1Response.json();

    assert.equal(v1Response.status, 200);
    assert.equal(v1Payload.success, true);
    assert.equal(v1Payload.error, null);
    assert.deepEqual(v1Payload.data, legacyPayload.data);
  } finally {
    await stopServer(server);
  }
};

const runDocumentsUploadMiddlewareFieldMappingParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.post("/upload", uploadTrainerDocumentMiddleware, (req, res) => {
    res.json({
      success: true,
      fieldname: req.file?.fieldname || null,
      mimetype: req.file?.mimetype || null,
    });
  });

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const documentForm = new FormData();
    documentForm.append(
      "document",
      new Blob([Buffer.from("pdf-data")], { type: "application/pdf" }),
      "document.pdf",
    );

    const documentResponse = await fetch(
      `${baseUrl}/api/trainer-documents/upload`,
      {
        method: "POST",
        body: documentForm,
      },
    );
    const documentPayload = await documentResponse.json();

    assert.equal(documentResponse.status, 200);
    assert.deepEqual(documentPayload, {
      success: true,
      fieldname: "document",
      mimetype: "application/pdf",
    });

    const fileForm = new FormData();
    fileForm.append(
      "file",
      new Blob([Buffer.from("image-data")], { type: "image/png" }),
      "photo.png",
    );

    const fileResponse = await fetch(`${baseUrl}/api/trainer-documents/upload`, {
      method: "POST",
      body: fileForm,
    });
    const filePayload = await fileResponse.json();

    assert.equal(fileResponse.status, 200);
    assert.deepEqual(filePayload, {
      success: true,
      fieldname: "file",
      mimetype: "image/png",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsUploadMissingFileParityCase = async () => {
  const app = express();
  const router = express.Router();
  app.use(express.json());

  router.post(
    "/upload",
    createUploadDocumentController({
      getUploadDocumentFeed: async () => {
        const error = new Error("No file uploaded");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/trainer-documents/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentType: "pan" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "No file uploaded",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsUploadDriveSetupErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;
  app.use(express.json());

  router.post(
    "/upload",
    createUploadDocumentController({
      getUploadDocumentFeed: async () => {
        throw new Error("Google Drive setup issue: domain-wide delegation missing");
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/trainer-documents/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentType: "pan" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Google Drive setup issue: domain-wide delegation missing",
      error: "Google Drive setup issue: domain-wide delegation missing",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDocumentsUploadErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;
  app.use(express.json());

  router.post(
    "/upload",
    createUploadDocumentController({
      getUploadDocumentFeed: async () => {
        throw new Error("upload dependency failed");
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/trainer-documents/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentType: "pan" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "upload dependency failed",
      error: "upload dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runDocumentsTrainerApproachRouteFamilyCompatibilityCase = async () => {
  const app = express();
  const router = express.Router();

  app.use((req, _res, next) => {
    req.user = { id: "USER-ADMIN-APPROACH-1", role: "Admin" };
    next();
  });

  router.post(
    "/trainer/:trainerId/approach",
    createTrainerApproachController({
      getTrainerApproachFeed: async ({ trainerId, actorUserId, actorRole }) => {
        assert.equal(trainerId, "507f1f77bcf86cd799439027");
        assert.equal(actorUserId, "USER-ADMIN-APPROACH-1");
        assert.equal(actorRole, "Admin");
        return {
          success: true,
          message: "Reminder email sent to trainer successfully",
          data: {
            documentStatus: "rejected",
            missingDocuments: [{ key: "resumePdf", label: "Resume" }],
            rejectedDocuments: [],
            lastApproachedAt: "2026-04-04T00:00:00.000Z",
          },
        };
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  app.use("/api/v1/documents", v1ResponseEnvelope, router);
  const { server, baseUrl } = await startServer(app);

  try {
    const legacyResponse = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439027/approach`,
      { method: "POST" },
    );
    const legacyPayload = await legacyResponse.json();

    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(legacyPayload, {
      success: true,
      message: "Reminder email sent to trainer successfully",
      data: {
        documentStatus: "rejected",
        missingDocuments: [{ key: "resumePdf", label: "Resume" }],
        rejectedDocuments: [],
        lastApproachedAt: "2026-04-04T00:00:00.000Z",
      },
    });

    const v1Response = await fetch(
      `${baseUrl}/api/v1/documents/trainer/507f1f77bcf86cd799439027/approach`,
      { method: "POST" },
    );
    const v1Payload = await v1Response.json();

    assert.equal(v1Response.status, 200);
    assert.equal(v1Payload.success, true);
    assert.equal(v1Payload.error, null);
    assert.deepEqual(v1Payload.data, legacyPayload.data);
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerApproachInvalidTrainerIdCase = async () => {
  const app = express();
  const router = express.Router();

  router.post(
    "/trainer/:trainerId/approach",
    createTrainerApproachController({
      getTrainerApproachFeed: async () => {
        const error = new Error("Invalid trainer ID");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/invalid-id/approach`,
      { method: "POST" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Invalid trainer ID",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerApproachAccessDeniedCase = async () => {
  const app = express();
  const router = express.Router();

  router.post(
    "/trainer/:trainerId/approach",
    createTrainerApproachController({
      getTrainerApproachFeed: async () => {
        const error = new Error("Access denied");
        error.statusCode = 403;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439028/approach`,
      { method: "POST" },
    );
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, {
      success: false,
      message: "Access denied",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerApproachNoOutstandingDocumentsCase = async () => {
  const app = express();
  const router = express.Router();

  router.post(
    "/trainer/:trainerId/approach",
    createTrainerApproachController({
      getTrainerApproachFeed: async () => {
        const error = new Error("This trainer has no missing or rejected documents.");
        error.statusCode = 400;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439029/approach`,
      { method: "POST" },
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "This trainer has no missing or rejected documents.",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerApproachNotFoundParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.post(
    "/trainer/:trainerId/approach",
    createTrainerApproachController({
      getTrainerApproachFeed: async () => {
        const error = new Error("Trainer not found");
        error.statusCode = 404;
        throw error;
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439030/approach`,
      { method: "POST" },
    );
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      success: false,
      message: "Trainer not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runDocumentsTrainerApproachErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.post(
    "/trainer/:trainerId/approach",
    createTrainerApproachController({
      getTrainerApproachFeed: async () => {
        throw new Error("approach dependency failed");
      },
    }),
  );

  app.use("/api/trainer-documents", router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(
      `${baseUrl}/api/trainer-documents/trainer/507f1f77bcf86cd799439031/approach`,
      { method: "POST" },
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      success: false,
      message: "Failed to send trainer reminder",
      error: "approach dependency failed",
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runInternalMetricsSnapshotDisabledCase = async () => {
  const app = express();
  let authInvoked = false;
  const router = createInternalMetricsRouter({
    enabled: false,
    authenticate: (_req, _res, next) => {
      authInvoked = true;
      next();
    },
    authorizeSuperAdmin: (_req, _res, next) => next(),
  });

  app.use("/api/internal/metrics", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/internal/metrics/queues/file-workflow`,
    );
    const payload = await response.json();
    const aggregateResponse = await fetch(
      `${baseUrl}/api/internal/metrics/queues`,
    );
    const aggregatePayload = await aggregateResponse.json();

    assert.equal(response.status, 404);
    assert.equal(aggregateResponse.status, 404);
    assert.equal(authInvoked, false);
    assert.deepEqual(payload, {
      success: false,
      message: "Not found",
    });
    assert.deepEqual(aggregatePayload, {
      success: false,
      message: "Not found",
    });
  } finally {
    await stopServer(server);
  }
};

const runInternalMetricsAllQueuesAuthDeniedCase = async () => {
  const app = express();
  let authorizeInvoked = false;
  let snapshotInvoked = false;

  const router = createInternalMetricsRouter({
    enabled: true,
    authenticate: (_req, res) =>
      res.status(401).json({
        success: false,
        message: "Unauthorized",
      }),
    authorizeSuperAdmin: (_req, _res, next) => {
      authorizeInvoked = true;
      next();
    },
    getAllQueueSnapshots: () => {
      snapshotInvoked = true;
      return { generatedAt: "noop", queues: {}, totals: {} };
    },
  });

  app.use("/api/internal/metrics", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/internal/metrics/queues`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.message, "Unauthorized");
    assert.equal(authorizeInvoked, false);
    assert.equal(snapshotInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runInternalMetricsAllQueuesRoleDeniedCase = async () => {
  const app = express();
  let snapshotInvoked = false;

  const router = createInternalMetricsRouter({
    enabled: true,
    authenticate: (req, _res, next) => {
      req.user = {
        id: "USER-NON-SUPERADMIN-1",
        role: "Trainer",
      };
      next();
    },
    authorizeSuperAdmin: (_req, res) =>
      res.status(403).json({
        success: false,
        message: "Forbidden",
      }),
    getAllQueueSnapshots: () => {
      snapshotInvoked = true;
      return { generatedAt: "noop", queues: {}, totals: {} };
    },
  });

  app.use("/api/internal/metrics", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/internal/metrics/queues`);
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.equal(payload.success, false);
    assert.equal(payload.message, "Forbidden");
    assert.equal(snapshotInvoked, false);
  } finally {
    await stopServer(server);
  }
};

const runInternalMetricsAllQueuesEnabledCase = async () => {
  const app = express();
  const expectedSnapshot = {
    generatedAt: "2026-04-05T00:00:00.000Z",
    queues: {
      fileWorkflow: {
        totals: {
          queued: 1,
          started: 1,
          succeeded: 1,
          failed: 0,
          retried: 0,
          dropped: 0,
          enqueueFailed: 0,
          parseFailed: 0,
        },
        byType: {
          "attendance.drive.sync": {
            queued: 1,
            started: 1,
            succeeded: 1,
            failed: 0,
            retried: 0,
            dropped: 0,
            enqueueFailed: 0,
            parseFailed: 0,
          },
        },
        lastUpdatedAt: "2026-04-05T00:00:00.000Z",
      },
    },
    totals: {
      queued: 1,
      started: 1,
      succeeded: 1,
      failed: 0,
      retried: 0,
      dropped: 0,
      enqueueFailed: 0,
      parseFailed: 0,
    },
  };

  const router = createInternalMetricsRouter({
    enabled: true,
    authenticate: (req, _res, next) => {
      req.user = {
        id: "USER-SUPERADMIN-2",
        role: "SuperAdmin",
      };
      next();
    },
    authorizeSuperAdmin: (_req, _res, next) => next(),
    getAllQueueSnapshots: () => expectedSnapshot,
  });

  app.use("/api/internal/metrics", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/internal/metrics/queues`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, expectedSnapshot);
  } finally {
    await stopServer(server);
  }
};

const runInternalMetricsSnapshotEnabledCase = async () => {
  const app = express();
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
    outcome: "succeeded",
  });

  const router = createInternalMetricsRouter({
    enabled: true,
    authenticate: (req, _res, next) => {
      req.user = {
        id: "USER-SUPERADMIN-1",
        role: "SuperAdmin",
      };
      next();
    },
    authorizeSuperAdmin: (_req, _res, next) => next(),
    getQueueSnapshot: getFileWorkflowQueueMetricsSnapshot,
  });

  app.use("/api/internal/metrics", router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(
      `${baseUrl}/api/internal/metrics/queues/file-workflow`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.queue, "file-workflow");
    assert.equal(payload.data.snapshot.totals.queued, 1);
    assert.equal(payload.data.snapshot.totals.started, 1);
    assert.equal(payload.data.snapshot.totals.succeeded, 1);
    assert.equal(
      payload.data.snapshot.byType["attendance.drive.sync"].queued,
      1,
    );
    assert.equal(typeof payload.data.snapshot.lastUpdatedAt, "string");
  } finally {
    await stopServer(server);
    resetFileWorkflowQueueMetrics();
  }
};

const runVerifyAttendanceDocumentLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();
  
  let syncHelperCalled = false;
  let emitHelperCalled = false;

  router.post(
    "/verify-document",
    createVerifyAttendanceDocumentController({
        verifyDocumentPayload: async ({ documentId, spocId, user }) => {
            assert.equal(documentId, "64082dc851fd1b0012ced111");
            return {
                success: true,
                message: "Document verified successfully",
                data: { _id: "64082dc851fd1b0012ced111", status: "verified" },
                meta: {
                    scheduleId: "SCH-123",
                    attendanceId: "ATT-123",
                    attendance: { _id: "ATT-123" }
                }
            };
        },
        syncScheduleDayStateHelper: async ({ scheduleId, attendance }) => {
            syncHelperCalled = true;
            assert.equal(scheduleId, "SCH-123");
            assert.equal(attendance._id, "ATT-123");
            return { dayStatus: "pending" };
        },
        emitRealtimeUpdateHelper: (req, payload) => {
            emitHelperCalled = true;
            assert.equal(payload.scheduleId, "SCH-123");
            assert.equal(payload.type, "DOCUMENT_VERIFICATION_UPDATE");
        }
    })
  );

  app.use("/api/attendance", express.json(), router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/verify-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: "64082dc851fd1b0012ced111", spocId: "64082dc851fd1b0012ced222" })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
        success: true,
        message: "Document verified successfully",
        data: { _id: "64082dc851fd1b0012ced111", status: "verified" }
    });
    assert.equal(syncHelperCalled, true);
    assert.equal(emitHelperCalled, true);
  } finally {
    await stopServer(server);
  }
};

const runVerifyAttendanceDocumentInvalidPayloadParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.post(
    "/verify-document",
    createVerifyAttendanceDocumentController({
        verifyDocumentPayload: async () => {}
    })
  );

  app.use("/api/attendance", express.json(), router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/verify-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: "invalid-id" })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
        success: false,
        message: "Valid documentId is required"
    });
  } finally {
    await stopServer(server);
  }
};

const runVerifyAttendanceDocumentErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.post(
    "/verify-document",
    createVerifyAttendanceDocumentController({
        verifyDocumentPayload: async () => {
            throw new Error("Failed validation");
        }
    })
  );

  app.use("/api/attendance", express.json(), router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/verify-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: "64082dc851fd1b0012ced111" })
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
        success: false,
        message: "Failed to verify document",
        error: "Failed validation"
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runRejectAttendanceDocumentLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();
  
  let syncHelperCalled = false;
  let emitHelperCalled = false;

  router.post(
    "/reject-document",
    createRejectAttendanceDocumentController({
        rejectDocumentPayload: async ({ documentId, spocId, rejectReason, user }) => {
            assert.equal(documentId, "64082dc851fd1b0012ced111");
            assert.equal(rejectReason, "Incorrect photo");
            return {
                success: true,
                message: "Document rejected successfully",
                data: { _id: "64082dc851fd1b0012ced111", status: "rejected", rejectReason: "Incorrect photo" },
                meta: {
                    scheduleId: "SCH-123",
                    attendanceId: "ATT-123",
                    attendance: { _id: "ATT-123" }
                }
            };
        },
        syncScheduleDayStateHelper: async ({ scheduleId, attendance }) => {
            syncHelperCalled = true;
            assert.equal(scheduleId, "SCH-123");
            assert.equal(attendance._id, "ATT-123");
            return { dayStatus: "pending" };
        },
        emitRealtimeUpdateHelper: (req, payload) => {
            emitHelperCalled = true;
            assert.equal(payload.scheduleId, "SCH-123");
            assert.equal(payload.type, "DOCUMENT_VERIFICATION_UPDATE");
        }
    })
  );

  app.use("/api/attendance", express.json(), router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/reject-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            documentId: "64082dc851fd1b0012ced111", 
            spocId: "64082dc851fd1b0012ced222",
            rejectReason: "Incorrect photo"
        })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
        success: true,
        message: "Document rejected successfully",
        data: { _id: "64082dc851fd1b0012ced111", status: "rejected", rejectReason: "Incorrect photo" }
    });
    assert.equal(syncHelperCalled, true);
    assert.equal(emitHelperCalled, true);
  } finally {
    await stopServer(server);
  }
};

const runRejectAttendanceDocumentInvalidPayloadParityCase = async () => {
  const app = express();
  const router = express.Router();

  router.post(
    "/reject-document",
    createRejectAttendanceDocumentController({
        rejectDocumentPayload: async () => {}
    })
  );

  app.use("/api/attendance", express.json(), router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/reject-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: "invalid-id" })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
        success: false,
        message: "Valid documentId is required"
    });
  } finally {
    await stopServer(server);
  }
};

const runRejectAttendanceDocumentErrorParityCase = async () => {
  const app = express();
  const router = express.Router();
  const originalConsoleError = console.error;

  router.post(
    "/reject-document",
    createRejectAttendanceDocumentController({
        rejectDocumentPayload: async () => {
            throw new Error("Failed rejection");
        }
    })
  );

  app.use("/api/attendance", express.json(), router);
  const { server, baseUrl } = await startServer(app);

  try {
    console.error = () => {};
    const response = await fetch(`${baseUrl}/api/attendance/reject-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: "64082dc851fd1b0012ced111" })
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
        success: false,
        message: "Failed to reject document",
        error: "Failed rejection"
    });
  } finally {
    console.error = originalConsoleError;
    await stopServer(server);
  }
};

const runVerifyGeoTagLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  let lifecycleHelperCalled = false;
  let syncHelperCalled = false;
  let emitHelperCalled = false;

  router.post(
    "/verify-geo",
    createVerifyGeoTagController({
      verifyGeoPayload: async ({ attendanceId, spocId }) => {
        assert.equal(attendanceId, "64082dc851fd1b0012ced911");
        assert.equal(spocId, "64082dc851fd1b0012ced222");
        return {
          success: true,
          message: "Geo-tag verification approved manually",
          data: {
            _id: "64082dc851fd1b0012ced911",
            geoVerificationStatus: "approved",
            checkOutVerificationStatus: "VERIFIED",
            checkOutVerificationMode: "MANUAL",
            finalStatus: "COMPLETED",
          },
          meta: {
            scheduleId: "SCH-GEO-123",
            attendanceId: "ATT-GEO-123",
            attendance: {
              _id: "ATT-GEO-123",
              verificationStatus: "approved",
              geoVerificationStatus: "approved",
              finalStatus: "COMPLETED",
            },
          },
        };
      },
      syncScheduleLifecycleStatusHelper: async ({ scheduleId, attendance }) => {
        lifecycleHelperCalled = true;
        assert.equal(scheduleId, "SCH-GEO-123");
        assert.equal(attendance._id, "ATT-GEO-123");
      },
      syncScheduleDayStateHelper: async ({ scheduleId, attendance }) => {
        syncHelperCalled = true;
        assert.equal(scheduleId, "SCH-GEO-123");
        assert.equal(attendance._id, "ATT-GEO-123");
        return { dayStatus: "completed", attendanceUploaded: true, geoTagUploaded: true };
      },
      emitRealtimeUpdateHelper: (_req, payload) => {
        emitHelperCalled = true;
        assert.equal(payload.scheduleId, "SCH-GEO-123");
        assert.equal(payload.type, "GEO_VERIFICATION_UPDATE");
        assert.equal(payload.dayStatus, "completed");
      },
    }),
  );

  app.use("/api/attendance", express.json(), router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/verify-geo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attendanceId: "64082dc851fd1b0012ced911",
        spocId: "64082dc851fd1b0012ced222",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.checkOutVerificationStatus, "VERIFIED");
    assert.equal(payload.data.checkOutVerificationMode, "MANUAL");
    assert.equal(payload.data.finalStatus, "COMPLETED");
    assert.equal(lifecycleHelperCalled, true);
    assert.equal(syncHelperCalled, true);
    assert.equal(emitHelperCalled, true);
  } finally {
    await stopServer(server);
  }
};

const runRejectGeoTagLegacyRouteSuccessCase = async () => {
  const app = express();
  const router = express.Router();

  let lifecycleHelperCalled = false;
  let syncHelperCalled = false;
  let emitHelperCalled = false;

  router.post(
    "/reject-geo",
    createRejectGeoTagController({
      rejectGeoPayload: async ({ attendanceId, spocId, reason }) => {
        assert.equal(attendanceId, "64082dc851fd1b0012ced912");
        assert.equal(spocId, "64082dc851fd1b0012ced222");
        assert.equal(reason, "GPS mismatch");
        return {
          success: true,
          message: "Geo-tag verification rejected manually",
          data: {
            _id: "64082dc851fd1b0012ced912",
            geoVerificationStatus: "rejected",
            checkOutVerificationStatus: "REJECTED",
            checkOutVerificationMode: "MANUAL",
            finalStatus: "PENDING",
          },
          meta: {
            scheduleId: "SCH-GEO-124",
            attendanceId: "ATT-GEO-124",
            attendance: {
              _id: "ATT-GEO-124",
              verificationStatus: "approved",
              geoVerificationStatus: "rejected",
              finalStatus: "PENDING",
            },
          },
        };
      },
      syncScheduleLifecycleStatusHelper: async ({ scheduleId, attendance }) => {
        lifecycleHelperCalled = true;
        assert.equal(scheduleId, "SCH-GEO-124");
        assert.equal(attendance._id, "ATT-GEO-124");
      },
      syncScheduleDayStateHelper: async ({ scheduleId, attendance }) => {
        syncHelperCalled = true;
        assert.equal(scheduleId, "SCH-GEO-124");
        assert.equal(attendance._id, "ATT-GEO-124");
        return { dayStatus: "pending", attendanceUploaded: true, geoTagUploaded: true };
      },
      emitRealtimeUpdateHelper: (_req, payload) => {
        emitHelperCalled = true;
        assert.equal(payload.scheduleId, "SCH-GEO-124");
        assert.equal(payload.type, "GEO_VERIFICATION_UPDATE");
        assert.equal(payload.dayStatus, "pending");
      },
    }),
  );

  app.use("/api/attendance", express.json(), router);
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/attendance/reject-geo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attendanceId: "64082dc851fd1b0012ced912",
        spocId: "64082dc851fd1b0012ced222",
        reason: "GPS mismatch",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.checkOutVerificationStatus, "REJECTED");
    assert.equal(payload.data.checkOutVerificationMode, "MANUAL");
    assert.equal(payload.data.finalStatus, "PENDING");
    assert.equal(lifecycleHelperCalled, true);
    assert.equal(syncHelperCalled, true);
    assert.equal(emitHelperCalled, true);
  } finally {
    await stopServer(server);
  }
};

const tests = [
  {
    name: "v1 envelope wraps successful payloads",
    run: runSuccessEnvelopeCase,
  },
  {
    name: "v1 envelope wraps error payloads",
    run: runErrorEnvelopeCase,
  },
  {
    name: "attendance schedule endpoint keeps legacy success response shape",
    run: runAttendanceScheduleLegacyRouteSuccessCase,
  },
  {
    name: "attendance schedule endpoint keeps no-auth access parity",
    run: runAttendanceScheduleNoAuthAccessParityCase,
  },
  {
    name: "attendance schedule endpoint keeps empty-list not-found parity",
    run: runAttendanceScheduleNotFoundParityCase,
  },
  {
    name: "attendance schedule endpoint keeps invalid-id error parity",
    run: runAttendanceScheduleInvalidIdErrorParityCase,
  },
  {
    name: "attendance schedule endpoint keeps legacy 500 error mapping parity",
    run: runAttendanceScheduleErrorParityCase,
  },
  {
    name: "attendance details endpoint keeps legacy success response shape",
    run: runAttendanceDetailsLegacyRouteSuccessCase,
  },
  {
    name: "attendance details endpoint keeps no-auth access parity",
    run: runAttendanceDetailsNoAuthAccessParityCase,
  },
  {
    name: "attendance details endpoint keeps not-found parity",
    run: runAttendanceDetailsNotFoundParityCase,
  },
  {
    name: "attendance details endpoint keeps invalid-id error parity",
    run: runAttendanceDetailsInvalidIdErrorParityCase,
  },
  {
    name: "attendance details endpoint keeps legacy 500 error mapping parity",
    run: runAttendanceDetailsErrorParityCase,
  },
  {
    name: "attendance trainer endpoint keeps legacy success response shape",
    run: runAttendanceTrainerLegacyRouteSuccessCase,
  },
  {
    name: "attendance trainer endpoint keeps no-auth access parity",
    run: runAttendanceTrainerNoAuthAccessParityCase,
  },
  {
    name: "attendance trainer endpoint keeps empty-list not-found parity",
    run: runAttendanceTrainerNotFoundParityCase,
  },
  {
    name: "attendance trainer endpoint keeps invalid-id error parity",
    run: runAttendanceTrainerInvalidIdErrorParityCase,
  },
  {
    name: "attendance trainer endpoint keeps legacy 500 error mapping parity",
    run: runAttendanceTrainerErrorParityCase,
  },
  {
    name: "attendance college endpoint keeps legacy success response shape",
    run: runAttendanceCollegeLegacyRouteSuccessCase,
  },
  {
    name: "attendance college endpoint keeps no-auth access parity",
    run: runAttendanceCollegeNoAuthAccessParityCase,
  },
  {
    name: "attendance college endpoint keeps empty-list not-found parity",
    run: runAttendanceCollegeNotFoundParityCase,
  },
  {
    name: "attendance college endpoint keeps invalid-id error parity",
    run: runAttendanceCollegeInvalidIdErrorParityCase,
  },
  {
    name: "attendance college endpoint keeps legacy 500 error mapping parity",
    run: runAttendanceCollegeErrorParityCase,
  },
  {
    name: "attendance documents endpoint keeps legacy success response shape",
    run: runAttendanceDocumentsLegacyRouteSuccessCase,
  },
  {
    name: "attendance documents endpoint keeps no-auth access parity",
    run: runAttendanceDocumentsNoAuthAccessParityCase,
  },
  {
    name: "attendance documents endpoint keeps invalid-objectid parity",
    run: runAttendanceDocumentsInvalidObjectIdParityCase,
  },
  {
    name: "attendance documents endpoint keeps invalid-status parity",
    run: runAttendanceDocumentsInvalidStatusParityCase,
  },
  {
    name: "attendance documents endpoint keeps invalid-fileType parity",
    run: runAttendanceDocumentsInvalidFileTypeParityCase,
  },
  {
    name: "attendance documents endpoint keeps legacy 500 error mapping parity",
    run: runAttendanceDocumentsErrorParityCase,
  },
  {
    name: "schedule details endpoint keeps legacy success response shape",
    run: runScheduleDetailsSuccessCase,
  },
  {
    name: "schedule details endpoint keeps legacy not-found behavior",
    run: runScheduleDetailsNotFoundCase,
  },
  {
    name: "schedule details endpoint keeps invalid-id error parity",
    run: runScheduleDetailsInvalidIdParityCase,
  },
  {
    name: "schedule associations endpoint keeps legacy success response shape",
    run: runScheduleAssociationsSuccessCase,
  },
  {
    name: "schedule associations endpoint keeps legacy empty-state behavior",
    run: runScheduleAssociationsEmptyStateCase,
  },
  {
    name: "schedule associations endpoint keeps legacy error parity",
    run: runScheduleAssociationsErrorParityCase,
  },
  {
    name: "create schedule endpoint keeps legacy success response shape",
    run: runCreateScheduleSuccessCase,
  },
  {
    name: "create schedule endpoint keeps permissive payload parity",
    run: runCreateSchedulePermissivePayloadCase,
  },
  {
    name: "create schedule endpoint keeps error parity",
    run: runCreateScheduleErrorParityCase,
  },
  {
    name: "bulk-create schedule endpoint keeps legacy success response shape",
    run: runBulkCreateScheduleSuccessCase,
  },
  {
    name: "bulk-create schedule endpoint keeps validation parity",
    run: runBulkCreateScheduleValidationParityCase,
  },
  {
    name: "bulk-create schedule endpoint keeps error parity",
    run: runBulkCreateScheduleErrorParityCase,
  },
  {
    name: "bulk-upload schedule endpoint keeps legacy success response shape",
    run: runBulkUploadScheduleSuccessCase,
  },
  {
    name: "bulk-upload schedule endpoint keeps upload-error parity",
    run: runBulkUploadScheduleUploadErrorParityCase,
  },
  {
    name: "bulk-upload schedule endpoint keeps validation parity",
    run: runBulkUploadScheduleValidationParityCase,
  },
  {
    name: "bulk-upload schedule endpoint keeps error parity",
    run: runBulkUploadScheduleErrorParityCase,
  },
  {
    name: "assign schedule endpoint keeps legacy success response shape",
    run: runAssignScheduleSuccessCase,
  },
  {
    name: "assign schedule endpoint keeps permissive payload parity",
    run: runAssignSchedulePermissiveBodyCase,
  },
  {
    name: "assign schedule endpoint keeps not-found behavior",
    run: runAssignScheduleNotFoundCase,
  },
  {
    name: "assign schedule endpoint keeps error parity",
    run: runAssignScheduleErrorParityCase,
  },
  {
    name: "update schedule endpoint keeps legacy success response shape",
    run: runUpdateScheduleSuccessCase,
  },
  {
    name: "update schedule endpoint keeps permissive payload parity",
    run: runUpdateSchedulePermissiveBodyCase,
  },
  {
    name: "update schedule endpoint keeps not-found behavior",
    run: runUpdateScheduleNotFoundCase,
  },
  {
    name: "update schedule endpoint keeps error parity",
    run: runUpdateScheduleErrorParityCase,
  },
  {
    name: "delete schedule endpoint keeps legacy success response shape",
    run: runDeleteScheduleSuccessCase,
  },
  {
    name: "delete schedule endpoint keeps reason precedence parity",
    run: runDeleteScheduleReasonPrecedenceCase,
  },
  {
    name: "delete schedule endpoint keeps not-found behavior",
    run: runDeleteScheduleNotFoundCase,
  },
  {
    name: "delete schedule endpoint keeps error parity",
    run: runDeleteScheduleErrorParityCase,
  },
  {
    name: "chat validation logs endpoint keeps legacy success response shape",
    run: runChatValidationLogsLegacyRouteSuccessCase,
  },
  {
    name: "chat validation logs endpoint keeps auth denial behavior",
    run: runChatValidationLogsAuthDeniedCase,
  },
  {
    name: "chat validation logs endpoint keeps requester-not-found parity",
    run: runChatValidationLogsNotFoundParityCase,
  },
  {
    name: "chat validation logs endpoint keeps error parity",
    run: runChatValidationLogsErrorParityCase,
  },
  {
    name: "chat bootstrap endpoint keeps legacy success response shape",
    run: runChatBootstrapLegacyRouteSuccessCase,
  },
  {
    name: "chat bootstrap endpoint keeps auth denial behavior",
    run: runChatBootstrapAuthDeniedCase,
  },
  {
    name: "chat bootstrap endpoint keeps explicit user-not-found guard parity",
    run: runChatBootstrapUserNotFoundParityCase,
  },
  {
    name: "chat bootstrap endpoint keeps 500 error parity",
    run: runChatBootstrapErrorParityCase,
  },
  {
    name: "chat quick-bootstrap endpoint keeps legacy success response shape",
    run: runChatQuickBootstrapLegacyRouteSuccessCase,
  },
  {
    name: "chat quick-bootstrap endpoint keeps auth denial behavior",
    run: runChatQuickBootstrapAuthDeniedCase,
  },
  {
    name: "chat quick-bootstrap endpoint keeps explicit user-not-found guard parity",
    run: runChatQuickBootstrapUserNotFoundParityCase,
  },
  {
    name: "chat quick-bootstrap endpoint keeps 500 error parity",
    run: runChatQuickBootstrapErrorParityCase,
  },
  {
    name: "chat full-bootstrap endpoint keeps legacy success response shape",
    run: runChatFullBootstrapLegacyRouteSuccessCase,
  },
  {
    name: "chat full-bootstrap endpoint keeps auth denial behavior",
    run: runChatFullBootstrapAuthDeniedCase,
  },
  {
    name: "chat full-bootstrap endpoint keeps explicit user-not-found guard parity",
    run: runChatFullBootstrapUserNotFoundParityCase,
  },
  {
    name: "chat full-bootstrap endpoint keeps 500 error parity",
    run: runChatFullBootstrapErrorParityCase,
  },
  {
    name: "chat create endpoint keeps legacy success response shape",
    run: runChatCreateLegacyRouteSuccessCase,
  },
  {
    name: "chat create endpoint keeps auth denial behavior",
    run: runChatCreateAuthDeniedCase,
  },
  {
    name: "chat create endpoint keeps validation parity",
    run: runChatCreateValidationParityCase,
  },
  {
    name: "chat create endpoint keeps not-found parity",
    run: runChatCreateNotFoundParityCase,
  },
  {
    name: "chat create endpoint keeps 500 error parity",
    run: runChatCreateErrorParityCase,
  },
  {
    name: "chat direct endpoint keeps legacy success response shape",
    run: runChatDirectLegacyRouteSuccessCase,
  },
  {
    name: "chat direct endpoint keeps auth denial behavior",
    run: runChatDirectAuthDeniedCase,
  },
  {
    name: "chat direct endpoint keeps role denial behavior",
    run: runChatDirectRoleDeniedCase,
  },
  {
    name: "chat direct endpoint keeps validation/status passthrough parity",
    run: runChatDirectValidationParityCase,
  },
  {
    name: "chat direct endpoint keeps legacy error mapping parity",
    run: runChatDirectErrorParityCase,
  },
  {
    name: "chat group create endpoint keeps legacy success response shape",
    run: runChatGroupCreateLegacyRouteSuccessCase,
  },
  {
    name: "chat group create endpoint keeps auth denial behavior",
    run: runChatGroupCreateAuthDeniedCase,
  },
  {
    name: "chat group create endpoint keeps role denial behavior",
    run: runChatGroupCreateRoleDeniedCase,
  },
  {
    name: "chat group create endpoint keeps validation/status passthrough parity",
    run: runChatGroupCreateValidationStatusParityCase,
  },
  {
    name: "chat group create endpoint keeps legacy error mapping parity",
    run: runChatGroupCreateErrorParityCase,
  },
  {
    name: "chat broadcast endpoint keeps announcement success response shape",
    run: runChatBroadcastAnnouncementLegacyRouteSuccessCase,
  },
  {
    name: "chat broadcast endpoint keeps channel-create success response shape",
    run: runChatBroadcastChannelLegacyRouteSuccessCase,
  },
  {
    name: "chat broadcast endpoint keeps auth denial behavior",
    run: runChatBroadcastAuthDeniedCase,
  },
  {
    name: "chat broadcast endpoint keeps role denial behavior",
    run: runChatBroadcastRoleDeniedCase,
  },
  {
    name: "chat broadcast endpoint keeps validation/status passthrough parity",
    run: runChatBroadcastValidationStatusParityCase,
  },
  {
    name: "chat broadcast endpoint keeps legacy error mapping parity",
    run: runChatBroadcastErrorParityCase,
  },
  {
    name: "chat message-send endpoint keeps legacy success response shape",
    run: runChatMessageSendLegacyRouteSuccessCase,
  },
  {
    name: "chat message-send endpoint keeps auth denial behavior",
    run: runChatMessageSendAuthDeniedCase,
  },
  {
    name: "chat message-send endpoint keeps validation/status passthrough parity",
    run: runChatMessageSendValidationStatusParityCase,
  },
  {
    name: "chat message-send endpoint keeps legacy error mapping parity",
    run: runChatMessageSendErrorParityCase,
  },
  {
    name: "chat channel leave endpoint keeps legacy success response shape",
    run: runChatChannelLeaveLegacyRouteSuccessCase,
  },
  {
    name: "chat channel leave endpoint keeps auth denial behavior",
    run: runChatChannelLeaveAuthDeniedCase,
  },
  {
    name: "chat channel leave endpoint keeps validation/status passthrough parity",
    run: runChatChannelLeaveValidationStatusParityCase,
  },
  {
    name: "chat channel leave endpoint keeps legacy error mapping parity",
    run: runChatChannelLeaveErrorParityCase,
  },
  {
    name: "chat channel clear-messages endpoint keeps legacy success response shape",
    run: runChatChannelClearMessagesLegacyRouteSuccessCase,
  },
  {
    name: "chat channel clear-messages endpoint keeps auth denial behavior",
    run: runChatChannelClearMessagesAuthDeniedCase,
  },
  {
    name: "chat channel clear-messages endpoint keeps role denial behavior",
    run: runChatChannelClearMessagesRoleDeniedCase,
  },
  {
    name: "chat channel clear-messages endpoint keeps validation/status passthrough parity",
    run: runChatChannelClearMessagesValidationStatusParityCase,
  },
  {
    name: "chat channel clear-messages endpoint keeps legacy error mapping parity",
    run: runChatChannelClearMessagesErrorParityCase,
  },
  {
    name: "chat channel delete endpoint keeps legacy success response shape",
    run: runChatChannelDeleteLegacyRouteSuccessCase,
  },
  {
    name: "chat channel delete endpoint keeps auth denial behavior",
    run: runChatChannelDeleteAuthDeniedCase,
  },
  {
    name: "chat channel delete endpoint keeps role denial behavior",
    run: runChatChannelDeleteRoleDeniedCase,
  },
  {
    name: "chat channel delete endpoint keeps validation/status passthrough parity",
    run: runChatChannelDeleteValidationStatusParityCase,
  },
  {
    name: "chat channel delete endpoint keeps legacy error mapping parity",
    run: runChatChannelDeleteErrorParityCase,
  },
  {
    name: "chat channel remove-user endpoint keeps legacy success response shape",
    run: runChatChannelRemoveUserLegacyRouteSuccessCase,
  },
  {
    name: "chat channel remove-user endpoint keeps auth denial behavior",
    run: runChatChannelRemoveUserAuthDeniedCase,
  },
  {
    name: "chat channel remove-user endpoint keeps role denial behavior",
    run: runChatChannelRemoveUserRoleDeniedCase,
  },
  {
    name: "chat channel remove-user endpoint keeps validation/status passthrough parity",
    run: runChatChannelRemoveUserValidationStatusParityCase,
  },
  {
    name: "chat channel remove-user endpoint keeps legacy error mapping parity",
    run: runChatChannelRemoveUserErrorParityCase,
  },
  {
    name: "chat group remove-member endpoint keeps legacy success response shape",
    run: runChatGroupRemoveMemberLegacyRouteSuccessCase,
  },
  {
    name: "chat group remove-member endpoint keeps auth denial behavior",
    run: runChatGroupRemoveMemberAuthDeniedCase,
  },
  {
    name: "chat group remove-member endpoint keeps role denial behavior",
    run: runChatGroupRemoveMemberRoleDeniedCase,
  },
  {
    name: "chat group remove-member endpoint keeps validation/status passthrough parity",
    run: runChatGroupRemoveMemberValidationStatusParityCase,
  },
  {
    name: "chat group remove-member endpoint keeps legacy error mapping parity",
    run: runChatGroupRemoveMemberErrorParityCase,
  },
  {
    name: "chat group add-members endpoint keeps legacy success response shape",
    run: runChatGroupAddMembersLegacyRouteSuccessCase,
  },
  {
    name: "chat group add-members endpoint keeps auth denial behavior",
    run: runChatGroupAddMembersAuthDeniedCase,
  },
  {
    name: "chat group add-members endpoint keeps role denial behavior",
    run: runChatGroupAddMembersRoleDeniedCase,
  },
  {
    name: "chat group add-members endpoint keeps validation/status passthrough parity",
    run: runChatGroupAddMembersValidationStatusParityCase,
  },
  {
    name: "chat group add-members endpoint keeps legacy error mapping parity",
    run: runChatGroupAddMembersErrorParityCase,
  },
  {
    name: "chat delete-for-me endpoint keeps legacy success response shape",
    run: runChatDeleteForMeLegacyRouteSuccessCase,
  },
  {
    name: "chat delete-for-me endpoint keeps auth denial behavior",
    run: runChatDeleteForMeAuthDeniedCase,
  },
  {
    name: "chat delete-for-me endpoint keeps validation/status passthrough parity",
    run: runChatDeleteForMeValidationStatusParityCase,
  },
  {
    name: "chat delete-for-me endpoint keeps legacy error mapping parity",
    run: runChatDeleteForMeErrorParityCase,
  },
  {
    name: "chat delete-for-everyone endpoint keeps legacy success response shape",
    run: runChatDeleteForEveryoneLegacyRouteSuccessCase,
  },
  {
    name: "chat delete-for-everyone endpoint keeps auth denial behavior",
    run: runChatDeleteForEveryoneAuthDeniedCase,
  },
  {
    name: "chat delete-for-everyone endpoint keeps validation/status passthrough parity",
    run: runChatDeleteForEveryoneValidationStatusParityCase,
  },
  {
    name: "chat delete-for-everyone endpoint keeps legacy error mapping parity",
    run: runChatDeleteForEveryoneErrorParityCase,
  },
  {
    name: "chat delete-message endpoint keeps legacy success response shape",
    run: runChatDeleteMessageLegacyRouteSuccessCase,
  },
  {
    name: "chat delete-message endpoint keeps auth denial behavior",
    run: runChatDeleteMessageAuthDeniedCase,
  },
  {
    name: "chat delete-message endpoint keeps role denial behavior",
    run: runChatDeleteMessageRoleDeniedCase,
  },
  {
    name: "chat delete-message endpoint keeps validation/status passthrough parity",
    run: runChatDeleteMessageValidationStatusParityCase,
  },
  {
    name: "chat delete-message endpoint keeps legacy error mapping parity",
    run: runChatDeleteMessageErrorParityCase,
  },
  {
    name: "chat list endpoint keeps legacy success response shape",
    run: runChatListLegacyRouteSuccessCase,
  },
  {
    name: "chat list endpoint keeps default query parity",
    run: runChatListDefaultQueryParityCase,
  },
  {
    name: "chat list endpoint keeps auth denial behavior",
    run: runChatListAuthDeniedCase,
  },
  {
    name: "chat list endpoint keeps invalid-state parity",
    run: runChatListInvalidStateParityCase,
  },
  {
    name: "chat list endpoint keeps 500 error parity",
    run: runChatListErrorParityCase,
  },
  {
    name: "chat search endpoint keeps legacy success response shape",
    run: runChatSearchLegacyRouteSuccessCase,
  },
  {
    name: "chat search endpoint keeps query validation parity",
    run: runChatSearchQueryValidationParityCase,
  },
  {
    name: "chat search endpoint keeps auth denial behavior",
    run: runChatSearchAuthDeniedCase,
  },
  {
    name: "chat search endpoint keeps Realtime error status parity",
    run: runChatSearchRealtimeErrorParityCase,
  },
  {
    name: "chat search endpoint keeps 500 error parity",
    run: runChatSearchErrorParityCase,
  },
  {
    name: "chat message search endpoint keeps legacy success response shape",
    run: runChatMessageSearchLegacyRouteSuccessCase,
  },
  {
    name: "chat message search endpoint keeps query validation parity",
    run: runChatMessageSearchQueryValidationParityCase,
  },
  {
    name: "chat message search endpoint keeps auth denial behavior",
    run: runChatMessageSearchAuthDeniedCase,
  },
  {
    name: "chat message search endpoint keeps Realtime error status parity",
    run: runChatMessageSearchRealtimeErrorParityCase,
  },
  {
    name: "chat message search endpoint keeps 500 error parity",
    run: runChatMessageSearchErrorParityCase,
  },
  {
    name: "chat message history endpoint keeps legacy success response shape",
    run: runChatMessageHistoryLegacyRouteSuccessCase,
  },
  {
    name: "chat message history endpoint keeps default query parity",
    run: runChatMessageHistoryDefaultQueryParityCase,
  },
  {
    name: "chat message history endpoint keeps auth denial behavior",
    run: runChatMessageHistoryAuthDeniedCase,
  },
  {
    name: "chat message history endpoint keeps invalid-id parity",
    run: runChatMessageHistoryInvalidIdParityCase,
  },
  {
    name: "chat message history endpoint keeps not-found parity",
    run: runChatMessageHistoryNotFoundParityCase,
  },
  {
    name: "chat message history endpoint keeps 500 error parity",
    run: runChatMessageHistoryErrorParityCase,
  },
  {
    name: "chat info endpoint keeps legacy success response shape",
    run: runChatInfoLegacyRouteSuccessCase,
  },
  {
    name: "chat info endpoint keeps default query parity",
    run: runChatInfoDefaultQueryParityCase,
  },
  {
    name: "chat info endpoint keeps auth denial behavior",
    run: runChatInfoAuthDeniedCase,
  },
  {
    name: "chat info endpoint keeps invalid-id parity",
    run: runChatInfoInvalidIdParityCase,
  },
  {
    name: "chat info endpoint keeps not-found parity",
    run: runChatInfoNotFoundParityCase,
  },
  {
    name: "chat info endpoint keeps 500 error parity",
    run: runChatInfoErrorParityCase,
  },
  {
    name: "chat channel audit-log endpoint keeps legacy success response shape",
    run: runChatChannelAuditLogLegacyRouteSuccessCase,
  },
  {
    name: "chat channel audit-log endpoint keeps default query parity",
    run: runChatChannelAuditLogDefaultQueryParityCase,
  },
  {
    name: "chat channel audit-log endpoint keeps auth denial behavior",
    run: runChatChannelAuditLogAuthDeniedCase,
  },
  {
    name: "chat channel audit-log endpoint keeps not-found parity",
    run: runChatChannelAuditLogNotFoundParityCase,
  },
  {
    name: "chat channel audit-log endpoint keeps error parity",
    run: runChatChannelAuditLogErrorParityCase,
  },
  {
    name: "documents my-documents endpoint keeps route-family compatibility",
    run: runDocumentsMyDocumentsRouteFamilyCompatibilityCase,
  },
  {
    name: "documents my-documents endpoint keeps trainer-not-found parity",
    run: runDocumentsMyDocumentsNotFoundCase,
  },
  {
    name: "documents trainer/:trainerId endpoint keeps route-family compatibility",
    run: runDocumentsTrainerRouteFamilyCompatibilityCase,
  },
  {
    name: "documents trainer/:trainerId endpoint keeps invalid-id parity",
    run: runDocumentsTrainerInvalidIdCase,
  },
  {
    name: "documents trainer/:trainerId endpoint keeps error parity",
    run: runDocumentsTrainerErrorParityCase,
  },
  {
    name: "documents verify endpoint keeps route-family compatibility",
    run: runDocumentsVerifyRouteFamilyCompatibilityCase,
  },
  {
    name: "documents verify endpoint keeps invalid-id parity",
    run: runDocumentsVerifyInvalidIdParityCase,
  },
  {
    name: "documents verify endpoint keeps not-found parity",
    run: runDocumentsVerifyNotFoundParityCase,
  },
  {
    name: "documents verify endpoint keeps invalid-status parity",
    run: runDocumentsVerifyInvalidStatusParityCase,
  },
  {
    name: "documents verify endpoint keeps error parity",
    run: runDocumentsVerifyErrorParityCase,
  },
  {
    name: "documents trainer status endpoint keeps route-family compatibility",
    run: runDocumentsTrainerStatusRouteFamilyCompatibilityCase,
  },
  {
    name: "documents trainer status endpoint keeps invalid-trainer-id parity",
    run: runDocumentsTrainerStatusInvalidTrainerIdCase,
  },
  {
    name: "documents trainer status endpoint keeps invalid-status parity",
    run: runDocumentsTrainerStatusInvalidStatusCase,
  },
  {
    name: "documents trainer status endpoint keeps review-gate parity",
    run: runDocumentsTrainerStatusReviewGateParityCase,
  },
  {
    name: "documents trainer status endpoint keeps not-found parity",
    run: runDocumentsTrainerStatusNotFoundParityCase,
  },
  {
    name: "documents trainer status endpoint keeps error parity",
    run: runDocumentsTrainerStatusErrorParityCase,
  },
  {
    name: "documents move-to-review endpoint keeps route-family compatibility",
    run: runDocumentsMoveToReviewRouteFamilyCompatibilityCase,
  },
  {
    name: "documents move-to-review endpoint keeps invalid-trainer-id parity",
    run: runDocumentsMoveToReviewInvalidTrainerIdCase,
  },
  {
    name: "documents move-to-review endpoint keeps not-found parity",
    run: runDocumentsMoveToReviewNotFoundParityCase,
  },
  {
    name: "documents move-to-review endpoint keeps missing-docs invalid-state parity",
    run: runDocumentsMoveToReviewMissingDocsInvalidStateCase,
  },
  {
    name: "documents move-to-review endpoint keeps rejected-docs invalid-state parity",
    run: runDocumentsMoveToReviewRejectedDocsInvalidStateCase,
  },
  {
    name: "documents move-to-review endpoint keeps review-gate parity",
    run: runDocumentsMoveToReviewReviewGateParityCase,
  },
  {
    name: "documents move-to-review endpoint keeps error parity",
    run: runDocumentsMoveToReviewErrorParityCase,
  },
  {
    name: "documents submit-verification endpoint keeps route-family compatibility",
    run: runDocumentsSubmitVerificationRouteFamilyCompatibilityCase,
  },
  {
    name: "documents submit-verification endpoint keeps trainer-not-found parity",
    run: runDocumentsSubmitVerificationNotFoundParityCase,
  },
  {
    name: "documents submit-verification endpoint keeps missing-documents parity",
    run: runDocumentsSubmitVerificationMissingDocsParityCase,
  },
  {
    name: "documents submit-verification endpoint keeps review-gate parity",
    run: runDocumentsSubmitVerificationReviewGateParityCase,
  },
  {
    name: "documents submit-verification endpoint keeps error parity",
    run: runDocumentsSubmitVerificationErrorParityCase,
  },
  {
    name: "documents upload endpoint keeps route-family compatibility",
    run: runDocumentsUploadRouteFamilyCompatibilityCase,
  },
  {
    name: "documents upload endpoint keeps upload-middleware field mapping parity",
    run: runDocumentsUploadMiddlewareFieldMappingParityCase,
  },
  {
    name: "documents upload endpoint keeps missing-file parity",
    run: runDocumentsUploadMissingFileParityCase,
  },
  {
    name: "documents upload endpoint keeps drive-setup error parity",
    run: runDocumentsUploadDriveSetupErrorParityCase,
  },
  {
    name: "documents upload endpoint keeps error parity",
    run: runDocumentsUploadErrorParityCase,
  },
  {
    name: "documents trainer approach endpoint keeps route-family compatibility",
    run: runDocumentsTrainerApproachRouteFamilyCompatibilityCase,
  },
  {
    name: "documents trainer approach endpoint keeps invalid-trainer-id parity",
    run: runDocumentsTrainerApproachInvalidTrainerIdCase,
  },
  {
    name: "documents trainer approach endpoint keeps access-denied parity",
    run: runDocumentsTrainerApproachAccessDeniedCase,
  },
  {
    name: "documents trainer approach endpoint keeps no-outstanding-documents parity",
    run: runDocumentsTrainerApproachNoOutstandingDocumentsCase,
  },
  {
    name: "documents trainer approach endpoint keeps not-found parity",
    run: runDocumentsTrainerApproachNotFoundParityCase,
  },
  {
    name: "documents trainer approach endpoint keeps error parity",
    run: runDocumentsTrainerApproachErrorParityCase,
  },
  {
    name: "drive sync endpoint dry-run returns analysis without mutations",
    run: runDriveSyncDryRunNoMutationCase,
  },
  {
    name: "drive sync endpoint normal mode keeps mutation + summary parity",
    run: runDriveSyncNormalMutationParityCase,
  },
  {
    name: "drive sync endpoint dry-run reports mixed-folder candidate contribution",
    run: runDriveSyncDryRunMixedCandidateSummaryCase,
  },
  {
    name: "drive sync endpoint dry-run reports ambiguous skips",
    run: runDriveSyncDryRunAmbiguousSkipCase,
  },
  {
    name: "drive sync endpoint normalize-duplicates mode reports dry-run and mutation cleanup counters",
    run: runDriveSyncNormalizeDuplicatesCase,
  },
  {
    name: "drive sync endpoint canonical-mappings-only mode persists deterministic mappings without reconciliation scan",
    run: runDriveSyncCanonicalMappingsOnlyModeCase,
  },
  {
    name: "drive sync endpoint canonical mapping apply is idempotent across repeated normalize runs",
    run: runDriveSyncNormalizeDuplicatesIdempotentCase,
  },
  {
    name: "drive sync endpoint canonical-mappings-only dry-run remains idempotent and non-mutating",
    run: runDriveSyncCanonicalOnlyDryRunIdempotentCase,
  },
  {
    name: "attendance admin-upload path persists attendance files to canonical attendance folder when duplicates exist",
    run: runAttendanceAdminUploadCanonicalAttendanceFolderPrecedenceCase,
  },
  {
    name: "attendance admin-upload path persists checkout geo files to canonical geotag folder when duplicates exist",
    run: runAttendanceAdminUploadCanonicalGeoFolderPrecedenceCase,
  },
  {
    name: "attendance upload-image path persists trainer geo slot files to canonical geotag folder when duplicates exist",
    run: runAttendanceTrainerGeoSlotUploadCanonicalGeoFolderPrecedenceCase,
  },
  {
    name: "internal metrics snapshot endpoint stays hidden when debug flag is disabled",
    run: runInternalMetricsSnapshotDisabledCase,
  },
  {
    name: "internal metrics aggregate endpoint denies unauthenticated access when enabled",
    run: runInternalMetricsAllQueuesAuthDeniedCase,
  },
  {
    name: "internal metrics aggregate endpoint denies non-SuperAdmin role when enabled",
    run: runInternalMetricsAllQueuesRoleDeniedCase,
  },
  {
    name: "internal metrics aggregate endpoint returns consolidated queue snapshots when enabled",
    run: runInternalMetricsAllQueuesEnabledCase,
  },
  {
    name: "internal metrics snapshot endpoint returns queue counters when enabled",
    run: runInternalMetricsSnapshotEnabledCase,
  },
  {
    name: "attendance verify-document endpoint keeps success and helper parity",
    run: runVerifyAttendanceDocumentLegacyRouteSuccessCase,
  },
  {
    name: "attendance verify-document endpoint keeps invalid-payload parity",
    run: runVerifyAttendanceDocumentInvalidPayloadParityCase,
  },
  {
    name: "attendance verify-document endpoint keeps error parity",
    run: runVerifyAttendanceDocumentErrorParityCase,
  },
  {
    name: "attendance reject-document endpoint keeps success and helper parity",
    run: runRejectAttendanceDocumentLegacyRouteSuccessCase,
  },
  {
    name: "attendance reject-document endpoint keeps invalid-payload parity",
    run: runRejectAttendanceDocumentInvalidPayloadParityCase,
  },
  {
    name: "attendance reject-document endpoint keeps error parity",
    run: runRejectAttendanceDocumentErrorParityCase,
  },
  {
    name: "attendance verify-geo endpoint keeps manual-approval completion + lifecycle sync parity",
    run: runVerifyGeoTagLegacyRouteSuccessCase,
  },
  {
    name: "attendance reject-geo endpoint keeps manual-rejection pending + lifecycle sync parity",
    run: runRejectGeoTagLegacyRouteSuccessCase,
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
  console.error(`\n${failedCount} API test(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} API tests passed.`);
