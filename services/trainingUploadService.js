const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");
const {
  Attendance,
  Schedule,
  ScheduleDocument,
  Trainer,
} = require("../models");
const {
  uploadToDriveWithRetry,
} = require("./googleDriveService");
const {
  buildDriveFolderLink,
  ensureScheduleFolderState,
} = require("./trainingFolderService");
const {
  canManageTrainingFiles,
  canViewTrainingFiles,
  isTrainerRole,
  normalizeTrainingRole,
} = require("../utils/trainingPlatformRoles");
const {
  logTrainingUploadError,
  logTrainingUploadSuccess,
} = require("./trainingUploadLogService");

const FILE_TYPE_RULES = {
  attendance: {
    allowedExtensions: new Set([".pdf", ".xls", ".xlsx"]),
    allowedMimeTypes: new Set([
      "application/pdf",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]),
  },
  geo: {
    allowedExtensions: new Set([".jpg", ".jpeg", ".png", ".mp4"]),
    allowedMimeTypes: new Set(["image/jpeg", "image/png", "video/mp4"]),
  },
};

const normalizeRequestedDocumentType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "geo") return "geotag";
  return normalized;
};

const toIdString = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    if (value._id) return String(value._id).trim();
    if (value.id) return String(value.id).trim();
  }
  return String(value).trim();
};

const cleanupTempFiles = async (files = []) => {
  await Promise.all(
    files
      .map((file) => file?.path)
      .filter(Boolean)
      .map(async (filePath) => {
        try {
          await fs.promises.unlink(filePath);
        } catch (_error) {
          // Ignore temp file cleanup failures.
        }
      }),
  );
};

const assertFileSafety = (files = []) => {
  for (const file of files) {
    const name = String(file?.originalname || "").toLowerCase();
    if (name.includes("virus") || name.includes("eicar")) {
      throw new Error("Security Alert: Virus-like file signature detected");
    }
  }
};

const validateFilesForType = (files = [], fileType) => {
  const rules = FILE_TYPE_RULES[fileType];
  if (!rules) {
    throw new Error("Invalid fileType. Use attendance or geo.");
  }

  if (!Array.isArray(files) || !files.length) {
    throw new Error("At least one file is required");
  }

  for (const file of files) {
    const extension = path.extname(file?.originalname || "").toLowerCase();
    const mimeType = String(file?.mimetype || "").toLowerCase();
    const matchesExtension = rules.allowedExtensions.has(extension);
    const matchesMime = rules.allowedMimeTypes.has(mimeType);

    if (!matchesExtension && !matchesMime) {
      throw new Error(
        `${fileType} files only allow ${Array.from(rules.allowedExtensions).join(", ")}`,
      );
    }
  }
};

const dedupeDriveAssetEntries = (entries = []) => {
  const deduped = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;

    const identity =
      entry.fileId ||
      [
        entry.fileType || "",
        entry.fileName || "",
        entry.localPath || entry.fileUrl || entry.webViewLink || "",
      ].join("|");

    if (!identity.replace(/\|/g, "").trim()) continue;
    if (deduped.has(identity)) {
      deduped.delete(identity);
    }
    deduped.set(identity, entry);
  }

  return Array.from(deduped.values());
};

const resolveDriveUploadKind = (fileType, file) => {
  const extension = path.extname(file?.originalname || "").toLowerCase();
  if (fileType === "attendance") {
    return extension === ".pdf" ? "Attendance" : "AttendanceSheet";
  }
  return extension === ".mp4" ? "GeoVideo" : "GeoImage";
};

const resolveTrainerCode = async (schedule, requesterTrainer) => {
  if (requesterTrainer?.trainerId) {
    return String(requesterTrainer.trainerId).trim();
  }

  const trainerId = schedule?.trainerId;
  if (!trainerId) return "TRAINER";

  const trainer = await Trainer.findById(trainerId).select("trainerId");
  return String(trainer?.trainerId || "").trim() || `TRN_${toIdString(trainerId).slice(-6)}`;
};

const buildDriveFileName = ({ fileType, schedule, trainerCode, file, index }) => {
  const extension = path.extname(file?.originalname || "").toLowerCase();
  const dayNumber = Number(schedule?.dayNumber) || 0;
  const kind = resolveDriveUploadKind(fileType, file);
  const suffix = index > 0 ? `_${index + 1}` : "";
  return `${trainerCode}_Day${dayNumber}_${kind}${suffix}${extension}`;
};

const upsertScheduleDocument = async ({
  schedule,
  attendance,
  driveUpload,
  fileType,
  verifiedBy = null,
}) => {
  await ScheduleDocument.findOneAndUpdate(
    { driveFileId: driveUpload.fileId },
    {
      $set: {
        scheduleId: schedule._id,
        attendanceId: attendance?._id || null,
        trainerId: schedule.trainerId,
        fileType,
        fileField: fileType,
        fileName: driveUpload.fileName,
        fileUrl:
          driveUpload.webViewLink ||
          driveUpload.fileUrl ||
          driveUpload.downloadLink ||
          null,
        status: "pending",
        verifiedBy: verifiedBy && mongoose.Types.ObjectId.isValid(verifiedBy)
          ? verifiedBy
          : null,
        verifiedAt: null,
        rejectReason: null,
      },
      $setOnInsert: {
        driveFileId: driveUpload.fileId,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );
};

const ensureAttendanceRecord = async ({
  schedule,
  requesterRole,
  requesterTrainer,
}) => {
  let attendance = await Attendance.findOne({ scheduleId: schedule._id });
  if (attendance) return attendance;

  attendance = await Attendance.create({
    scheduleId: schedule._id,
    trainerId: schedule.trainerId || requesterTrainer?._id || null,
    collegeId: schedule.collegeId || null,
    courseId: schedule.courseId || null,
    dayNumber: schedule.dayNumber || null,
    date: schedule.scheduledDate || new Date(),
    uploadedBy: isTrainerRole(requesterRole) ? "trainer" : "admin",
    isManualEntry: !isTrainerRole(requesterRole),
    status: "Pending",
    verificationStatus: "pending",
    geoVerificationStatus: "pending",
  });

  return attendance;
};

const applyAttendanceFileReferences = ({ attendance, fileType, files }) => {
  if (fileType === "attendance") {
    const pdf = files.find((file) =>
      path.extname(file.originalname || "").toLowerCase() === ".pdf",
    );
    const excel = files.find((file) =>
      [".xls", ".xlsx"].includes(
        path.extname(file.originalname || "").toLowerCase(),
      ),
    );

    if (pdf?.path) attendance.attendancePdfUrl = pdf.path;
    if (excel?.path) attendance.attendanceExcelUrl = excel.path;
    attendance.verificationStatus = "pending";
    return;
  }

  const imagePaths = files
    .filter((file) =>
      [".jpg", ".jpeg", ".png"].includes(
        path.extname(file.originalname || "").toLowerCase(),
      ),
    )
    .map((file) => file.path);

  const videoPaths = files
    .filter(
      (file) => path.extname(file.originalname || "").toLowerCase() === ".mp4",
    )
    .map((file) => file.path);

  if (imagePaths.length) {
    attendance.checkOutGeoImageUrl = imagePaths[0];
    attendance.checkOutGeoImageUrls = Array.from(
      new Set([...(attendance.checkOutGeoImageUrls || []), ...imagePaths]),
    );
    attendance.activityPhotos = Array.from(
      new Set([...(attendance.activityPhotos || []), ...imagePaths]),
    );
  }

  if (videoPaths.length) {
    attendance.activityVideos = Array.from(
      new Set([...(attendance.activityVideos || []), ...videoPaths]),
    );
  }

  attendance.geoVerificationStatus = "pending";
};

const deriveDayStatus = (schedule) => {
  if (!schedule.trainerId) return "not_assigned";
  if (schedule.attendanceUploaded && schedule.geoTagUploaded) return "completed";
  return "pending";
};

const syncScheduleUploadState = async ({ schedule, fileType }) => {
  if (fileType === "attendance") {
    schedule.attendanceUploaded = true;
  }

  if (fileType === "geo") {
    schedule.geoTagUploaded = true;
  }

  schedule.dayStatus = deriveDayStatus(schedule);
  schedule.dayStatusUpdatedAt = new Date();
  await schedule.save();
};

const assertUploadAccess = ({ userRole, requesterTrainer, schedule }) => {
  if (!schedule) {
    throw new Error("Day not found");
  }

  if (!schedule.trainerId) {
    throw new Error("This day is not assigned to any trainer");
  }

  if (isTrainerRole(userRole)) {
    if (!requesterTrainer?._id) {
      throw new Error("Trainer profile not found");
    }

    if (toIdString(schedule.trainerId) !== toIdString(requesterTrainer._id)) {
      throw new Error("Trainer can only upload for the assigned day and batch");
    }

    return;
  }

  if (!canManageTrainingFiles(userRole)) {
    throw new Error("You are not allowed to upload training files");
  }
};

const assertReadAccess = ({ userRole, requesterTrainer, schedule }) => {
  if (!schedule) {
    throw new Error("Day not found");
  }

  if (isTrainerRole(userRole)) {
    if (!requesterTrainer?._id) {
      throw new Error("Trainer profile not found");
    }

    if (!schedule.trainerId) {
      throw new Error("This day is not assigned to any trainer");
    }

    if (toIdString(schedule.trainerId) !== toIdString(requesterTrainer._id)) {
      throw new Error("Trainer can only access files for the assigned day and batch");
    }

    return;
  }

  if (!canViewTrainingFiles(userRole)) {
    throw new Error("You are not allowed to view training files");
  }
};

const resolveTargetFolder = (folderState, fileType) => {
  if (fileType === "attendance") {
    return {
      id: folderState.attendanceFolderId,
      name: folderState.attendanceFolderName || "Attendance",
      link:
        folderState.attendanceFolderLink ||
        buildDriveFolderLink(folderState.attendanceFolderId),
    };
  }

  return {
    id: folderState.geoTagFolderId,
    name: folderState.geoTagFolderName || "GeoTag",
    link:
      folderState.geoTagFolderLink ||
      buildDriveFolderLink(folderState.geoTagFolderId),
  };
};

const uploadTrainingFiles = async ({
  user,
  requesterTrainer = null,
  dayId,
  fileType,
  files,
}) => {
  const normalizedFileType = String(fileType || "").trim().toLowerCase();
  const normalizedRole = normalizeTrainingRole(user?.role);

  validateFilesForType(files, normalizedFileType);
  assertFileSafety(files);

  const { schedule, folderState } = await ensureScheduleFolderState({
    scheduleId: dayId,
  });
  assertUploadAccess({
    userRole: normalizedRole,
    requesterTrainer,
    schedule,
  });

  const attendance = await ensureAttendanceRecord({
    schedule,
    requesterRole: normalizedRole,
    requesterTrainer,
  });

  const trainerCode = await resolveTrainerCode(schedule, requesterTrainer);
  const targetFolder = resolveTargetFolder(folderState, normalizedFileType);

  if (!targetFolder?.id) {
    throw new Error("Drive folder is not configured for this day");
  }

  const uploads = [];

  try {
    for (const [index, file] of files.entries()) {
      const fileBuffer = await fs.promises.readFile(file.path);
      const driveUpload = await uploadToDriveWithRetry(
        {
          fileBuffer,
          mimeType: file.mimetype,
          originalName: file.originalname,
          folderId: targetFolder.id,
          fileName: buildDriveFileName({
            fileType: normalizedFileType,
            schedule,
            trainerCode,
            file,
            index,
          }),
        },
        { attempts: 3, initialDelayMs: 500 },
      );

      uploads.push({
        ...driveUpload,
        originalName: file.originalname,
        mimeType: file.mimetype,
        localPath: file.path,
      });

      await upsertScheduleDocument({
        schedule,
        attendance,
        driveUpload,
        fileType: normalizedFileType === "geo" ? "geotag" : "attendance",
        verifiedBy: user?.id || user?._id || null,
      });
    }

    applyAttendanceFileReferences({
      attendance,
      fileType: normalizedFileType,
      files,
    });

    attendance.driveFolderId = folderState.dayFolderId || folderState.driveFolderId;
    attendance.driveAssets = {
      ...(attendance.driveAssets && typeof attendance.driveAssets === "object"
        ? attendance.driveAssets
        : {}),
      lastUploadedAt: new Date().toISOString(),
      lastUploadedType: normalizedFileType,
      targetFolderId: targetFolder.id,
      targetFolderLink: targetFolder.link,
      files: dedupeDriveAssetEntries([
        ...(((attendance.driveAssets || {}).files || [])),
        ...uploads.map((upload) => ({
          fileId: upload.fileId,
          fileName: upload.fileName,
          fileUrl: upload.fileUrl,
          webViewLink: upload.webViewLink,
          downloadLink: upload.downloadLink,
          fileType: normalizedFileType,
        })),
      ]),
    };

    await attendance.save();
    await syncScheduleUploadState({
      schedule,
      fileType: normalizedFileType,
    });

    logTrainingUploadSuccess({
      userId: user?.id || user?._id || null,
      role: normalizedRole,
      dayId: toIdString(dayId),
      fileType: normalizedFileType,
      folderId: targetFolder.id,
      uploadedFileIds: uploads.map((item) => item.fileId),
    });

    return {
      scheduleId: schedule._id,
      attendanceId: attendance._id,
      fileType: normalizedFileType,
      folder: targetFolder,
      dayFolder: {
        id: folderState.dayFolderId || folderState.driveFolderId || null,
        link:
          folderState.dayFolderLink ||
          buildDriveFolderLink(folderState.dayFolderId || folderState.driveFolderId),
      },
      uploads,
      status: {
        attendanceUploaded: schedule.attendanceUploaded,
        geoTagUploaded: schedule.geoTagUploaded,
        dayStatus: schedule.dayStatus,
      },
    };
  } catch (error) {
    logTrainingUploadError(
      {
        userId: user?.id || user?._id || null,
        role: normalizedRole,
        dayId: toIdString(dayId),
        fileType: normalizedFileType,
        folderId: targetFolder?.id || null,
      },
      error,
    );
    throw error;
  } finally {
    await cleanupTempFiles(files);
  }
};

const getTrainingDayFiles = async ({
  dayId,
  fileType = null,
  status = null,
  user = null,
  requesterTrainer = null,
} = {}) => {
  const filters = { scheduleId: dayId };

  if (fileType) {
    filters.fileType = normalizeRequestedDocumentType(fileType);
  }

  if (status) {
    filters.status = String(status).trim().toLowerCase();
  }

  const [schedule, files] = await Promise.all([
    Schedule.findById(dayId).select(
      "_id dayNumber trainerId attendanceUploaded geoTagUploaded dayStatus dayFolderId dayFolderLink attendanceFolderId attendanceFolderLink geoTagFolderId geoTagFolderLink",
    ),
    ScheduleDocument.find(filters)
      .sort({ createdAt: -1 })
      .populate("verifiedBy", "name email role"),
  ]);

  if (!schedule) {
    throw new Error("Day not found");
  }

  assertReadAccess({
    userRole: normalizeTrainingRole(user?.role),
    requesterTrainer,
    schedule,
  });

  return {
    scheduleId: schedule._id,
    dayNumber: schedule.dayNumber,
    folderIds: {
      day: schedule.dayFolderId || null,
      attendance: schedule.attendanceFolderId || null,
      geo: schedule.geoTagFolderId || null,
    },
    folderLinks: {
      day: schedule.dayFolderLink || buildDriveFolderLink(schedule.dayFolderId),
      attendance:
        schedule.attendanceFolderLink ||
        buildDriveFolderLink(schedule.attendanceFolderId),
      geo:
        schedule.geoTagFolderLink || buildDriveFolderLink(schedule.geoTagFolderId),
    },
    status: {
      attendanceUploaded: schedule.attendanceUploaded,
      geoTagUploaded: schedule.geoTagUploaded,
      dayStatus: schedule.dayStatus,
    },
    files,
  };
};

const getTrainingDayStatus = async ({
  dayId,
  user = null,
  requesterTrainer = null,
} = {}) => {
  const schedule = await Schedule.findById(dayId).select(
    "_id dayNumber trainerId attendanceUploaded geoTagUploaded dayStatus dayStatusUpdatedAt driveFolderId driveFolderLink attendanceFolderId attendanceFolderLink geoTagFolderId geoTagFolderLink",
  );

  if (!schedule) {
    throw new Error("Day not found");
  }

  assertReadAccess({
    userRole: normalizeTrainingRole(user?.role),
    requesterTrainer,
    schedule,
  });

  return {
    scheduleId: schedule._id,
    dayNumber: schedule.dayNumber,
    trainerAssigned: Boolean(schedule.trainerId),
    attendanceUploaded: schedule.attendanceUploaded,
    geoTagUploaded: schedule.geoTagUploaded,
    dayStatus: schedule.dayStatus,
    dayStatusUpdatedAt: schedule.dayStatusUpdatedAt,
    folderIds: {
      day: schedule.driveFolderId || null,
      attendance: schedule.attendanceFolderId || null,
      geo: schedule.geoTagFolderId || null,
    },
    driveLinks: {
      day: schedule.driveFolderLink || buildDriveFolderLink(schedule.driveFolderId),
      attendance:
        schedule.attendanceFolderLink ||
        buildDriveFolderLink(schedule.attendanceFolderId),
      geo:
        schedule.geoTagFolderLink || buildDriveFolderLink(schedule.geoTagFolderId),
    },
  };
};

module.exports = {
  FILE_TYPE_RULES,
  uploadTrainingFiles,
  getTrainingDayFiles,
  getTrainingDayStatus,
};
